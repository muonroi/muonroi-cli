# Product Ideal Loop — Design Spec

**Date:** 2026-05-07
**Status:** Draft pending user review
**Approach:** GSD/Flow Pattern Reuse (Approach C)

---

## 1. Overview

A self-driving product loop that takes a free-text idea + a cost cap, gathers
context interactively, debates feasibility with multi-role council, produces
a product spec for user approval, then runs sprint iterations until a strict
5-condition Definition-of-Done passes — or a deterministic circuit breaker
halts the run.

**Differentiator vs Aider/Cursor/Continue:** those are prompt → AI does → user
loops manually. This is `idea → AI runs full Agile cycle → user only at gates`,
with engineering-floor enforcement (no "happy team, broken product" outcomes)
and per-product cost ceiling.

**Non-goals:**
- Replace human PMs / customers in real teams
- Generate deployed live services (output is a working repo, deployment is out of scope)
- Run without any user gates (gates at scoping + ship are mandatory)

---

## 2. Architecture

### 2.1 New module

`src/product-loop/`:

| File | Purpose |
|---|---|
| `index.ts` | `runProductLoop(opts)` entry point |
| `types.ts` | `ProductSpec`, `RoleSlot`, `IterationState`, `DoneVerdict`, `DoneCondition` |
| `loop-driver.ts` | Outer FSM (gather → spec → sprint × N → done) |
| `role-registry.ts` | 6-role registry with cross-tier resolution |
| `done-gate.ts` | 5-condition Definition-of-Done evaluation |
| `circuit-breakers.ts` | Cost / oscillation / verify-blank breakers |
| `cost-scoper.ts` | Per-product budget namespace inside ledger |
| `reality-anchor.ts` | Evidence-required wrapper around synthesis |
| `__tests__/` | Unit + integration tests |

### 2.2 Existing files touched

| File | Edit | Approx LoC |
|---|---|---|
| `src/gsd/types.ts` | Add `WorkflowKind = "task" \| "product"` enum | ~15 |
| `src/flow/run-manager.ts` | Add `iterations.md` + `manifest.md` to RUN_FILES, helpers | ~40 |
| `src/usage/ledger.ts` | Add `productRunId` namespace param to reservation/commit | ~30 |
| `src/cli/commands.ts` | Register `/ideal` slash command | ~20 |
| `src/orchestrator/orchestrator.ts` | Wire `runProductLoopV1` like `runCouncilV2` | ~50 |

**New code total:** ~1200 LoC. **Edits:** ~155 LoC.

### 2.3 Reused as-is (zero edits)

- `src/council/` — invoked per sprint as planner
- `src/verify/orchestrator.ts` — engineering floor check
- `src/ee/phase-tracker.ts` + `phase-outcome.ts` — auto post iteration boundaries
- `src/ee/judge.ts` — deterministic FOLLOWED/IGNORED/IRRELEVANT classifier
- `src/ee/intercept.ts` + `posttool.ts` — PreTool warnings + PostTool reconciliation
- `src/pil/pipeline.ts` — runs as normal on every prompt (200ms hot-path preserved)
- `src/flow/artifact-io.ts` — atomic .md read/write

**Critical principle:** product-loop is a **caller** of council, not a replacement.
Council retains 1-shot semantics. Each sprint = one `runCouncil()` invocation
with carry-over context via messages history.

---

## 3. Run Artifact Layout

Each `/ideal` invocation creates one GSD run at `.muonroi-flow/runs/<runId>/`.
Reuses 4 existing files plus 2 new files.

| File | Role | Existing? |
|---|---|---|
| `roadmap.md` | Product Spec (features, architecture, I/O contract, folder structure) | extend |
| `state.md` | Active sprint, scores, cost, circuit status, last verify result | extend |
| `delegations.md` | Role registry: 6 slots → modelId per sprint | extend |
| `gray-areas.md` | Success criteria checklist with status + evidence | extend |
| `iterations.md` | Append-only sprint history | NEW |
| `manifest.md` | Product metadata (idea text, cap, createdAt, doneAt, verdict) | NEW |

