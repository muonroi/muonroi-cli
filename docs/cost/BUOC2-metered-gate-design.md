# Bước 2 — The Metered Gate: one instrumented choke-point for every LLM call

> Status: **DESIGN v2 (post-red-team)** — Fable-5 adversarial pass complete (branch
> `develop`, verified against working tree). Verdict: **right choke-point, wrong scope,
> one false universality claim.** Design revised below: gate = **meter + ceiling only**
> (dedup-at-gate CUT — see §3.2 / H3); close the two live bypasses (H1 vision override,
> H2 vision-backend raw fetch) in the same PR.
> Depends on Bước 1 (shipped): C3 same-turn re-serve meter + `compaction` usage source
> (commits `6b5d787e`, `4dd82f26`). Root-cause analysis: `[[cost-leak-root-measurement]]`.

## 0. Red-team outcome (Fable-5, verified) — what changed in v2

The design's core placement (`wrapModelWithGate` inside `resolveModelRuntime`) survives —
`options.prompt` is provably the **final** post-`prepareStep`/post-compaction input, and all
27 live AI-SDK `model:` args resolve through the factory. But three things were WRONG and are
now fixed in this doc:

1. **"Universal" was false.** Two LIVE paid bypasses exist today, plus one Phase-1 path:
   - **H1** — vision sub-agents override the wrapped model: `stream-runner.ts:397-404`
     spreads the resolved runtime then replaces `model` with a fresh **unwrapped**
     `factoryForModel(...)` build. The only `factoryForModel` caller outside `runtime.ts`.
   - **H2** — `vision-backend.ts:207-224` hand-rolls `fetch(baseURL+"/chat/completions")`
     with a real key, `max_tokens:3072`, and **discards provider `usage`**. Invisible to
     billing AND the gate. Live via `vision-proxy.ts:193`, `mcp-vision-bridge.ts:391,506`.
   - **H11** — dead `createAdapter` layer (0 callers) + batch Phase-1 builder never touch
     `runtime.model`. Must be deleted / routed before they go live.
   → **Both H1 and H2 close in the gate PR**, else the invariant is a lie on day one.
2. **Dedup-at-gate is semantically wrong (H3+H5) → CUT from the gate.** At `doStream` the
   prompt already contains all prior steps by SDK design (history resend ≠ redundancy → the
   meter drowns in noise); stubbing a tool_result there **busts the prompt-cache prefix →
   cost goes UP** (opposite of goal); and cross-call hashing corrupts correctness (the
   sprint-runner×4 burst is 4 *different* conversations — `options.prompt` carries no thread
   identity). Dedup stays at **tool-execute time (C3)**, where content is raw and the cache
   prefix stays stable. The actual bug to fix there: non-deterministic cap markers
   (`sub-agent-cap.ts:121` embeds live `state.cumulative`) make sha256 never match → key the
   dedup off **raw pre-cap** content.
3. **Implement as `wrapLanguageModel` middleware returning a NEW object — never mutate**
   (H6). The shared `globalThis.__muonroiMockModel` is returned from every resolve; the
   `index.ts:977` mutate-in-place precedent would stack one wrapper per resolve (32×).

Full hole list + fixes: red-team transcript (H1–H11). The sections below are already revised.

## 1. Problem this fixes (root, not leaf)

Cost leak has been "fixed" 10+ times and keeps returning because the root is **dual**:

- **A — Enforcement gap.** There is no single point that bounds per-call input. Instead
  ~15 independent caps (`cap-tool-result`, `cross-turn-dedup`, `read-path-budget`,
  `scope-ceiling`, sub-agent cap, top-level tool budget, `cache-prefix`, …) each cap ONE
  dimension. They **compose leakily** (any new path — new tool, new sub-session kind, a
  re-read with a different range — slips between them) and **fail silently** (over-budget
  → re-bill, never throw). Evidence (session `5e8daf202c13`): a burst of 8 calls at
  80–90k input, cache only ~30k each, passed through every cap; `sprint-runner.ts` (1752
  lines) was billed 4×.
- **B — Measurement gap.** Cost was not attributable per call/stage/content, so no fix was
  falsifiable — you couldn't tell whether cap #N closed the leak or just moved it.

Bước 1 closed the worst of **B** (re-serve + compaction now visible). Bước 2 closes **A**
and completes **B**: **one instrumented gate that every LLM call passes through, which
both meters and enforces.**

## 2. Why a single gate is even possible

