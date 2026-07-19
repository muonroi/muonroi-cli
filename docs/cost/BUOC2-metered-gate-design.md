# Bước 2 — The Metered Gate: one instrumented choke-point for every LLM call

> Status: **DESIGN (pre-implementation)** — for review, then Fable-5 adversarial red-team.
> Depends on Bước 1 (shipped): C3 same-turn re-serve meter + `compaction` usage source
> (commits `6b5d787e`, `4dd82f26`). Root-cause analysis: `[[cost-leak-root-measurement]]`.

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

> **Placement decision:** wrap `resolved.model.doStream` and `resolved.model.doGenerate`
> **inside `resolveModelRuntime`**. One wrap → universal, unbypassable coverage. A new call
> site cannot avoid the gate because it cannot get a model without the factory.

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
| `estInputTokens` | conservative estimate (`chars/4`, calibrated post-call against real `usage`) |
| `bySegment` | tokens attributed to `system` / `history` / `tool_results` / `files` |
| `redundantTokens` | tokens whose content-hash was already sent earlier **this turn** (the real leak — invisible today) |
| `ceiling`, `ceilingHit` | the resolved per-call ceiling and whether it was exceeded |

Sink: a new `call_accounting` interaction-log row per call (reuses the Bước-1 pattern:
`logInteraction(sessionId, "call_accounting", { data })`). `usage forensics` gains a
per-stage + redundancy breakdown of the previously-opaque `message` blob.

### 3.2 ENFORCE (bound — flag-gated rollout)
- **Per-call ceiling.** `estInputTokens > ceiling(stage, tier)` → **FAIL LOUD**: throw a typed
  `InputCeilingExceededError { stage, est, ceiling, topSegments }`. The orchestrator catches
  it, does **one** compact-and-retry, then hard-stops with an attributed message — never a
  silent 400k re-bill. Ceiling is **data-driven** (resolved from tier/catalog, per the Zero
  Hardcode rule), never a string literal.
- **Content-identity dedup at the gate.** A tool-result/file block whose content-hash was
  already sent unchanged this turn is replaced with a stub reference — the C3 policy, but
  enforced centrally and **metered** (feeds `redundantTokens`). This *subsumes* C3's
  same-turn re-serve so the trade-off is one decision in one place, not scattered.

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

1. **Gate skeleton, meter-only** (no enforce). Ship; observe `call_accounting` on real
   sessions. *Zero behavior change, pure visibility.*
2. **Ceiling enforce** behind `MUONROI_GATE_CEILING` — default `warn` (log only), then
   `truncate`, then `throw`. Calibrate ceilings from observed `call_accounting`.
3. **Migrate C3** into the gate's content-dedup (its `sameTurnReservedChars` meter, already
   shipped, proves parity before/after).
4. **Migrate `read-path-budget` + `cap-tool-result`** — their limits become gate inputs.
5. Remaining caps as they prove redundant.

Each step is independently shippable and reversible via its flag.

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

- **D1 — Ceiling policy rollout:** ship `warn` (log only) → after ~1 week of
  `call_accounting`, flip to `truncate` → `throw` **only for `subagent`** (where a runaway is
  most costly). Flag: `MUONROI_GATE_CEILING=warn|truncate|throw`.
- **D2 — `call_accounting` sink:** `interaction_logs` first (cheap, 14-day retention);
  promote to a dedicated table only if per-segment queries get heavy.
- **D3 — Token estimate:** calibrated `chars/4` (this is a *ceiling*, not billing; billing
  already uses real post-call `usage`). No tokenizer dependency.