### 3.1 `iterations.md` schema (append-only)

```markdown
## Sprint 1 — 2026-05-07T10:23:14Z
- Cost: $0.42 (cum: $0.42 / $50.00)
- Council: clarify=skip, debate=3 rounds, plan=approved
- Files touched: src/note/parser.ts (+45), tests/note.test.ts (+22)
- Verify: PASS (recipe=bun test)
- Criteria delta: 3/10 met, 2/10 partial, 5/10 unmet
- Circuit: green
- EE phase-outcome: posted (id=ph_xy12)
```

### 3.2 `gray-areas.md` schema (criteria tracker)

```markdown
## Success Criteria

### C1: Realtime sync between 2 clients (weight: 3)
- Status: met
- Evidence: tests/sync.test.ts:42 (concurrent_edit_test passes)
- Sprint: 2

### C2: Offline-first edit queue (weight: 2)
- Status: partial
- Evidence: src/queue/offline.ts:18 (queue exists, no retry-on-reconnect)
- Sprint: 3
- Gap: retry mechanism missing
```

`gray-areas.md` is the single source of truth for done-gate Condition #3 score.
PO does not self-rate; status flips only when evidence cite passes regex check.

### 3.3 `state.md` schema

```markdown
## Active Sprint
3

## Cost
spent: $1.95
cap: $50.00
projected_next: $0.83

## Last Verify
sprint: 2
result: PASS
recipe: bun test
ts: 2026-05-07T10:48:11Z

## Circuit Status
cost: green
oscillation: green (delta_t-1=4, delta_t=3)
verify_blank: green

## Resume Digest
[for PIL Layer 5]
Stage: sprint-loop
Sprint: 3
Last action: implementer wrote src/queue/offline.ts
Pending: tester to write retry test
```

### 3.4 `delegations.md` schema

```markdown
## Roles (Sprint 3)

### PO
- model: claude-sonnet-4-6
- provider: anthropic
- tier: premium
- memory_ref: runs/ab12cd/memory/po.md

### Architect
- model: gemini-2.5-pro
- provider: google
- tier: premium
- memory_ref: runs/ab12cd/memory/architect.md

[... 4 more roles]

## Cross-tier check
- All roles distinct model: ✓
- Cross-provider count: 2 (anthropic, google)
- Echo-chamber risk: low
```

### 3.5 Per-role memory

Per-slot file at `runs/<id>/memory/<slot>.md`. Append-only per sprint, oldest
truncated when total exceeds 2KB per slot. Loaded into role's context when the
slot is invoked in the next sprint.

---

## 4. Lifecycle FSM

```
[idle]
  ↓ /ideal "..."
[gather]                  reuse council clarifier (max=6 rounds, 6 seed dimensions)
  ↓ ≥5/6 dimensions resolved (≥85%); at round 6 if still <5 → refuse advance, prompt manual answers
[research]                reuse council debate phase
  ↓ leader-eval allCriteriaMet OR round=3
[scoping]                 NEW: produce ProductSpec + costEstimate
  ↓ user gate (preflight #1)
[approved]
  ↓
[sprint-N: plan]          council.runCouncil(skipClarification=true)
  ↓
[sprint-N: implement]     council.executor.runExecution
  ↓
[sprint-N: verify]        runVerifyOrchestration
  ↓
[sprint-N: judge]         done-gate.evaluate (5 conditions)
  ├→ done? → [retrospective]
  ├→ circuit fired? → [halted]
  └→ continue → [sprint-N+1: plan]
[retrospective]           council debate "what to promote to T0/T1"
  ↓
[shipped]
```

### 4.1 Stage 1 — Gather (clarifier extension)