Every LLM call in the codebase — main turn, sub-agent, council, compaction, PIL,
tool-call decision, forced-finalize — resolves its model through **one factory**:
`resolveModelRuntime()` (`src/providers/runtime.ts`), 15 call sites. And every
`streamText({ model, … })` / `generateText` ultimately invokes **`model.doStream(options)`
/ `model.doGenerate(options)`**, where `options.prompt` is the *fully-assembled* input for
THAT call (proof: `src/index.ts:977` already wraps `model.doStream` for test recording).

> **Placement decision (revised v2):** wrap inside `resolveModelRuntime` via the AI SDK's
> **`wrapLanguageModel` middleware returning a NEW model object** (never mutate `doStream` in
> place — H6, the shared mock stacks 32×). Covers every AI-SDK call in the tree — with THREE
> named exceptions that must be closed, not assumed away: the vision-sub-agent override (H1),
> the `vision-backend.ts` raw fetch (H2), and batch Phase-1 (H11). Stage/thread attribution
> needs a carrier: `resolveModelRuntime(modelId, { stage, threadId })` (H8) — the 32 sites
> migrate incrementally; a missing stage logs `"unattributed"` (fail-loud), NOT default
> `"main"` (which would mislabel exactly the sub-agent/council calls that matter). Guard:
> lint/test forbidding `factoryForModel` outside `runtime.ts` and a `prepareStep` that returns
> a different (unwrapped) model.

`prepareStep` (per-step hook on the main-loop `streamText`, `tool-engine.ts:1878`) stays as
the main-loop-specific *pre-step adjuster*; it is NOT the gate (only the main loop has it).

## 3. The gate — what it does on every call

`wrapModelWithGate(model, ctx)` returns a model whose `doStream`/`doGenerate`, **before**
delegating to the original, runs three phases on `options.prompt`:

### 3.1 METER (measure — always on)
Walk `options.prompt` (AI SDK `LanguageModelV2Prompt`: ordered role-tagged parts) and emit a
per-call **composition record**:

| field | meaning |
|---|---|
| `stage` | `main` \| `subagent` \| `council` \| `compaction` \| `pil` \| `title` — from `ctx.stage` stamped at resolve time |
| `estInputTokens` | conservative estimate (`chars/4`). H9: one constant is unsafe both ways — CJK/Vietnamese-diacritic undercount (up to 2×, lets a leak through), long-word English overcount (false throw). Non-text parts (base64/Uint8Array) must be special-cased, NOT chars/4. Mitigation: warn-first + per-`(model,stage)` est/real calibration ratio from `call_accounting` BEFORE any `throw` |
| `bySegment` | tokens attributed to `system` / `history` / `tool_results` / `files` |
| `redundantTokens` | DEFERRED (H3/H10) — meaningless at doStream (history resend dominates) and must never be summed with C3's `sameTurnReservedChars`. Left out of MVP; revisit only with per-thread ctx |
| `ceiling`, `ceilingHit` | the resolved per-call ceiling and whether it was exceeded |

Sink: a new `call_accounting` interaction-log row per call (reuses the Bước-1 pattern:
`logInteraction(sessionId, "call_accounting", { data })`). `usage forensics` gains a
per-stage + redundancy breakdown of the previously-opaque `message` blob.

### 3.2 ENFORCE (bound — flag-gated rollout) — CEILING ONLY
- **Per-call ceiling.** `estInputTokens > ceiling(stage, model)` → **FAIL LOUD**: throw a typed
  `InputCeilingExceededError { stage, est, ceiling, topSegments }`. Recovery (H4): the catch
  must (a) extend `isContextLimitError` with `instanceof InputCeilingExceededError`
  (`error-utils.ts:17` is a message regex today and will NOT match), (b) NOT gate recovery on
  `!assistantText.trim()` for the typed error — a ceiling trips at a LATE step after text has
  streamed, so finalize-then-compact-retry, and (c) **exempt the `compaction` stage from
  `throw`** (the summarizer call IS the recovery mechanism; `capCompactionInput` already
  pre-caps it). Ceiling source (H7): per-call context from catalog `context_window`
  (`ModelInfo.contextWindow`); the **per-stage multiplier is settings/env policy**
  (precedent `getSubAgentBudgetChars()`), NOT catalog data — catalog does not carry per-stage
  ceilings, so this is new policy, declared as such (not a Zero-Hardcode violation, but also
  not "already in the data").
