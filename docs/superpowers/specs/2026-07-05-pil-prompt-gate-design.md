# PIL Prompt Gate — Agent-Based Enrichment + Quality Gate Design

**Date:** 2026-07-05
**Status:** Approved (brainstorm), reworked after 4-critic adversarial review, ready for planning
**Author:** council-driven brainstorm with the user

## Goal

Turn the leader-tier complexity assessor into a **PIL Gate** that runs before the
cloud agent and does two things:

1. **Depth from full context** — assess complexity/depth from the *whole turn*
   (input + recent tool calls + prior plan + EE recall), not the raw input alone.
2. **Bounded, honest enrichment** — when the prompt is under-specified, add only
   what is *deliverable without grepping the codebase*: a restructured intent,
   EE gotchas, facts already present in recent turns / the prior plan, and
   **suspected areas marked as UNVERIFIED HINTS the agent must confirm by
   grepping before anchoring**. The gate never asserts a file target as ground
   truth.

## Why the enrichment ambition is deliberately narrowed (critic finding)

A 4-critic adversarial review (2026-07-05) found the original "enrich which-files
without grepping" premise **structurally undeliverable and actively risky**:

- The only codebase context available to a tool-less gate is `ProjectContext`
  from `src/pil/layer15-context-scan.ts:60-106` — a **non-recursive** top-level
  directory scan (`readdirSync`, `.slice(0,20)`): **directory names, not files**.
  Plus `recentModifiedFiles` (git-dirty, `.slice(0,10)`) which is situational.
- To fill a file-level Target the producer must invent a path → the grounding
  critic strips it (not traceable) → Target collapses to a directory name or
  nothing. The anti-hallucination guard and the file-target value proposition
  are in direct opposition; the guard wins.
- Worse, `findRelevantModules` (`layer15-context-scan.ts:100`) matches prompt
  words to directory names by **bidirectional substring** ("state" → `src/state`,
  "test" → `__tests__`). A producer can write `Target: src/state/`, the grounding
  critic **passes it** (it is traceable to `relevantModules`) even when the bug is
  elsewhere — biasing the cloud agent into the wrong subtree. **Grounded ≠
  correct.** An asserted-but-wrong target is worse than a vague prompt the agent
  can grep freely.

**Consequence adopted in this design:** the gate does NOT assert file targets.
Any area reference derived from `relevantModules` (substring) or
`recentModifiedFiles` (git-dirty) is emitted as an explicit **"unverified hint —
confirm via grep before anchoring"**, never as an asserted locus. Enrichment
value comes from dimensions that do *not* need the codebase (intent structure,
acceptance framing, EE gotchas, prior-plan/recent-turn facts) plus these hedged
hints. If none of that materially helps, the gate returns `adequate + raw`.

## Motivation

99% of users write terse, under-specified prompts. Two concrete facts today:

1. The leader assessor (`src/gsd/complexity-assessor.ts`) is called with **both
   context slots empty** — `eeContext: undefined, // YAGNI` and no
   `conversationDigest` (`src/orchestrator/message-processor.ts:680`, verified).
   It judges complexity from the raw prompt string alone.
2. The only "is this prompt vague" signal is **regex** — `scoreSufficiency`
   (`src/pil/layer1-intent.ts:96`, verified regex).

The recent-turns digest, EE recall, and prior plan are already computed in the
same turn but never routed into the assessor. This design wires that context in
(cheap, high-value for depth) and adds a *bounded* agent-based quality/enrichment
layer whose ambition matches what a tool-less call can honestly deliver.

## Non-Goals

- **No live codebase grep inside the gate.** Single-shot leader/council calls,
  no tools. A tool-enabled deep-enrichment agent is explicitly out of scope
  (cost, and it duplicates what the cloud agent already does well).
- **No asserted file targets.** See §Why … narrowed. Area references are hedged
  hints, never ground truth.
- **No second user-asking mechanism.** Interactive clarification stays with the
  existing discovery interview (`src/pil/discovery.ts`, default ON).
