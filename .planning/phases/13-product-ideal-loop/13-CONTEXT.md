# Phase 13: Product Ideal Loop — Context

**Gathered:** 2026-05-07
**Status:** Ready for planning
**Source:** PRD Express Path (`docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md`)

<domain>
## Phase Boundary

Ship a self-driving product loop accessible via `/ideal "<idea>"` slash command. The loop:

1. Gathers context interactively (6 seed dimensions, ≥85% threshold)
2. Debates feasibility with multi-role council (Researcher, Cost-Controller, Skeptic, Architect)
3. Produces a `ProductSpec` for user approval (preflight gate #1)
4. Runs sprint iterations (plan → implement → verify → judge) until either:
   - 5-condition Definition-of-Done passes, OR
   - A deterministic circuit breaker halts the run (cost / oscillation / verify-blank)
5. Holds a final user approval gate before "shipped"

Output: a working repo at the user's cwd. Deployment is out of scope. Greenfield only in v1.

**Caller, not replacement.** Council retains 1-shot semantics; product-loop calls `runCouncil()` once per sprint with carry-over context. Verify, EE, PIL, ledger reused as-is.

</domain>

<decisions>
## Implementation Decisions

### Module layout (locked)
- New `src/product-loop/` directory containing:
  - `index.ts` — `runProductLoop(opts)` entry point
  - `types.ts` — `ProductSpec`, `RoleSlot`, `IterationState`, `DoneVerdict`, `DoneCondition`, `WorkflowKind`
  - `loop-driver.ts` — Outer FSM (gather → research → scope → sprint × N → done)
  - `role-registry.ts` — 6-role registry with cross-tier resolution
  - `done-gate.ts` — 5-condition Definition-of-Done evaluation
  - `circuit-breakers.ts` — Cost / oscillation / verify-blank breakers
  - `cost-scoper.ts` — Per-product budget namespace inside ledger
  - `reality-anchor.ts` — Evidence-required wrapper around synthesis
  - `__tests__/` — Unit + integration tests

### Existing files to edit (locked LoC budgets)
- `src/gsd/types.ts` — Add `WorkflowKind = "task" | "product"` enum (~15 LoC)
- `src/flow/run-manager.ts` — Add `iterations.md` + `manifest.md` to RUN_FILES, helpers (~40 LoC)
- `src/usage/ledger.ts` — Add `productRunId` namespace param to reservation/commit (~30 LoC)
- `src/cli/commands.ts` — Register `/ideal` slash command + `status` / `resume` / `abort` / `ship` subcommands (~20 LoC)
- `src/orchestrator/orchestrator.ts` — Wire `runProductLoopV1` mirroring `runCouncilV2` at orchestrator.ts:2037 (~50 LoC)

**New code total:** ~1200 LoC. **Edits:** ~155 LoC.

### Reused as-is (zero edits)
- `src/council/` — invoked per sprint as planner
- `src/verify/orchestrator.ts` — engineering floor check
- `src/ee/phase-tracker.ts` + `phase-outcome.ts` — auto post iteration boundaries
- `src/ee/judge.ts` — deterministic FOLLOWED/IGNORED/IRRELEVANT classifier
- `src/ee/intercept.ts` + `posttool.ts` — PreTool warnings + PostTool reconciliation
- `src/pil/pipeline.ts` — runs as normal on every prompt (200ms hot-path preserved)
- `src/flow/artifact-io.ts` — atomic .md read/write

### Run artifact layout (locked)
Each `/ideal` invocation creates one GSD run at `.muonroi-flow/runs/<runId>/` with 6 files:
- `roadmap.md` — Product Spec (extend) — features, architecture, I/O contract, folder structure
- `state.md` — Active sprint, scores, cost, circuit status, last verify, Resume Digest (extend)
- `delegations.md` — Role registry: 6 slots → modelId per sprint (extend)
- `gray-areas.md` — Success criteria checklist with status + evidence (extend) — single source of truth for done-gate Cond #3
- `iterations.md` — Append-only sprint history (NEW)
- `manifest.md` — Product metadata: idea text, cap, createdAt, doneAt, verdict (NEW)

Per-role memory at `runs/<id>/memory/<slot>.md`. Append-only per sprint, 2KB hard cap per slot, oldest truncated first.

### Lifecycle FSM (locked)
States: `idle` → `gather` → `research` → `scoping` → `approved` → `sprint-N: plan` → `sprint-N: implement` → `sprint-N: verify` → `sprint-N: judge` → (`retrospective` | `halted` | `sprint-N+1: plan`) → `shipped`.

User actions during loop: exactly one — `/abort`. NO pause, NO mid-loop edit.

### Gather stage (locked)
Reuse council clarifier (max 6 rounds). 6 seed dimensions cứng (NOT LLM-generated):
1. **persona** — Who are the primary users?
2. **core-features** — Top 3 must-have features?
3. **non-functional** — Performance / privacy / offline / scale targets?
4. **tech-constraints** — Language / framework / existing repo?
5. **success-metric** — How is "done" measured?
6. **cost-tolerance** — Hard cap or soft target?

Exit when ≥5/6 resolved (≥85%). At round 6 with <5 resolved → refuse advance, prompt manual answers.
Confidence metric is `unresolvedDimensions.length`, NOT PIL classifier confidence.

### Research stage (locked)
Council debate with 4 leader-proposed stances: Researcher, Cost-Controller, Skeptic, Architect. Reuses `src/council/debate.ts` dynamic round system (no hardcoded 2-round cap; leader evaluates each round, dynamic exit).

### Scoping stage (locked)
Leader synthesis → ProductSpec JSON written to `roadmap.md` with fields: `mvp[]`, `phase2[]`, `architecture`, `ioContract`, `folderStructure`, `sprintEstimate`, `costEstimate`. User preflight #1: approve / reject / edit-spec.

### Done-Gate (5 AND conditions, locked, cost-ascending order)

1. **Engineering floor** — `recipe !== null && recipe.testCommand !== null && recipe.coverage > 0 && lastVerify.result === "PASS"`. Failure reasons: `no_recipe`, `zero_coverage`, `verify_<result>`.
2. **Evidence regex** — Every `met` or `partial` criterion must cite evidence matching at least one of: `file:line` (e.g., `src/sync.ts:42`), test name (`test('...')` / `describe('...')`), commit sha (7-40 hex), benchmark (`lighthouse|p95|p99|qps|throughput[\s:=]+\d+`), HTTP test (`(GET|POST|PUT|DELETE|PATCH) /path → \d{3}`).
3. **Weighted score ≥ threshold** — `score = sum(weight * statusValue) / sum(weight)` where `statusValue = met:1 | partial:0.5 | unmet:0`. Default threshold 0.9, configurable via `--done-threshold` in `[0.7, 1.0]`. Hard floor 0.7.
4. **PO ↔ Customer cross-model debate** — Same model = hard refuse (`echo_chamber`). Cross-provider → 1-round consensus. Same provider, different tier → 3-round consensus. Same provider, same tier, different model → 5-round consensus + explicit dissent. Both asked: "Should we ship?" — consensus on "ship" = pass. Skip Cond #4 when score < 0.85 (cost optimization R5).
5. **User final approval** — Standard `council_preflight` card with full summary. Reject → continue with feedback as next sprint context.

### Continue feedback routing (locked)
| Failed condition | Next sprint focus |
|---|---|
| #1 | "fix verify failures" + paste lastVerify.detail |
| #2 | "evidence missing for criteria X, Y" — Tester role assigned |
| #3 | "score N%, gap = unmet criteria [X, Y, Z]" — PO prioritize |
| #4 | "Customer disagrees: <reason>" — Architect/Implementer iterate |
| #5 | "user feedback: <text>" — full re-plan |

### Circuit breakers (deterministic, locked)
- **CB-1 Cost**: `projectedNextSprintCost = EWMA(last 3 sprint costs) * 1.2`. Halt if `> (capUsd - spentUsd) * 1.5`.
- **CB-2 Oscillation**: `if sprintN >= 3 && delta_t <= 0 && delta_t-1 <= 0` → halt. 2-sprint streak with non-positive criteria delta.
- **CB-3 Verify-blank**: `if sprintN === 1 && (recipe === null || recipe.coverage === 0)` → halt. Hard refuse only — no force-continue.

### Halt vs Abort (locked)
- `halted` → triggered by circuit breaker. User options: continue / abort / raise budget. Resumable.
- `aborted` → triggered by `/abort`. Final. Write `manifest.md aborted=true`, post EE `phase-outcome=aborted`. NO pause action.

### Resume contract (locked)
`muonroi ideal resume <runId>`:
1. `loadRun(flowDir, runId)` reconstructs all 6 files
2. Parse `state.md` for `currentStage` + `currentSprint`
3. Stage ∈ {gather, scoping} → re-enter at start of stage
4. Stage = sprint in flight → re-run sprint from start (council deterministic on same spec; document divergence risk R4)
5. Cost spent NOT refunded
6. Old crashed sprint marked in `iterations.md` with `crashed` flag
7. EE post `phase-outcome=resumed`

### Role registry (locked)
6 slots: `PO | Architect | Implementer | Tester | Reviewer | Customer`.

Tier preference (cold start):
- PO, Architect, Reviewer, Customer: `["premium", "balanced"]`
- Implementer: `["balanced", "fast", "premium"]`
- Tester: `["balanced", "premium"]`

EE `routeModel()` overrides cold-start preference once it has data.

Resolution algorithm:
- Pass 1: cross-provider for PO ↔ Customer (anti-echo strongest)
- Pass 2: same-provider with strict model uniqueness (`usedModels` Set)
- Pass 3: refuse if `PO.modelId === Customer.modelId`
- If provider has ≤5 models → refuse start, prompt user to add second provider key

### Cost scoping (locked)
Two-cap interaction in `src/usage/ledger.ts`:
- Monthly cap (existing) — user's overall budget
- Per-product cap (new) — scoped to `productRunId`

`Reservation` gains optional `productRunId`. `commitToProduct(reservationId, productRunId, actualUsd)` writes to BOTH monthly + product ledger. Halt on first cap hit.

Storage: `~/.muonroi/usage/products/<runId>.jsonl` append-only.

### CLI surface (locked)
| Command | Action |
|---|---|
| `/ideal "<idea>"` | Start new product run |
| `/ideal status` | List active runs |
| `/ideal status <runId>` | Detail of one run |
| `/ideal resume <runId>` | Resume halted/crashed run |
| `/ideal abort <runId>` | Hard kill |
| `/ideal ship <runId>` | Force user-approve gate (skip if #1-#4 pass) |

Flags:
| Flag | Default | Range |
|---|---|---|
| `--max-cost <usd>` | 50 | 1 – 1000 |
| `--max-sprints <n>` | 8 | 1 – 20 |
| `--done-threshold <0..1>` | 0.9 | 0.7 – 1.0 |
| `--stack <hint>` | none | free text |

`MUONROI_DEV=1` env var (NOT a CLI flag, NOT in `--help`) enables `--no-customer-debate`. Dev-only escape hatch since it removes the only structural anti-echo enforcement at done-gate.

### Orchestrator wiring (locked)
Mirrors `runCouncilV2` at `src/orchestrator/orchestrator.ts:2037`:
```ts
async *runProductLoopV1(idea: string, flags: ProductLoopFlags, options?) {
  const { runProductLoop } = await import("../product-loop/index.js")
  const llm = createCouncilLLM(this.bash, this.mode, this.session?.id, productStats)
  const gen = runProductLoop({ idea, flags, ...llm, processMessageFn, respondToQuestion, respondToPreflight })
  for await (const chunk of gen) yield chunk
}
```

### TUI rendering (locked)
Reuse 3 card types:
- `council_question` (gather + Customer debate)
- `council_preflight` (spec approve, ship approve, circuit prompts)
- NEW `product_status_card` — sprint progress + cost progress + criteria checklist (rendered from `state.md` + `gray-areas.md`)

### EE integration touchpoints (zero edits)
1. PIL Layer 5 reads `state.md` Resume Digest → enriches every prompt during loop
2. Phase tracker auto-detects sprint boundary from `iterations.md` append → posts `phase-outcome`
3. EE intercept fires PreToolUse warnings during Implementer's tool calls
4. Mistake detector learns from failed sprint outcomes
5. EE judge worker promotes successful patterns to T0/T1 via retrospective stage

### Anti-Hallucination Layers
| Layer | Mechanism | New / Reused |
|---|---|---|
| L1 — Reality Anchor | Evidence regex on every criteria status flip | NEW (done-gate Cond #2) |
| L2 — Engineering floor | Verify recipe must pass with non-zero coverage | NEW (done-gate Cond #1, CB-3) |
| L3 — Cross-model debate | PO ↔ Customer must use distinct models | NEW (done-gate Cond #4) |
| L4 — Deterministic judge | EE `judge.ts` (already FOLLOWED/IGNORED/IRRELEVANT) | REUSED |
| L5 — Prompt-stale reconciliation | EE auto-marks injected points stale on outcome mismatch | REUSED |
| L6 — User gate | Final user approval before ship | NEW (done-gate Cond #5) |

### Claude's Discretion
- Internal naming of helper functions inside each new file
- Exact test layout within `__tests__/` (subfolder by module vs flat)
- Format/style of `iterations.md` entries beyond the schema in spec §3.1 (must remain machine-parseable for EE phase-tracker and CB-2 oscillation detection)
- Choice between in-memory FSM library vs hand-rolled switch in `loop-driver.ts`
- Concurrency model for per-product ledger writes (single-writer-per-run is sufficient since one run per cwd)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 13 design source
- `docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md` — full spec (614 lines, all decisions locked)

### Reused infrastructure (zero edits expected)
- `src/council/` — runCouncil, clarifier, debate, executor, leader-eval. Phase 13 calls these per sprint.
- `src/verify/orchestrator.ts` — `runVerifyOrchestration`. Used in sprint-N: verify and done-gate Cond #1.
- `src/verify/recipes.ts` — recipe loader. Determines `recipe.coverage` for CB-3 and Cond #1. **R1 risk source.**
- `src/ee/phase-tracker.ts` + `src/ee/phase-outcome.ts` — auto-posts on sprint boundary detection.
- `src/ee/judge.ts` — deterministic classifier. Underpins L4 anti-hallucination.
- `src/ee/intercept.ts` + `src/ee/posttool.ts` — PreTool/PostTool hooks fire during Implementer execution.
- `src/pil/pipeline.ts` — preserves 200ms hot-path during loop. PIL Layer 5 (resume) consumes `state.md` Resume Digest.
- `src/flow/artifact-io.ts` — atomic `.md` read/write. All 6 run files use this.
- `src/flow/run-manager.ts` — `loadRun`, `RUN_FILES`. Phase 13 extends `RUN_FILES` to include `iterations.md` + `manifest.md`.

### Files Phase 13 will modify
- `src/gsd/types.ts` — add `WorkflowKind`
- `src/flow/run-manager.ts` — extend `RUN_FILES` + helpers
- `src/usage/ledger.ts` — add `productRunId` namespace
- `src/cli/commands.ts` — register `/ideal`
- `src/orchestrator/orchestrator.ts` — add `runProductLoopV1` (mirror of `runCouncilV2` at line 2037)

### Existing pattern to mirror
- `src/orchestrator/orchestrator.ts:2037` — `runCouncilV2` is the canonical wiring template for Phase 13's `runProductLoopV1`

</canonical_refs>

<specifics>
## Specific Ideas

### Schema examples to follow exactly
- `iterations.md` per-sprint format (spec §3.1) — must remain machine-parseable for EE phase-tracker boundary detection AND CB-2 oscillation `delta_t` extraction
- `gray-areas.md` criteria block format (spec §3.2) — must include `Status:`, `Evidence:`, `Sprint:` lines for done-gate Cond #2 regex check
- `state.md` Resume Digest block (spec §3.3) — consumed by PIL Layer 5

### Cost projection formula (CB-1 input)
```ts
recent = history.slice(-3).map(s => s.actualCost)
ewma = recent.reduce((avg, c) => avg * 0.7 + c * 0.3, recent[0])
projection = ewma * 1.2  // 20% safety margin
```
First sprint uses `baselineFromSpec(readSpec(runId))` since no history.

### Evidence regex (Cond #2) — exactly five forms
```ts
function evidenceLooksValid(text: string): boolean {
  return /\b\w+\.(ts|tsx|js|py|go|rs|java):\d+/.test(text)
      || /\btest\(['"`].+['"`]\)|describe\(['"`].+['"`]\)/.test(text)
      || /\b[a-f0-9]{7,40}\b/.test(text)
      || /\b(?:lighthouse|p95|p99|qps|throughput)[\s:=]+\d+/i.test(text)
      || /\b(GET|POST|PUT|DELETE|PATCH)\s+\/[^\s]+\s*→\s*\d{3}\b/.test(text)
}
```

### Plans expected (non-binding sketch — gsd-planner finalizes)
The spec hints at ~5 logical chunks. A reasonable breakdown:
1. **13-01**: Types + run-manager extensions + `manifest.md`/`iterations.md` artifact IO
2. **13-02**: Role registry + cross-tier resolution + per-role memory
3. **13-03**: Loop driver FSM + gather/research/scoping stages
4. **13-04**: Done-gate (5 conditions) + reality-anchor + circuit breakers
5. **13-05**: Cost-scoper + ledger integration + EE phase-tracker boundary wiring
6. **13-06**: CLI command + orchestrator wiring + `product_status_card` TUI + integration tests

gsd-planner should validate this breakdown against dependency order and may consolidate or split as needed.

</specifics>

<deferred>
## Deferred Ideas

### Out of scope (explicitly, spec §11)
- Multi-product parallel runs in same workspace (one active run at a time per cwd)
- Distributed execution across multiple machines
- Cloud deployment of generated product
- Real-time collaboration (multiple users on one run)
- Migration from existing repos (greenfield only in v1)

These may become v2 features after v1 stabilizes.

### Risks acknowledged but mitigated in v1
- **R1**: Recipe coverage detection unreliable for some project types → treat missing coverage as `coverage=0`, force user to declare recipe explicitly
- **R2**: Single-provider degraded mode → refuse start if provider has <6 models; clear message to add second provider key
- **R3**: Cost projection drift on reasoning models → EWMA self-corrects after sprint 1; CB-1 catches overruns
- **R4**: Sprint determinism on resume → document divergence; record both sprints in `iterations.md` with `crashed` flag
- **R5**: Customer debate cost on long products → skip Cond #4 when score < 0.85
- **R6**: Per-role memory growth → 2KB hard cap per slot, oldest sprint truncated first

</deferred>

---

*Phase: 13-product-ideal-loop*
*Context gathered: 2026-05-07 via PRD Express Path*
*Source spec: docs/superpowers/specs/2026-05-07-product-ideal-loop-design.md*