- **NO content-dedup at the gate** (CUT per H3/H5). At `doStream` the prompt already carries
  all prior steps (history resend ≠ redundancy), stubbing busts the cache prefix, and
  cross-call hashing has no thread identity → corrupts correctness. Dedup enforcement stays at
  **tool-execute time (C3)**; the fix there is to key off **raw pre-cap** output so
  non-deterministic cap markers (`sub-agent-cap.ts` live `state.cumulative`) stop defeating
  the hash. The gate MAY *meter* redundancy later — but only per `(threadId × identical
  position within one conversation)`, which requires ctx (H8) and is deferred past MVP.

### 3.3 FAIL-LOUD ACCOUNTING
Every truncation / dedup / ceiling-hit writes its reason + attribution to `call_accounting`.
**Leak #11 becomes impossible**: an over-budget call either throws or is logged with a stage
and a segment breakdown — it can no longer silently inflate the bill.

## 4. The invariant (the thing that stops recurrence)

> No `doStream`/`doGenerate` call proceeds without (a) its input composition metered and
> attributed to a stage, and (b) `estInputTokens ≤ ceiling(stage)` — else it throws.
> No content is re-sent within a turn without being logged as redundant.

Because the invariant is enforced at the **one** point all input converges, a new feature
cannot bypass it, and a regression surfaces as a thrown error or a visible `redundantTokens`
spike — not a quiet cost creep.

## 5. Point-caps become consumers (incremental migration)

The ~15 caps stop being independent output-wrappers and fold into the gate one at a time,
each migration **verified against the meter** (falsifiable — the whole point of Bước 1):

0. **Close the bypasses FIRST (same PR as the skeleton).** H1: remove the vision `model:`
   override (make `strategy.resolve` variant-aware) + lint-ban `factoryForModel` outside
   `runtime.ts`. H2: route `vision-backend.ts` through a resolved runtime OR call the meter +
   record `usage` inside `callVisionModelAt`. Without this the "universal" invariant is false
   on day one.
1. **Gate skeleton, meter-only** (`stage` + `estInputTokens` + `bySegment`; NO redundancy, NO
   enforce). Ship; observe `call_accounting` on real sessions. *Zero behavior change.*
2. **Ceiling enforce** behind `MUONROI_GATE_CEILING` — `warn` (log) → `truncate` → `throw`,
   and **only after** per-`(model,stage)` est/real calibration lands (H9). `compaction` stage
   never `throw`s. Wire the typed-error recovery (H4) before flipping past `warn`.
3. **Fix C3 dedup key → raw pre-cap content** (H5) so cap markers stop defeating the hash.
   This stays at tool-execute time; it is NOT migrated into the gate (H3).
4. **Migrate `read-path-budget` + `cap-tool-result`** ceilings to feed the gate's ceiling
   inputs (their truncation still happens at tool-execute; the gate is the backstop).
5. Delete dead `createAdapter` layer (H11); batch Phase-1 builder must call the gate.
6. Remaining caps as they prove redundant against the meter.

Each step is independently shippable and reversible via its flag.

### Rollout status (shipped)

| Step | Status | Commits |
|---|---|---|
| 0 — close bypasses | **DONE** — H1 (vision override) + H2 (vision-backend usage) | `af58df67`, `ca984cea` |
| 1 — gate skeleton, meter-only | **DONE** — `call_accounting` on main/subagent/vision/council | `af58df67` |
| 2 — ceiling enforce | **DONE + ARMED** — default `warn` for stats; `subagent`/`vision` default `throw` at a calibrated absolute cap (`MUONROI_GATE_THROW_MAX_TOKENS`=100k est ≈ ~200k real, 25× normal capped work) with H4 recovery | `e2ef45ee`, `4afa2bab`, `533245e7` |
| 3 — C3 dedup key → raw pre-cap (H5) | **DONE** — Symbol side-channel | `d1769434` |
| H11 — dead `createAdapter` | **GUARDED** (deprecation note); full subsystem deletion deferred to a separate cleanup PR (multi-file, LOW severity, non-live) | this doc |
| 4/5 — migrate read-path-budget/cap-tool-result | deferred (meter proves redundancy first) | — |

**Deferred (documented, low-value/non-live):**
- `throw` mode flip — needs ~1 week of `call_accounting` + per-`(model,stage)`
  est/real calibration before arming (D9). Machinery + H4 recovery are in place.
- compaction/pil stage `sessionId` threading — compaction cost is ALREADY visible
  via the Bước-1 `compaction` usage source; pil bills as `council` today. Both are
  meter-visibility niceties, not leaks; threading is multi-hop signature churn.