- **No mutation-gate enforcement of prompt quality in v1.** The `needs-user`
  verdict produces an advisory `OPEN QUESTIONS` block in the brief with **zero
  enforcement** (see §needs-user). Real enforcement would need new plumbing and
  is a separate future task.
- **No change to the quick fast-path.** High-confidence `quick` prompts skip the
  gate entirely.

## Global Constraints (binding — copy verbatim into every task)

- **Zero Hardcode Rule:** no model/provider ID string literals. Resolve the
  leader via `resolvePlanCouncilLeader(sessionModelId)`; throw if unresolvable.
  Exceptions only: type unions, test fixtures, `catalog.json`, `pricing.ts`.
- **No Silent Catch Rule:** every `catch` logs `[pil-gate] <op>: ${err.message}`
  with context. No bare `catch {}`.
- **Fail-open, never block a turn:** any producer/critic parse failure, timeout,
  slowness past the gate deadline, or throw degrades to
  `{ enrichedPrompt: raw, depth: priorDepth }`. The turn always proceeds. The
  depth writeback must be reached on every path (see §Error Handling).
- **Billing `source=council`:** all gate LLM calls go through `createCouncilLLM`
  so cost is recorded and no cost leak occurs (matches the existing assessor).
- **Core/UI separation:** gate code (`src/gsd`, `src/pil`, `src/orchestrator`)
  may import `src/state` but NEVER `src/ui` or `opentui/react`.
- **Enrichment augments, never replaces:** the gate brief is *prepended* to the
  already-computed `pilCtx.enriched` (which by turn-start already carries
  layer3/4/5 + discovery output). The 1500-char budget applies to the *added
  prefix only*; the gate must never discard existing pipeline enrichment.

## The Prompt-Quality Rubric (v1)

A prompt is **adequate** when the four BLOCKER dimensions are present OR
confidently derivable from the provided context — *without padding*. Boosters
raise confidence, never block.

**BLOCKERS (missing ⇒ below standard):**

1. **Intent / Outcome** — *what must be true when done* (goal, not mechanism).
2. **Target / Locus** — *where*. **Delivered only as an unverified hint** (see
   §Why … narrowed): "likely area: `src/foo/` — confirm by grep before
   anchoring". Never an asserted path. Absence of a confident hint is normal and
   does not by itself force `needs-user`; the cloud agent greps.
3. **Scope boundary** — what is IN / OUT; magnitude (one function vs a subsystem).
4. **Acceptance** — how correctness is known (tests pass, behavior X, no
   regression Y).

**BOOSTERS (raise confidence, non-blocking):**

5. **Constraints** — hard rules: no new deps, keep API stable, perf/version/style.
6. **Rationale / Context** — why / prior attempts / related recent turns.

## Signal-over-Noise Principle (the "enough" stop condition)

Enrichment must be signal, not volume. A padded prompt is *worse*. Three laws:

1. **Marginal actionability** — every added line must change what the cloud agent
   does (narrow the search, add a constraint, hedge a hint). No change ⇒ not
   added.
2. **`noiseRisk` self-check** — the producer scores its own draft
   `low | med | high`; `high` is a quality *failure* to be stripped.
3. **Hard budget** — 1500-char cap on the added prefix forces selection.

**Stop condition — the gate emits `sufficiency`:**

- `adequate` → use raw; touch nothing further.
- `enriched` → gaps fillable from provided context (or a hedged hint helps) →
  prepend the brief.
- `needs-user` → a BLOCKER (intent/scope/acceptance) is *not derivable* from
  context AND the task is heavy → inject an advisory `OPEN QUESTIONS` block (no
  enforcement in v1).

"Enough" = the four blockers are addressed (Target may be a hedged hint or an
explicit "grep to locate") with zero noise lines. If enrichment would be mostly
noise, the gate returns `adequate + raw`.

## Architecture