Seed 6 dimensions (cứng cho product mode, không LLM-generated):

1. **persona** — Who are the primary users?
2. **core-features** — Top 3 must-have features?
3. **non-functional** — Performance / privacy / offline / scale targets?
4. **tech-constraints** — Language / framework / existing repo?
5. **success-metric** — How is "done" measured?
6. **cost-tolerance** — Hard cap or soft target?

Exit when ≥5/6 resolved (≥85%). At round 6, if <5 dimensions resolved → refuse
advance, prompt user to manually answer remaining.

Confidence metric is `unresolvedDimensions.length`, NOT PIL classifier confidence.

### 4.2 Stage 2 — Research

Council debate with 4 leader-proposed stances:
- Researcher (web/codebase scan)
- Cost-Controller (token budget projection)
- Skeptic (3 risk scenarios)
- Architect (tech stack proposal)

Reuses `src/council/debate.ts` dynamic round system (no hardcoded 2-round cap;
leader evaluates each round, dynamic exit).

### 4.3 Stage 3 — Scoping

Leader synthesis → ProductSpec JSON written to `roadmap.md`:

```json
{
  "mvp": [{ "name": "...", "criteriaIds": ["C1", "C2"] }],
  "phase2": [{ "name": "...", "criteriaIds": ["C8", "C9"] }],
  "architecture": { "components": ["..."], "dataFlow": "..." },
  "ioContract": { "inputs": ["..."], "outputs": ["..."] },
  "folderStructure": "...",
  "sprintEstimate": 4,
  "costEstimate": { "perSprint": 0.8, "total": 3.2 }
}
```

User preflight #1: approve / reject / edit-spec.
On edit: re-enter scoping with user diff applied.

### 4.4 Sprint loop transitions

| From | To | Trigger |
|---|---|---|
| `sprint-N: judge` | `sprint-N+1: plan` | `verdict === "continue"` AND no breaker fired |
| `sprint-N: judge` | `retrospective` | `verdict === "shipped"` |
| `sprint-N: judge` | `halted` | any circuit breaker fired |
| `halted` | `idle` | user `/abort` OR resolves circuit |

### 4.5 Circuit breakers (deterministic)

#### CB-1: Cost
```
projectedNextSprintCost = EWMA(last 3 sprint costs) * 1.2
if projectedNextSprintCost > (capUsd - spentUsd) * 1.5:
  halt(reason: "cost-overrun")
```

#### CB-2: Oscillation
```
if sprintN >= 3 and delta_t <= 0 and delta_t-1 <= 0:
  halt(reason: "oscillation")
```
2 sprint streak with non-positive criteria delta = stuck.

#### CB-3: Verify-blank
```
if sprintN === 1 and (recipe === null or recipe.coverage === 0):
  halt(reason: "verify-blank")
```
Hard refuse only — no force-continue option. No tests = no product.

### 4.6 Abort vs Halt

| State | Source | User options | Side effect |
|---|---|---|---|
| `halted` | circuit breaker | continue / abort / raise budget | Run resumable if user fixes condition |
| `aborted` | user `/abort` | none | Final, write `manifest.md aborted=true`, post EE `phase-outcome=aborted` |

NO `pause`. User has exactly one mid-loop action: `/abort`.

### 4.7 Resume contract

`muonroi ideal resume <runId>`:
1. `loadRun(flowDir, runId)` reconstructs all 6 files
2. Parse `state.md` for `currentStage` and `currentSprint`
3. If stage ∈ `{gather, scoping}` → re-enter at start of stage
4. If stage = sprint in flight → re-run sprint from start (council deterministic on same spec)
5. Cost spent NOT refunded
6. Old crashed sprint marked in `iterations.md`
7. EE post `phase-outcome=resumed`

---

## 5. Done-Gate Specification

5 AND conditions. Short-circuit on first failure (Condition #1 cheapest, #4
most expensive — order matters for cost).