- adapter-subsystem deletion (H11) — dead in prod (tests only); guarded against
  becoming a live bypass via the barrel deprecation note.

## 6. Risks / red-team targets (hand to Fable 5)

1. **Bypass paths.** Does *every* LLM call truly go through `resolveModelRuntime`? Audit the
   provider adapters (`src/providers/openai.ts:50`, `ollama.ts`, `openai-compatible.ts`) —
   they call `streamText({ model: provider(config.model) })` with a *separately-built* model.
   Are they live or legacy? If live, they bypass the gate → must also route through it.
2. **Token-estimate error.** `chars/4` can under/over-count (code, CJK, tool JSON) → false
   ceiling trips or misses. Mitigation: conservative ceiling + post-call calibration against
   real `usage`; never throw on estimate alone without a margin.
3. **Mid-turn throw safety.** `InputCeilingExceededError` must be caught and surfaced
   gracefully (compact-retry-once → hard-stop), never crash the TUI or a detached
   `dispatchSlash` loop. Interaction with the abort/cancel path.
4. **Double-dedup.** Gate content-dedup vs C3 during migration window — must not stub twice
   or corrupt the C3 meter. Ordering with `cap-tool-result` (which mutates output first).
5. **Streaming semantics.** `doStream` returns a stream; the gate inspects `options.prompt`
   (input) pre-call, so it does not touch the output stream — confirm no added latency /
   backpressure, and that `options.prompt` is the final post-`prepareStep` prompt.
6. **Ceiling source.** Where do per-stage ceilings live (catalog/tier)? Must be data-driven;
   a hardcoded number is a Zero-Hardcode violation and a future mis-tune.
7. **Sub-agent attribution.** Sub-agents resolve their own runtime — confirm `ctx.stage` is
   stamped as `subagent` and not mislabeled `main`, else the meter lies.

## 7. What we deliberately do NOT do

- No new cap #11. The gate *replaces* the leaky composition, it does not add another layer.
- No blind PIL/council cut — Bước-1 measurement must show a stage is wasteful *first*
  (council of `5e8daf202c13` was explicit: don't cut before the baseline is falsifiable).
- No silent truncation anywhere — every drop is logged with attribution.

## 8. Locked decisions (approved)

- **D1 — Ceiling policy rollout:** `MUONROI_GATE_CEILING` now **defaults to `warn`**
  (log-only, always-on stats — a warn changes nothing about the call, so it is safe to
  leave on by default and avoids "forgot to enable it"). After ~1 week of `call_accounting`
  + calibration, flip to `throw` **only for `subagent`/`vision`** (where a runaway is most
  costly); `main` stays advisory, `compaction`/`pil` never throw. `off` fully silences the
  ceiling path. Per-call ceiling = catalog `contextWindow` × `MUONROI_GATE_CEILING_RATIO`
  (0<r≤1, default 1.0) — the stage-budget knob (H7) calibration tunes before arming `throw`.
  Live-verified: with `RATIO=0.1`, `/council` produced 5 `ceilingHit`+`warn` rows, each
  driven by tool_results (77k–99k chars), system negligible — the ceiling flags the right
  segment.
- **D2 — `call_accounting` sink:** `interaction_logs` first (cheap, 14-day retention);
  promote to a dedicated table only if per-segment queries get heavy.
- **D3 — Token estimate:** calibrated `chars/4` (this is a *ceiling*, not billing; billing
  already uses real post-call `usage`). No tokenizer dependency.

### Post-red-team amendments (v2)
- **D4 — Dedup stays at C3, NOT the gate** (H3/H5). Gate MVP = meter + ceiling only. The gate
  does not stub content; C3's dedup key moves to raw pre-cap output.
- **D5 — Bypasses close in the gate PR** (H1 vision override, H2 vision-backend raw fetch).
  Delete dead `createAdapter` (H11). Batch Phase-1 must call the gate before going live.
- **D6 — Middleware, new object** (H6): `wrapLanguageModel`, never mutate `doStream`.
- **D7 — ctx carrier** (H8): `resolveModelRuntime(modelId, { stage, threadId })`; missing
  stage = `"unattributed"` fail-loud, never default `"main"`.
- **D8 — Recovery wiring** (H4): `isContextLimitError += instanceof`; relax the
  `!assistantText.trim()` gate for the typed error; exempt `compaction`.
- **D9 — Calibration before throw** (H9): per-`(model,stage)` est/real ratio must exist before
  any `throw`; special-case non-text (base64) parts in the walk.