### Producer + Critic split (cost-tiered)

A single agent that both writes enrichment and grades it "good, low-noise" is
self-grading and prone to the hallucinate/ignore failure. The split, tuned for
hot-path cost after the cost-critic finding that **`standard` is the default
depth** (`llm-classify.ts` biases "when unsure choose standard") and therefore
the majority tier:

| Depth (assessed) | Roles | Added leader calls vs today |
|---|---|---|
| quick + high-confidence | **skipped** (prefilter, `shouldAssess`) | 0 |
| quick low-conf / **standard** | Producer with **in-prompt self-critique** (rubric grounding/noise/sufficiency scored inside the one producer call) | **+0** (same single call as today's assessor) |
| heavy | Producer + up to 3 **separate** critics (grounding / noise / sufficiency), run via `Promise.all`, worst-verdict merge | +1..+3 (parallel ⇒ ~1 extra call of latency) |

Rationale: standard is the high-volume default; paying an extra blocking
leader call on every standard turn (cost-critic Attack 4) is not justified, so
standard uses **self-critique in the existing single call** (the producer already
emits `noiseRisk`, §Signal-over-Noise law 2). Only genuinely hard **heavy** tasks
earn independent adversarial critics — the tier where an extra call is worth it
and where the user already accepts more pre-flight cost.

Critics can only **DOWNGRADE / STRIP**, never upgrade or add lines. Merge is
worst-verdict-wins (`needs-user > enriched > adequate`), mirroring the plan- and
verify-council `block > revise > pass` merge (`src/gsd/plan-council.ts:136-140`).

Critic mandates (heavy):
- **Grounding critic** — every enrichment claim must trace to a source in the
  provided context; strip untraceable claims (*and* flag any area reference not
  explicitly hedged as an unverified hint — enforces §Why … narrowed).
- **Noise critic** — strip any line that does not change what the cloud agent
  does.
- **Sufficiency critic** — is `adequate` honest, or is a blocker being papered
  over? May flip `adequate → needs-user`.

### Reuse: pattern, not code

`createCouncilLLM().generate(modelId, system, prompt, …)` (`src/council/llm.ts`)
is directly reusable and already wrapped at the gate call site by
`buildLeaderAssessorRunner` (`message-processor.ts:682`). `verify-council.ts` /
`plan-council.ts` are domain-specific (verdict vocab `pass|revise|block`, require
a PLAN.md / diff) and are **not** callable for a turn-start gate — only their
worst-verdict merge *pattern* is copied. `src/gsd/pil-gate-critic.ts` is a **new**
module built on `createCouncilLLM` + `Promise.all`, NOT a call into
verify-council.

### Gate deadline (new — cost-critic finding)

Council calls default to a **300s** timeout (`src/council/llm.ts:331`). That is
unacceptable pre-first-token. The gate gets its **own tight deadline** (~2500ms,
matching the classifier `llm-classify.ts` budget): a producer/critic that does
not return in time is abandoned and the turn degrades to
`{ depth: priorDepth, enrichedPrompt: raw }`. Fail-open covers **slowness**, not
just throw.

### Full-context bundle (fed to the producer)

All sources exist and are computed this turn — this design routes them in:

| Context | Source (existing) |
|---|---|
| `conversationDigest` | `_buildRecentTurnsSummary` — `src/orchestrator/orchestrator.ts:3298` (last 6 msgs, ≤300c each; returns `null` when `messages.length < 2`) |
| `eeContext` (recall) | EE bridge `queryEeBridge` / `ctx._brainData` — `src/pil/layer3-ee-injection.ts` (recall computed upstream this turn) |
| `priorPlan` + phase | `.planning/PLAN.md` + `readState()` (`src/gsd`) |
| `recentToolCalls` | already partially inside the digest (tool messages ≤300c) |
| `projectContext` hints | discovery cache scan — `src/pil/discovery-cache.ts` (**may be empty** when discovery early-returns; gate tolerates empty → hint-less) |

Depth is therefore judged from the whole turn (satisfies the "not input alone"
requirement) even on turns where enrichment adds nothing.

### Where it runs

Message-processor turn-start, right after `prepGen` completes
(`src/orchestrator/message-processor.ts:661-706`). Ordering is verified sound:
`pilCtx.enriched` is first consumed at line **717** and assembled into the model
message at **984**, both after the gate block — so writing
`pilCtx.enriched = <brief> + "\n\n" + pilCtx.enriched` (prepend) at the gate is
picked up downstream, not a no-op. `depth` continues to write back to
`pilCtx.modelDepthTier` + STATE.md (preserving the I1 single-slot fix).

## Relationship to Discovery + Regex Removal

- **Discovery** (`src/pil/discovery.ts`, in-pipeline, default ON via
  `MUONROI_PIL_DISCOVERY`) keeps ownership of interactive user-asking. The gate
  adds no competing ask flow.
- **Regex removal — scoped correctly (evidence-critic finding).**
  `scoreSufficiency` has **two** live callers, not one:
  1. `src/pil/discovery.ts:306` — injects a hint into the discovery proposer.
     Dropping it here is safe (the proposer model is already the sole ask
     decider; the old regex ask-gate was removed per `clarity-gate.ts:4-9`).
  2. `src/orchestrator/orchestrator.ts:2120` — `/ideal` scaffolding uses it to
     force Council in the product loop.
  This design drops caller (1) only. Caller (2) is **out of scope** — the claim
  is "remove the regex sufficiency hint from the discovery path", NOT "retire
  `scoreSufficiency` globally". Touching `/ideal` routing is a separate change.

## needs-user handling (honest scope — evidence-critic finding)

`src/gsd/mutation-gate.ts` gates on `toolName + hardGateEnabled + directAnswer`
and reads depth from STATE → `canExecute`. It has **no input channel** for a
prompt-quality verdict, and heavy is already fully armed by *depth* alone. So a
`needs-user` verdict **cannot** "arm the mutation gate" by reusing shipped
machinery — that was a hand-wave in the first draft and is removed.

**v1 behavior:** on `needs-user`, the gate prepends an advisory
`OPEN QUESTIONS — the agent must resolve or ask, never guess` block to the brief.
It is **injected text with zero enforcement**; the mutation gate's behavior is
unchanged. Real enforcement (threading the verdict into `canExecute`/STATE) is a
deliberately deferred follow-up.

## Data Flow

```
user input
  │
  ▼
runPipeline (layer1 classify → discovery(ask) → layers)     [in-pipeline, unchanged]
  │  produces pilCtx: depth(guess), confidence, enriched(=layer3/4/5+discovery), _brainData
  ▼
message-processor turn-start (isGsdNativeEnabled && intentKind != chitchat)
  │
  ├─ prefilter: shouldAssess(priorDepth, confidence)? ── no ──▶ skip gate, use raw depth
  │                                                     yes
  ▼
PIL GATE  (own ~2500ms deadline; fail-open on throw OR slowness)
  ├─ assemble full-context bundle (digest + eeContext + plan + toolcalls + projectScan[maybe empty])
  ├─ PRODUCER (leader, single call): depth + quality{verdict,missing,noiseRisk} + brief(draft, hedged hints)
  ├─ standard → producer self-critique inside the same call
  │  heavy    → + 3 critics (Promise.all) downgrade/strip → worst-verdict merge
  ├─ resolve sufficiency:
  │     adequate   → brief = "" (use raw)
  │     enriched   → brief = merged prefix (≤1500c, hedged hints only)
  │     needs-user → brief += advisory OPEN QUESTIONS block (no enforcement)
  ▼
depth writeback (ALWAYS reached): pilCtx.modelDepthTier = depth; syncWorkflowContext(STATE.md)
prepend brief: pilCtx.enriched = brief ? (brief + "\n\n" + pilCtx.enriched) : pilCtx.enriched
  ▼
pilCtx.enriched consumed at :717 → model message at :984 → cloud agent
```

## Components / File Map

- `src/gsd/complexity-assessor.ts` — **expand**: producer contract gains
  `quality` + `enrichedPrompt`; populate the context slots; standard-tier
  self-critique in-prompt.
- `src/gsd/assessment-schema.ts` — **expand**: verdict schema + extractor gain
  the quality/enrichment fields. Reuse the **string/escape-aware brace scan that
  already lives in `assessment-schema.ts` itself** (`findBareObjects`, its own
  copy — `verdict-schema.ts`'s version is NOT exported; evidence-critic finding).
- `src/gsd/pil-gate-critic.ts` — **new**: heavy-tier critic role prompts +
  `Promise.all` parallel runner + worst-verdict/strip merge, on `createCouncilLLM`.
- `src/gsd/pil-gate-context.ts` — **new**: assembles the full-context bundle from
  existing sources, each read tolerant + char-capped; tolerates empty
  `projectContext`.
- `src/orchestrator/message-processor.ts` — **modify** (~661-706): populate the
  bundle, run producer(+critics on heavy), apply the gate deadline, prepend the
  brief. New code wrapped in its **own try/catch** (see §Error Handling).
- `src/orchestrator/orchestrator.ts` — **wire**: expose `_buildRecentTurnsSummary`
  into the gate call path.
- `src/pil/discovery.ts` — **modify**: drop the `scoreSufficiency` hint
  (caller 1 only).
- `src/gsd/flags.ts` — **add** `MUONROI_PIL_GATE_ENRICH` (default ON with native
  GSD, opt-out=0). Documented coupling: the gate lives inside the
  `isGsdNativeEnabled()` block, so `MUONROI_GSD_NATIVE=0` disables enrichment too.

## Error Handling

- **Depth writeback must always run.** The first-draft claim that the catch at
  `message-processor.ts:694` protects `syncWorkflowContext` (line 702) is FALSE —
  694 is the assessor-only inner catch. The new producer/critic code gets its
  **own inner try/catch** so a throw there degrades to
  `{ depth: priorDepth, enrichedPrompt: raw }` and control still reaches the
  unconditional `pilCtx.modelDepthTier = depth` + `syncWorkflowContext` at
  701-702. (Alternative: place all new code strictly after line 702 — either is
  acceptable as long as the depth writeback is never skipped.)
- Producer call/parse failure OR gate-deadline timeout → raw brief + priorDepth,
  logged `[pil-gate] producer …`.
- Critic (heavy) call/timeout → use the producer draft unmodified (critics are
  tightening-only; absence cannot make the brief worse), logged at debug.
- `needs-user` on any tier → advisory OPEN QUESTIONS text only; no gate arming.
- **Enrichment coupling / chitchat skip (architecture-critic finding):** the gate
  is inside `if (isGsdNativeEnabled() && pilCtx.intentKind !== "chitchat")`
  (line 661). Continuation phrases ("tiếp tục"/"continue") are sometimes
  classified `chitchat` (`preprocessor.ts:118-134`), which would skip enrichment
  on a *resumed heavy task*. Mitigation: the gate's chitchat guard is relaxed to
  still run when an active GSD run/plan exists for the cwd
  (`readState().phase === "execute"` or a resume digest is present), so resumed
  heavy work is still enriched. Pure chitchat with no active run still skips.

## Testing Strategy

**Unit (mock council LLM, `src/gsd/__tests__/`):**
- Verdict/quality extraction; parse-fail / deadline → fail-open to priorDepth +
  raw; depth writeback still reached after a forced producer throw.
- Standard tier: producer self-critique path makes **zero** extra council calls.
- Heavy tier: 3 critics via `Promise.all`; critic downgrade-only (an `adequate`
  critic cannot upgrade a producer `needs-user`); noise-strip; `needs-user` flip.
- Anti-mislead: an unhedged area reference is stripped/hedged by the grounding
  critic; a `relevantModules` substring hint is emitted only as "confirm via
  grep", never asserted.
- Context assembly: digest / EE / plan present in the producer prompt
  (regression against the empty-slot bug); tolerates empty `projectContext`.
- Brief prepends (does not replace) existing `pilCtx.enriched`.

**Harness E2E (`tests/harness/`, pattern of `gsd-hard-gate.spec.ts`, mock
council fixture, deterministic):**
- Vague heavy prompt → brief prepended, contains a hedged hint + OPEN QUESTIONS,
  existing enrichment preserved.
- Crisp prompt → `adequate`, raw passthrough.
- quick + high-confidence → gate skipped entirely (no council calls).
- Standard turn → no extra critic call (latency guard).

**Pre-push gates:** full `bunx vitest run` (0 fail) + harness suite for
UI/harness surfaces.

## Rollout / Flags

| Flag | Effect |
|---|---|
| `MUONROI_GSD_NATIVE=0` | disables native GSD **and** the gate/enrichment (coupling — documented) |
| `MUONROI_GSD_ASSESSOR=0` | disable the assessor entirely (depth from layer1 only) |
| `MUONROI_PIL_GATE_ENRICH=0` | keep depth assessment, disable quality+critic+enrichment |
| `MUONROI_PIL_DISCOVERY=0` | disable interactive user-asking |

Default: all ON with native GSD. Enrichment is independently disablable from
depth assessment for staged rollout / A-B.

## Critic Review — Defects Addressed (2026-07-05, 4 adversarial critics)

| Finding (critic) | Severity | Resolution in this rework |
|---|---|---|
| No-grep enrichment cannot deliver file-level Target/Locus (efficacy) | 🔴 | Target downgraded to **unverified hint, confirm via grep**; enrichment value re-scoped to non-codebase dimensions. §Why … narrowed. |
| `relevantModules` substring / git-dirty can mislead to wrong subtree; grounded ≠ correct (efficacy) | 🔴 | Area refs are hedged hints only; grounding critic flags any unhedged assertion. Anti-mislead unit test. |
| `needs-user → arms mutation gate` unimplementable as "reuse" (evidence) | 🟠 | Claim removed; v1 OPEN QUESTIONS is advisory, zero enforcement; real enforcement deferred. |
| Blocking pre-first-token cost; "parallel critics" rests on unwritten code; standard is the default tier and always assesses (cost) | 🟠 | Standard = producer self-critique (**+0 calls**); critics **heavy-only** via `Promise.all`; explicit +call table. |
| 300s council timeout, fail-open only on throw not slowness (cost/arch) | 🟠 | Own **~2500ms gate deadline**; fail-open on slowness. |
| Brief replace vs augment undefined → 1500c could clobber layer3/4/5 (arch) | 🟠 | Brief **prepends**; budget applies to the added prefix only; never replaces. |
| Fail-open cites wrong guard (694 assessor-only) → depth writeback skippable (arch) | 🟠 | New code gets its **own try/catch**; depth writeback always reached. |
| Enrichment coupled to `GSD_NATIVE` + skipped on chitchat incl. resumed-heavy continuation bug (arch) | 🟠 | Coupling documented; chitchat guard relaxed when an active GSD run/resume exists. |
| Regex "retired from live path" overbroad — 2nd caller at `/ideal` (evidence) | 🟡 | Scope corrected: drop discovery caller only; `/ideal` untouched. |
| Brace-scan "reuse from verdict-schema.ts" wrong — not exported (evidence) | 🟡 | Use `assessment-schema.ts`'s own `findBareObjects` copy. |
| `_brainData@161` mis-cite (evidence) | 🟡 | Corrected: line 161 is `queryEeBridge`; `_brainData` read later. |
| Injection ordering NOT a no-op (architecture — hypothesis refuted) | ✅ | Confirmed sound: `pilCtx.enriched` consumed at 717/984, after the gate. |