### 5.1 Condition #1 — Engineering floor

```ts
async function checkVerifyFloor(runId: string): Promise<DoneCondition> {
  const lastVerify = readLastVerifyResult(runId)
  const recipe = readRecipe(runId)
  if (recipe === null || recipe.testCommand === null) return { pass: false, reason: "no_recipe" }
  if (recipe.coverage === 0) return { pass: false, reason: "zero_coverage" }
  if (lastVerify.result !== "PASS") return { pass: false, reason: `verify_${lastVerify.result.toLowerCase()}` }
  return { pass: true, evidence: `verify=PASS recipe=${recipe.id}` }
}
```

### 5.2 Condition #2 — Criteria evidence completeness

```ts
function evidenceLooksValid(text: string): boolean {
  return /\b\w+\.(ts|tsx|js|py|go|rs|java):\d+/.test(text)            // file:line
      || /\btest\(['"`].+['"`]\)|describe\(['"`].+['"`]\)/.test(text)  // test name
      || /\b[a-f0-9]{7,40}\b/.test(text)                                // commit sha
      || /\b(?:lighthouse|p95|p99|qps|throughput)[\s:=]+\d+/i.test(text) // benchmark
      || /\b(GET|POST|PUT|DELETE|PATCH)\s+\/[^\s]+\s*→\s*\d{3}\b/.test(text) // HTTP test
}
```

Every `met` or `partial` criterion must cite at least one valid evidence form.
Regex check is deterministic — LLM cannot self-certify without proof.

### 5.3 Condition #3 — Weighted score ≥ threshold

```ts
score = sum(weight * statusValue) / sum(weight)
where statusValue = met ? 1.0 : partial ? 0.5 : 0
```

Default threshold = 0.9, configurable via `--done-threshold` flag in range
[0.7, 1.0]. Hard floor 0.7 prevents user shipping junk.

### 5.4 Condition #4 — PO ↔ Customer consensus debate

```ts
if (po.modelId === customer.modelId) return { pass: false, reason: "echo_chamber" }
```

Same-model = hard refuse (raising rounds doesn't add signal).

Cross-model variants graceful:
- Cross-provider → ideal, 1-round consensus accepted
- Same provider, different tier → 3-round consensus required
- Same provider, same tier, different model → 5-round consensus + explicit dissent required

Debate inputs: ProductSpec, criteria report, last verify result. Both roles
asked: "Should we ship?" Consensus on "ship" = pass; any other consensus or
no consensus = fail with reason.

### 5.5 Condition #5 — User final approval

Standard `council_preflight` card with full summary (score, criteria status,
cost, files, last verify). User reject → loop continues with feedback as
sprint context.

### 5.6 Continue feedback

When verdict = `continue`, the failed condition's reason is fed into the next
sprint's plan context:

| Failed at | Next sprint focus |
|---|---|
| #1 | "fix verify failures" + paste lastVerify.detail |
| #2 | "evidence missing for criteria X, Y" — Tester role assigned |
| #3 | "score 76%, gap = unmet criteria [X, Y, Z]" — PO prioritize |
| #4 | "Customer disagrees: <reason>" — Architect/Implementer iterate |
| #5 | "user feedback: <text>" — full re-plan |

---

## 6. Roles + Cost Scoping

### 6.1 Role registry (6 slots)

```ts
type RoleSlot = "PO" | "Architect" | "Implementer" | "Tester" | "Reviewer" | "Customer"

interface RoleBinding {
  slot: RoleSlot
  modelId: string
  provider: ProviderId
  tier: "fast" | "balanced" | "premium"
  memoryFile: string
  systemPrompt: string
}
```

### 6.2 Tier preference (cold start)

```ts
const ROLE_TIER_PREF: Record<RoleSlot, Tier[]> = {
  PO:          ["premium", "balanced"],
  Architect:   ["premium", "balanced"],
  Implementer: ["balanced", "fast", "premium"],
  Tester:      ["balanced", "premium"],
  Reviewer:    ["premium", "balanced"],
  Customer:    ["premium", "balanced"],
}
```

EE `routeModel()` overrides cold-start preference once it has data.

### 6.3 Resolution algorithm

Pass 1: cross-provider for PO ↔ Customer (anti-echo strongest).
Pass 2: same-provider with strict model uniqueness (`usedModels` Set).
Pass 3: refuse if PO.modelId === Customer.modelId.

If provider has ≤5 models → impossible to assign 6 unique → refuse start,
prompt user to add second provider key.

### 6.4 Per-product cost scope

Two-cap interaction inside `src/usage/ledger.ts`:
- Monthly cap (existing): user's overall budget
- Per-product cap (new): scoped to one `productRunId`

```ts
interface Reservation {
  provider: ProviderId
  model: string
  estUsd: number
  productRunId?: string  // null = ad-hoc usage
}

function commitToProduct(reservationId, productRunId, actualUsd) {
  commitMonthly(reservationId, actualUsd)
  appendToProductLedger(productRunId, actualUsd)
}
```

Storage: `~/.muonroi/usage/products/<runId>.jsonl` append-only.
Each event writes to BOTH monthly (existing) AND product ledger.
Halt on whichever cap is hit first.

### 6.5 Sprint cost projection (CB-1 input)

```ts
function projectSprintCost(runId: string): number {
  const history = readIterations(runId)
  if (history.length === 0) return baselineFromSpec(readSpec(runId))
  const recent = history.slice(-3).map(s => s.actualCost)
  const ewma = recent.reduce((avg, c) => avg * 0.7 + c * 0.3, recent[0])
  return ewma * 1.2  // 20% safety margin
}
```

EWMA captures growth (new sprints touch more files) and convergence (fewer
changes near done).

---

## 7. CLI + Integration

### 7.1 Slash commands

| Command | Action |
|---|---|
| `/ideal "<idea>"` | Start new product run |
| `/ideal status` | List active runs |
| `/ideal status <runId>` | Detail of one run |
| `/ideal resume <runId>` | Resume halted/crashed run |
| `/ideal abort <runId>` | Hard kill |
| `/ideal ship <runId>` | Force user-approve gate (skip if #1-#4 pass) |

### 7.2 Flags

| Flag | Default | Range |
|---|---|---|
| `--max-cost <usd>` | 50 | 1 – 1000 |
| `--max-sprints <n>` | 8 | 1 – 20 |
| `--done-threshold <0..1>` | 0.9 | 0.7 – 1.0 |
| `--stack <hint>` | none | free text |

`MUONROI_DEV=1` env var (NOT a CLI flag) enables `--no-customer-debate` for
internal testing only. Not exposed in `--help`. Skipping Condition #4 removes
the only structural anti-echo enforcement at done-gate, so it remains a
dev-only escape hatch.

### 7.3 Orchestrator wiring

Pattern mirrors `runCouncilV2` in `src/orchestrator/orchestrator.ts:2037`:

```ts
async *runProductLoopV1(idea: string, flags: ProductLoopFlags, options?) {
  const { runProductLoop } = await import("../product-loop/index.js")
  const llm = createCouncilLLM(this.bash, this.mode, this.session?.id, productStats)
  const gen = runProductLoop({
    idea, flags,
    sessionModelId: this.modelId,
    cwd: this.bash.getCwd(),
    sessionId: this.session?.id,
    llm,
    processMessageFn: (m) => this.processMessage(m, options?.observer),
    respondToQuestion: this._createQuestionResponder(),
    respondToPreflight: this._createPreflightResponder(),
  })
  for await (const chunk of gen) yield chunk
}
```

### 7.4 TUI rendering

Reuse 3 card types:
- `council_question` (gather + Customer debate)
- `council_preflight` (spec approve, ship approve, circuit prompts)
- New `product_status_card` — sprint progress + cost progress + criteria checklist (rendered from `state.md` + `gray-areas.md`)

### 7.5 EE integration touchpoints (zero edits)

1. PIL Layer 5 reads `state.md` Resume Digest → enriches every prompt during loop
2. Phase tracker auto-detects sprint boundary from `iterations.md` append → posts `phase-outcome`
3. EE intercept fires PreToolUse warnings during Implementer's tool calls
4. Mistake detector learns from failed sprint outcomes
5. EE judge worker promotes successful patterns to T0/T1 via retrospective

### 7.6 Update 2026-05-15 — EE-native T0 path (commits f22f7f0 .. a4d3e30)

**Cross-run memory redesign.** The filesystem manifest store (`runs/{runId}/manifest.md`, 
`roadmap.md`, `iterations.md`, `state.md`) is now **audit log only**, not a prompt source.

#### Extract on termination
On run termination (shipped success or user abort), `extractRunToEE()` posts the full 
run transcript to EE `/api/extract` (src/product-loop/index.ts, P1.3). EE's `evolve()` 
pipeline promotes the extracted artifact: T3 raw → T1 behavioral → T0 principle (per 
`experience-engine` promotion rules). Transport is non-fatal (offline-queue if client 
goes down).

#### Semantic injection at query time
On subsequent `/ideal` runs (or any LLM call), PIL Layer 3 (`src/pil/layer3-ee-injection.ts`) 
pulls relevant T0/T1 principles semantically via `/api/search` against Qdrant. Score floor 
is 0.55 (mirrored from `minConfidence`). Injected into the system prompt per LLM call — 
no static digest, no leader synthesis.

#### Audit surface
The `state.md` section `EE Injections (Layer 3)` is now the truth table: it reads live 
from `interaction_logs` (via `selectEEInjectionsForRun()` in interaction-log.ts) and shows 
when principles were surfaced and from which extract outcomes. Users see the injection events 
without needing to query the EE API directly.

#### buildPriorContext refactor
`buildPriorContext()` still returns `runs.length` for the discovery card, but the static 
digest that was appended to `conversationContext` is dropped. Semantic injection already 
handles per-LLM-call enrichment via PIL Layer 3, so the static digest was duplicating work 
and growing the system prompt unbounded (P1.4). The function signature is preserved for 
loop-driver.ts compatibility; deprecated flags (`leaderModelId`, `llm`) will be pruned in 
P2 cleanup.

### Update 2026-05-15 — Complexity routing (P2)

**Purpose:** Skip Council debate and sprint ceremony for low-complexity ideation tasks. Route 
simple edits (typo fixes, doc updates, rename refactors) to single-sprint hot-path without 
multi-model debate overhead.

#### Scoring heuristic (Layer 1)
`src/pil/layer1-intent.ts:scoreComplexity()` is a pure function that assigns low / medium / high 
based on idea text alone — no LLM call, no disk I/O.

**Input signals** (sourced from parsed plan):
- `planLength` ≤ 300 chars: -1 per each signal
- `fileReferenceCount` (regex `src/.*\.(ts|tsx|...)`) < 2: -1
- Regex `(fix|typo|rename)`: -1
- `taskType === "debug"`: +1
- `hasMaxSprintsOne` (user set `--max-sprints 1`): -2
- `t0HitCount` (EE injections matched): -1

**Score brackets:** ≤2 `low`, 3–5 `medium`, ≥6 `high`.

#### Dispatcher (product-loop/index.ts)
- `complexity === "low" && !flags.forceCouncil` → call `runHotPath()` (skips gather, research, 
  scoping; runs 1 sprint with no Council, no preflight debate, direct ship)
- Else → existing `runStart()` flow (gather → research → scoping → sprint-loop)

#### Opt-out flag
`--force-council` boolean (slash parser + CLI) opts out of hot-path routing. Useful when 
heuristic is wrong and user wants full ceremony.

#### Telemetry
`interaction_logs` row with `event_type="routing"`, `event_subtype="ideal_hot_path"` logged 
per hot-path invocation. Payload includes final complexity score and skipped stages.

#### Cross-run memory unaffected
`extractRunToEE()` still fires on hot-path ship/abort; EE extraction and T0 principle 
promotion work identically to full-ceremony runs. No special handling per hot-path.

**Reference:** commit `2faf34d`.

---

## 8. Anti-Hallucination Layers (summary)

| Layer | Mechanism | Where |
|---|---|---|
| L1 — Reality Anchor | Evidence regex check on every criteria status flip | done-gate Cond #2 |
| L2 — Engineering floor | Verify recipe must pass with non-zero coverage | done-gate Cond #1, CB-3 |
| L3 — Cross-model debate | PO ↔ Customer must use distinct models | done-gate Cond #4 |
| L4 — Deterministic judge | EE judge.ts already FOLLOWED/IGNORED/IRRELEVANT (no LLM) | per tool call |
| L5 — Prompt-stale reconciliation | EE auto-marks injected points stale on outcome mismatch | EE existing |
| L6 — User gate | Final user approval before ship | done-gate Cond #5 |

L1+L2+L3 are NEW; L4+L5+L6 reuse existing infrastructure.

---

## 9. Risks

### R1: Recipe coverage detection unreliable
`src/verify/recipes.ts` may not return coverage for every project type.
**Mitigation:** Treat missing coverage as `coverage=0` → CB-3 halts. Force user
to declare a recipe explicitly for unsupported project types.

### R2: PO + Customer same provider only
If user has only one API key, anti-echo is degraded to tier-only separation.
**Mitigation:** Loop start refuses if provider has <6 models, with clear
message to add a second provider key. Acceptable degraded mode otherwise
(tier separation + extra debate rounds).

### R3: Cost projection estimator drift
`chars/4` token estimator under-predicts reasoning models by 2–5×.
**Mitigation:** EWMA over last 3 actual sprint costs (after first sprint)
self-corrects. First sprint can overshoot; CB-1 catches overruns early.

### R4: Sprint determinism on resume
Council theoretically produces different output on same input due to LLM
sampling temperature. Resume re-runs may diverge from crashed sprint.
**Mitigation:** Document divergence. `iterations.md` records both sprints
with `crashed` flag on the first. User can manually inspect.

### R5: Customer debate cost on long products
Condition #4 runs every done-gate evaluation. If loop runs 10+ sprints,
Customer call cost compounds.
**Mitigation:** Skip Condition #4 when `score < 0.85` (save cost when
clearly not done). Only invoke at scores ≥ 0.85 where consensus is meaningful.

### R6: Per-role memory growth
Memory files appended every sprint, can grow indefinitely.
**Mitigation:** 2KB hard cap per slot, oldest sprint truncated first.

---

## 10. Open questions (resolved during brainstorm)

- ✓ Product done definition: 5-condition AND with engineering floor
- ✓ User intervention model: gates only + abort, no pause
- ✓ Approach: GSD/Flow pattern reuse (C)
- ✓ Clarify exit threshold: ≥85% (5/6 dimensions)
- ✓ Verify-blank policy: hard refuse, no force-continue
- ✓ Customer skip flag: env-var only (`MUONROI_DEV=1`), not CLI flag
- ✓ Same-model PO/Customer: hard refuse
- ✓ Done threshold: configurable [0.7, 1.0], default 0.9

---

## 11. Out of scope (explicitly)

- Multi-product parallel runs in same workspace (one active run at a time per cwd)
- Distributed execution across multiple machines
- Cloud deployment of generated product
- Real-time collaboration (multiple users on one run)
- Migration from existing repos (greenfield only in v1)

These may become v2 features after v1 stabilizes.
