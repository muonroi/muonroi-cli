# PIL Prompt Gate — Agent-Based Enrichment + Quality Gate Design

**Date:** 2026-07-05
**Status:** Approved (brainstorm), ready for planning
**Author:** council-driven brainstorm with the user

## Goal

Turn the leader-tier complexity assessor into a **PIL Gate**: a multi-role,
agent-based station that runs before the cloud agent, judges whether the user's
prompt is *information-rich enough* against a defined rubric, and — when it is
not — **auto-enriches** it from context already computed this turn, so the
downstream cloud agent starts from a sharp brief instead of grepping around a
vague request. Complexity/depth is assessed from the **full turn context**
(input + recent tool calls + prior plan + EE recall), not the raw input alone.

## Motivation

99% of users write terse, under-specified prompts ("fix the bug", "make it
faster"). Today two facts hurt:

1. The leader assessor (`src/gsd/complexity-assessor.ts`) is called with **both
   context slots empty** — `eeContext: undefined // YAGNI` and no
   `conversationDigest` (`src/orchestrator/message-processor.ts:680`). It judges
   complexity from the raw prompt string alone.
2. The only "is this prompt vague" signal is **regex** — `scoreSufficiency`
   (`src/pil/layer1-intent.ts:96`, dimensions scope/target/intent) — which the
   user wants replaced by a real agent judgment.

Meanwhile the enrichment the cloud agent needs (recent-turns digest, EE recall,
prior plan, project structure) is **already computed in the same turn** but never
routed into the assessor. This design wires that context in and adds an
agent-based quality/enrichment layer, reusing the existing council infrastructure.

## Non-Goals

- **No live codebase grep inside the gate.** The gate is single-shot
  leader/council calls with no tools. It enriches from context handed to it;
  the cloud agent remains the deep-grep actor. A tool-enabled deep-enrichment
  agent is a possible future escalation, explicitly out of scope (YAGNI + cost).
- **No second user-asking mechanism.** Interactive clarification stays with the
  existing discovery interview (`src/pil/discovery.ts`, default ON). The gate
  does not open a competing ask flow.
- **No change to the quick fast-path.** High-confidence `quick` prompts skip the
  gate entirely (prefilter unchanged) — a crisp prompt is already adequate.

## Global Constraints (binding — copy verbatim into every task)

- **Zero Hardcode Rule:** no model/provider ID string literals. Resolve the
  leader via `resolvePlanCouncilLeader(sessionModelId)`; throw if unresolvable.
  Only exceptions: type unions, test fixtures, `catalog.json`, `pricing.ts`.
- **No Silent Catch Rule:** every `catch` logs `[pil-gate] <op>: ${err.message}`
  with context. No bare `catch {}`.
- **Fail-open, never block a turn:** any producer/critic parse failure, timeout,
  or throw degrades to `{ enrichedPrompt: raw, depth: priorDepth }`. The turn
  always proceeds.
- **Billing `source=council`:** all gate LLM calls go through `createCouncilLLM`
  so cost is recorded and no cost leak occurs (matches the existing assessor).
- **Core/UI separation:** gate code (`src/gsd`, `src/pil`, `src/orchestrator`)
  may import `src/state` but NEVER `src/ui` or `opentui/react`.
- **Char budget:** the enriched brief is capped at 1500 chars (parity with
  BB-context / assessor budgets).

## The Prompt-Quality Rubric (v1)

A prompt is **adequate** when the four BLOCKER dimensions are present OR
confidently inferable from the provided context — *without padding*. The two
BOOSTER dimensions raise confidence but never block.

**BLOCKERS (missing ⇒ below standard):**

1. **Intent / Outcome** — *what must be true when done* (the goal, not the
   mechanism). "Fix bug" → which bug, what the correct behavior is.
2. **Target / Locus** — *where*: files / modules / surface. The single biggest
   lever against the cloud agent grepping blindly.
3. **Scope boundary** — what is IN, what is explicitly OUT; magnitude (one
   function vs a subsystem).
4. **Acceptance** — how correctness is known (tests pass, behavior X, no
   regression Y).

**BOOSTERS (raise confidence, non-blocking):**

5. **Constraints** — hard rules: no new deps, keep API stable, perf/version/style.
6. **Rationale / Context** — why / prior attempts / related recent turns
   (prevents re-derivation and re-breakage).

## Signal-over-Noise Principle (the "enough" stop condition)

The central quality principle: **enrichment must be signal, not volume.** A
prompt padded with irrelevant context is a *worse* prompt, not a better one.
Three enforced laws:

1. **Marginal actionability** — every added line must *change what the cloud
   agent does* (narrow the search, add a constraint, name a file). If it does
   not change behavior, it is not added.
2. **`noiseRisk` self-check** — the producer scores its own draft
   `low | med | high`; `high` is a quality *failure* that a critic strips.
3. **Hard budget** — 1500-char cap forces selection, never a dump.

**Stop condition — the gate emits `sufficiency`:**

- `adequate` → use raw (or a light enrich); touch nothing further.
- `enriched` → gaps were fillable from provided context → use the enriched brief.
- `needs-user` → a BLOCKER gap is *not inferable* from context AND the task is
  heavy → do not guess; inject an `OPEN QUESTIONS` block (see §Discovery).

"Enough" = the four blockers are covered with **zero noise lines**. If
enrichment would be mostly noise, the gate returns `adequate + raw` or
`needs-user` — it must never pad for the sake of looking richer.

## Architecture

### Multi-role: Producer ↔ Critic (reusing council infra)

A single agent that both writes the enrichment and grades it as "good, low
noise" is self-grading and prone to the hallucinate/ignore failure the user
named. The fix splits **producer** (writes) from **critic** (attacks), reusing
the existing council machinery (`createCouncilLLM`, perspectives, worst-verdict
merge as in `src/gsd/verify-council.ts`).

**Producer** (1 leader call — the folded, expanded assessor):
- Inputs: raw prompt + full context bundle (below).
- Outputs: `depth`, `autoCouncil`, `rationale` (existing) **plus**
  `quality: { verdict, missing[], noiseRisk }` and `enrichedPrompt` (draft;
  empty when `adequate`).

**Critic(s)** (separate call(s) — can only DOWNGRADE / STRIP, never upgrade):
- **Grounding critic** — every enrichment claim must trace to a source in the
  provided context (digest / EE / plan / project scan). Ungrounded claim =
  hallucination → strip. *Kills "ảo tưởng".*
- **Noise critic** — each added line: does it change what the cloud agent does?
  No → strip. *Enforces signal-over-noise.*
- **Sufficiency critic** — is `adequate` honest, or is the producer papering
  over an un-inferable blocker (target/scope) that should be `needs-user`? May
  flip `adequate → needs-user`. *Kills "ignore".*

Merge is **worst-verdict-wins** (`needs-user > enriched > adequate`), identical
in spirit to the existing verify-council `block > revise > pass` merge. A critic
can tighten the verdict and remove lines; it can never loosen the verdict or add
lines.

### Panel scale (tier-based)

| Depth (assessed) | Roles | Calls | Latency (critics parallel) |
|---|---|---|---|
| quick + high-confidence | **skipped** (prefilter) | 0 | 0 |
| quick low-conf / standard | Producer + 1 combined critic (all 3 mandates) | 2 | ~2 sequential |
| heavy | Producer + 3 separate critics (grounding/noise/sufficiency), majority-downgrade | 4 | ~2 sequential (critics parallel) |

The prefilter (`shouldAssess`, `src/gsd/complexity-assessor.ts:29`) is unchanged:
high-confidence quick prompts never reach the gate.

### Full-context bundle (fed to the producer)

All sources already exist and are computed in the same turn — this design
routes them in, it does not build new plumbing:

| Context | Source (existing) |
|---|---|
| `conversationDigest` | `_buildRecentTurnsSummary` — `src/orchestrator/orchestrator.ts:3298` |
| `eeContext` (recall) | `_brainData` / layer3 — `src/pil/layer3-ee-injection.ts:161` |
| `priorPlan` + phase | `.planning/PLAN.md` + `readState()` (`src/gsd`) |
| `recentToolCalls` | already partially inside the digest (tool messages ≤300c) |
| `projectContext` hints | discovery cache scan — `src/pil/discovery-cache.ts` |

Complexity/depth is therefore judged from the **whole turn**, satisfying the
requirement that complexity not be decided from the input alone.

### Where it runs

The gate stays at its current location — message-processor turn-start, right
after `prepGen` completes (`src/orchestrator/message-processor.ts:661-702`),
outside the pipeline timeout so it is fail-open. The producer replaces the
current `assessComplexity` call; the critic stage runs after it. The resulting
`enrichedPrompt` is injected into the prompt/`pilCtx.enriched` sent downstream to
the cloud agent, bounded by the char budget. `depth` continues to write back to
`pilCtx.modelDepthTier` + STATE.md (the single depth slot, preserving the I1 fix).

## Relationship to Discovery + Regex Removal

- **Discovery** (`src/pil/discovery.ts`, in-pipeline, default ON via
  `MUONROI_PIL_DISCOVERY`) keeps ownership of **interactive user-asking**. The
  gate does not add a second ask flow.
- Because the gate runs *after* the pipeline (discovery already ran), a
  `needs-user` verdict does **not** re-trigger discovery. Instead the gate
  injects an `OPEN QUESTIONS — the agent must resolve or ask, never guess`
  block into the brief. On **heavy** tasks this block feeds the existing hard
  mutation gate (`src/gsd/mutation-gate.ts`): mutations stay blocked until the
  open question is resolved — reusing shipped machinery, no new interrupt.
- **Regex removal:** `scoreSufficiency` (regex) currently injects a hint into the
  discovery proposer. The discovery proposer is already a model that decides
  whether to ask (the old regex ask-gate was removed). Drop the `scoreSufficiency`
  hint from the discovery input path so sufficiency is agent-decided on both
  sides (proposer for asking, gate council for enrichment). The regex scorer is
  retired from the live path.

## Data Flow

```
user input
  │
  ▼
runPipeline (layer1 classify → discovery(ask) → layers)   [in-pipeline, unchanged]
  │  produces pilCtx: depth(guess), confidence, enriched, _brainData
  ▼
message-processor turn-start (isGsdNativeEnabled)
  │
  ├─ prefilter: shouldAssess(priorDepth, confidence)? ── no ──▶ skip gate, use raw depth
  │                                                     yes
  ▼
PIL GATE
  ├─ assemble full-context bundle (digest + eeContext + plan + toolcalls + projectScan)
  ├─ PRODUCER (leader): depth + quality{verdict,missing,noiseRisk} + enrichedPrompt(draft)
  ├─ CRITIC(s) (tier-scaled, parallel): downgrade/strip only → worst-verdict merge
  ├─ resolve sufficiency:
  │     adequate   → enrichedPrompt = raw
  │     enriched   → enrichedPrompt = merged brief (≤1500c)
  │     needs-user → brief + OPEN QUESTIONS block (heavy → arms mutation gate)
  ▼
write back: pilCtx.modelDepthTier = depth; syncWorkflowContext(STATE.md)
inject enrichedPrompt downstream to cloud agent
  ▼
cloud agent runs from a sharp brief
```

## Components / File Map

- `src/gsd/complexity-assessor.ts` — **expand**: producer contract gains
  `quality` + `enrichedPrompt`; `AssessInput` context slots become populated.
- `src/gsd/assessment-schema.ts` — **expand**: verdict schema + extractor gain
  the quality/enrichment fields (keep the existing string/escape-aware brace
  scan from `verdict-schema.ts`).
- `src/gsd/pil-gate-critic.ts` — **new**: critic role prompts + parallel runner +
  worst-verdict/strip merge (built on `createCouncilLLM` + the verify-council
  merge pattern).
- `src/gsd/pil-gate-context.ts` — **new**: assembles the full-context bundle from
  the existing sources (digest / EE / plan / projectScan), each read tolerant +
  char-capped.
- `src/orchestrator/message-processor.ts` — **modify** (~661-702): populate the
  context bundle, run producer→critic, inject `enrichedPrompt`.
- `src/orchestrator/orchestrator.ts` — **wire**: expose `_buildRecentTurnsSummary`
  output into the gate call path.
- `src/pil/discovery.ts` / `src/pil/layer1-intent.ts` — **modify**: drop the
  `scoreSufficiency` regex hint from the discovery input path.
- `src/gsd/flags.ts` — **add** `MUONROI_PIL_GATE_ENRICH` (default ON, opt-out=0).

## Error Handling

- Producer call/parse failure → `{ depth: priorDepth, enrichedPrompt: raw }`,
  logged `[pil-gate] producer failed: …`. Turn proceeds.
- Critic call/timeout → use the producer draft unmodified (critics are
  tightening-only; their absence cannot make the brief worse than the draft),
  logged at debug. Never blocks.
- Any unexpected throw in the gate block is caught by the existing defensive
  try/catch so `syncWorkflowContext` still runs (fail-open insurance already at
  `message-processor.ts:694`).
- `needs-user` + non-heavy → the OPEN QUESTIONS block is advisory in the brief
  (does not arm the mutation gate); only heavy arms it.

## Testing Strategy

**Unit (mock council LLM, `src/gsd/__tests__/`):**
- Verdict/quality extraction; parse-fail → fail-open to priorDepth + raw.
- Critic downgrade-only: a critic verdict of `adequate` cannot upgrade a
  producer `needs-user`; assert worst-verdict merge.
- Noise-strip: critic removes an ungrounded/no-op line from the draft.
- `needs-user` flip by the sufficiency critic.
- Context assembly: digest / EE / plan are present in the producer prompt
  (regression against the empty-slot bug).
- Panel scale: standard → 1 critic; heavy → 3 critics.

**Harness E2E (`tests/harness/`, pattern of `gsd-hard-gate.spec.ts`, mock
council fixture, deterministic):**
- Vague prompt → brief enriched (assert brief injected + contains target/scope).
- Crisp prompt → `adequate`, raw passthrough.
- quick + high-confidence → gate skipped entirely (no council calls).

**Pre-push gates:** full `bunx vitest run` (0 fail) + `bunx vitest -c
vitest.harness.config.ts run tests/harness/` when UI/harness surfaces change.

## Rollout / Flags

| Flag | Effect |
|---|---|
| `MUONROI_GSD_ASSESSOR=0` | disable the assessor entirely (depth from layer1 only) — existing |
| `MUONROI_PIL_GATE_ENRICH=0` | keep depth assessment, disable quality+critic+enrichment |
| `MUONROI_PIL_DISCOVERY=0` | disable interactive user-asking — existing |

Default: all ON with native GSD. The enrichment layer can be disabled
independently of depth assessment for staged rollout / A-B comparison.

## Open Questions (resolved during brainstorm)

- **Gate action when sub-standard** → Hybrid: auto-enrich from context, only
  escalate to `needs-user` when a blocker is un-inferable AND task is heavy.
- **Placement** → fold into the existing leader assessor (one producer call), not
  a separate spawn.
- **Multi-role** → producer + critic split, reusing council infra; tier-scaled
  panel (standard 1 critic, heavy 3 parallel critics).
- **"Enough" definition** → four blockers covered with zero noise lines;
  over-enrichment is a quality failure, enforced by the noise critic.
