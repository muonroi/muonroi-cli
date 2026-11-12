# FLOW pipeline & BB-aware `/ideal` — architecture notes

> Moved out of `CLAUDE.md` (2026-11-06).

## BB-aware `/ideal`

When the scaffold target resolves to `muonroi-building-block` (BB) — i.e., presence of `Directory.Build.props` + `*.sln` + any `src/Muonroi.*` directory — `/ideal` injects BB-specific context into the council system prompt at CB-1. Key files:

- `src/ee/bb-retrieval.ts` — `fetchBBContext(prompt, opts)` queries EE collections `bb-recipes`, `bb-behavioral`, `experience-principles` in parallel with retry-once + graceful degrade. Token budget 1500. Marker-stamped output for Layer 3 dedup.
- `src/product-loop/loop-driver.ts` — CB-1 entry point that injects the retrieved BB context BEFORE council debate fires.
- `src/pil/layer3-ee-injection.ts` — scans `ctx.enriched` for `<!-- bb-context-injected:<sha> -->` markers and skips already-injected hits.
- `src/pil/layer3-ee-injection.ts` (ee-anti-mu) — also extracts `<!-- ee-checkpoint-injected:<sha> -->`, injects formatTaskCheckpoints from behavioral search for "Context checkpoint summary", enriches layer1 raw for long sessions, and supports ee.query (MCP) for explicit "recent task checkpoint Progress DONE".
- `src/scaffold/init-new.ts` — detects BB target heuristically, sets `IntentDetectionTrace.targetFramework = "muonroi-building-block"`.
- `src/scaffold/bb-ecosystem-apply.ts` — applies senior-bar code-gen (Program.cs wiring, sample rule + test, props minimalism, modular-boundaries gate).
- `src/scaffold/bb-quality-gate.ts` — runs `dotnet restore` + `dotnet build` + `check-modular-boundaries.ps1` + sentinel regex check after scaffold.
- `src/scaffold/resume-from-gate-failures.ts` — `/ideal --resume <path>` re-enters CB-1 with `EE-GATE-FAILURES.md` context.

Ingestion + collection layout: `docs/agent-harness/EE-INGESTION.md`.

EE failure-mode reference (what every call site does when EE is down):
`docs/ee/EE-DOWN-BEHAVIOR.md`.

Feature flag: `userSettings.eeBBContext: false` to disable BB retrieval.

## Native FLOW depth pipeline & the hard mutation gate

FLOW is **native to the runtime**, not the external superpowers skill. Depth is
agent-decided and variable — `quick` | `standard` | `heavy` | (none) — and every
stage consumes the prior stage's artifact, so the flow is one continuous pipeline
built on the native Muonroi Flow engine (`src/workflow/`), never a workaround around it.

**The one depth slot everything reads.** layer1 model-first classify emits
`pilCtx.modelDepthTier` + `pilCtx.confidence` (`src/pil/layer1-intent.ts`) →
`syncWorkflowContext(cwd, model, depth)` in `src/orchestrator/message-processor.ts`
→ SDK `setStateField` writes `Depth` into `.planning/STATE.md`. Downstream code
reads depth via `readState(cwd).depth`, never off a propagated pilCtx field.

**Pipeline stages (each feeds the next):**

1. **Complexity assessor** (`src/workflow/complexity-assessor.ts`) — a leader-tier
   single-shot call (`createCouncilLLM(...).generate`, billed `source=council`,
   no cost leak) that *enriches the same* `modelDepthTier` slot. `shouldAssess`
   pre-filters: standard/heavy always assess, low-confidence (<0.7) quick
   assesses, high-confidence quick skips. NEVER throws (parse/leader failure →
   `parse-failed-fallback`). Writes `.planning/ASSESSMENT.md`.
2. **Council context** (`src/workflow/council-context.ts`) folds `ASSESSMENT.md`
   into `buildCouncilContextBundle`, so plan-review AND verify councils both see
   the assessment rationale — pipeline coherence.
3. **Directive** (`src/pil/layer4-flow.ts`) is emitted during PIL prep — i.e.
   *before* the assessor runs — so it is keyed on the layer1 classify depth,
   NOT the assessed depth (the assessor override reaches the gate + `flow_verify`
   via STATE.md / `pilCtx.modelDepthTier`, not this directive). heavy →
   MANDATORY `flow_status → flow_discuss → flow_plan → flow_plan_review`, mutation
   tools BLOCKED until plan-review passes; standard → advisory
   ("recommend flow_plan_review", no BLOCKED); quick → no gate. The mutation
   gate is coherent with this: it hard-blocks on **heavy only** (`quick` /
   `standard` / null all fail open). standard stays advisory — hard-blocking
   every default-tier bash/edit until a plan-review pass over-reaches; only
   genuinely non-trivial work (heavy, including tasks the assessor UPGRADES to
   heavy) earns the hard gate.
4. **Mutation gate** (`src/workflow/mutation-gate.ts`) — `evaluateMutationGate` runs
   inside the tool-engine write-mutex wrapper (`src/orchestrator/tool-engine.ts`)
   before every non-read-only, non-`respond_`, non-`flow_*` tool. It reads depth
   from `readState(cwd).depth` and **delegates to the SDK's `canExecute(cwd,
   depth)`** — no reimplemented gate. Fail-open: only an explicit `heavy` depth
   arms it; `standard` logs an advisory line and passes, `null`/`quick` pass
   through (`mutation-gate.ts:86-101`). Blocked → `{success:false, output, error}`
   BEFORE the mutation runs. Also called from `stream-runner.ts:696` and
   `tool-engine.ts:1499`.
5. **Verify layer** (`flow_verify` in `src/workflow/workflow-tools.ts`) — deterministic
   floor first (tests/lint evidence); if the floor passes at standard/heavy,
   `runVerifyCouncil` (`src/workflow/verify-council.ts`) adjudicates goal-achievement
   and its verdict **overrides** the model's self-reported `passed`. Parse
   failure → `revise`, never a silent approve. Writes `.planning/VERIFY-COUNCIL.md`.

**Env flags** (all default ON with native FLOW; opt out with `=0`), defined in
`src/workflow/flags.ts`:

| Flag | Effect |
|---|---|
| `MUONROI_FLOW_NATIVE=0` | Disable native FLOW entirely → legacy playbook rubric, no `flow_*` tools. |
| `MUONROI_FLOW_ASSESSOR=0` | Skip the leader-tier assessor; depth comes only from layer1 classify. |
| `MUONROI_FLOW_HARD_GATE=0` | Disable the mutation gate; directives become advisory-only. |

**Plan-review convergence** (`src/workflow/plan-review-convergence.ts`, knobs in
`src/workflow/review-budget.ts`). Every recorded review appends a round to
`.planning/PLAN-REVIEW-ROUNDS.json`. The loop is settled by the HOST when the round
allowance is spent without a pass, when the same blocking objection stays open across
`allowance` consecutive reviews, or when the same objections are re-raised on an
unchanged plan. Default settlement = admit the plan with the unresolved findings kept
OPEN in `PLAN-FINDINGS.json` (the verify council reads them); `PLAN-VERIFY.md` records
`admissionMethod: convergence-settlement` and a `toast` LiveEvent announces it. Never
asks the user (no blocking card). Allowance: env `MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS`
→ `.planning/config.json` `workflow.plan_review_max_rounds` → 3. Policy: env
`MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION` → `workflow.plan_review_on_exhaustion` →
`proceed` (`stop` = old refuse-and-report). E2E: `tests/harness/plan-review-convergence.spec.ts`.

E2E coverage of the deterministic gate: `tests/harness/flow-hard-gate.spec.ts`
(seeds `.planning/STATE.md` in a throwaway temp cwd; assessor OFF for
determinism). Gate/assessor/verify logic is unit-covered under `src/workflow/__tests__/`.

## Orchestrator FLOW tools and the host autopilot (`/ideal`)

**The orchestrator records phase transitions itself.** `flow_execute`, `flow_verify`
and `flow_ship` are in `ORCHESTRATION_TOOLS` (`src/orchestrator/orchestration-policy.ts`);
workers still cannot call any `flow_*` tool. The orchestrator dispatches the work and
the independent check to workers, then records the outcome: `flow_verify(passed, evidence)`
keeps the deterministic floor (`passed=true` needs evidence), runs the verify council at
standard/heavy depth (its verdict overrides `passed`) and writes `VERIFY.md`
(`verdict: pass|fail`). A recorded `pass` is `implementationVerification=recorded_pass`,
which is what `context_load(root_status="complete")` requires when the session owns a
native plan (`working-context.ts`). Session 55c5b65b6938 could never close because the
orchestrator had no `flow_verify`. Unit evidence:
`src/orchestrator/__tests__/orchestrator-flow-verify-completion.test.ts`.

**The host starts the next turn.** For an orchestrator-role `/ideal` run, when a turn
ends and the run is not done the HOST starts the next turn (`src/orchestrator/ideal-autopilot*.ts`;
the UI only applies the decision, `use-app-logic.tsx` `idealAutopilotStepRef`). No prose in
the model contract asks it to keep going. The continuation is a visible host entry
(`⟲ /ideal autopilot — turn N/M`) with a short fact-only prompt tagged
`[host: /ideal autopilot, turn N/M]`. Stop conditions, first match wins:

| Reason | Rule |
|---|---|
| `user_message` / `user_interrupt` / `user_abort` | The user always wins: a typed message, Esc/Ctrl+C, or `/ideal abort` stops it at once (applied when the user acts, also between turns). `/ideal status` does not. |
| `error` | The turn ended in a hard error, or the delegation ledger was unreadable. |
| `needs_human` | A card (askcard, preflight, tool-loop/safety/approval card) is waiting. Never auto-answered. |
| `complete` | Root goal closed: `root_status=complete` on the ledger and, when a native plan exists, `recorded_pass`. Success exit. |
| `budget_cost` / `budget_wall` | Spend (usage_events + worker cost-log rows) or wall minutes of the current budget window reached the cap. |
| `no_progress` | N consecutive turn ends (workers not running) with no file change, no delegation started/finished, and no FLOW change (phase, plan verified, implementation verification, PLAN.md/VERIFY.md mtime). Host-owned paths (`.muonroi-cli/`, `.planning/`, `.muonroi-flow/`) are excluded from the file signal. Waiting on running workers is not a stall. |
| `autowake_off` | Workers are running but `MUONROI_BACKGROUND_AUTOWAKE=0`, so nothing would continue the run. |
| `budget_turns` | `maxTurns` host-started turns in the window. |

While workers run the autopilot just waits: each result wakes the model (existing
auto-wake) and that turn's end is evaluated again.

Knobs (env wins over `settings.json` `idealAutopilot.*`; `0` = no limit for turns/wall/cost):

| Env | Setting | Default |
|---|---|---|
| `MUONROI_IDEAL_AUTOPILOT=0` | `enabled` | on |
| `MUONROI_IDEAL_AUTOPILOT_MAX_TURNS` | `maxTurns` | 40 host-started turns per window |
| `MUONROI_IDEAL_AUTOPILOT_MAX_COST_USD` | `maxCostUsd` | no cap (the standing "/ideal has no spend cap" decision) |
| `MUONROI_IDEAL_AUTOPILOT_MAX_WALL_MIN` | `maxWallMinutes` | 240 |
| `MUONROI_IDEAL_AUTOPILOT_NO_PROGRESS` | `noProgressTurns` | 3 |

State rides in the `__ideal_run` record (`autopilot`: status, window start, turns,
no-progress streak, last signals, spend, stop reason), so it survives a restart.
`/ideal start` and `/ideal resume` open a fresh budget window (resume keeps the total turn
count and clears the stop); a restart alone never starts a turn — only a human action does.
`/ideal status` prints the `Autopilot:` line with the stop reason. LiveEvents: `ideal-autopilot`
(`start` | `continue` | `wait` | `stop`, with `reason` on stop) and, for the terminal stop, `run-finished`
(`complete` → `outcome=approved`, `error` → `error`, anything else → `halted`; `reason` = the stop code).
E2E: `tests/harness/ideal-autopilot.spec.ts`.

## Host deliverable gate and fidelity probe

Every other gate checks the PROCESS; this one checks the DELIVERABLE against the request, from
git and the filesystem, not from any model's claim. Evidence: session 26516fe0c62e passed verify
with 274 literal `\_` and ~12 `&lt;`/`&gt;` inside code spans (docs conversion, no source-vs-output
comparison anywhere); run 0a0d0430e149's prompt said "Commit message ..." and it produced 0 commits
(deliverables untracked, `docs/` gitignored) yet ended in a final answer.

`Agent.deliverableReport()` (`orchestrator.ts`) builds the input and calls `collectDeliverableReport`
(`src/orchestrator/deliverable-gate.ts`):

- Goal texts = the `/ideal` run goal + the pinned root goal + ledger constraints/open items.
  `goalRequiresCommit` finds a non-negated commit request ("do not commit", "không commit" ignored).
- Base = `baseCommit` (HEAD recorded in the `__ideal_run` record at `/ideal start`), else the run /
  session start time. Commits are counted `base..HEAD`.
- Written paths = targets of the workers' captured `edit_file`/`write_file`/`apply_patch` calls
  (`DelegationManager.writtenPaths`), plus untracked files newer than the run start (shell-created).
- Refusals, each naming the exact paths and the fix: commit asked for but 0 commits since base;
  written file ignored by git (always); commit asked for and written files untracked or with
  uncommitted edits. Not a git repo: nothing is measured, nothing refused.
- Fidelity probe (`src/workflow/fidelity-probe.ts`): runs when the goal has explicit conversion
  wording AND names an existing source file (`.html/.xml/.md/.txt`) AND workers wrote `.md/.mdx/.txt`
  output. 25 evenly spaced source passages (markup stripped, entities decoded, markdown folded) must
  appear in the normalized output (>= 50 %); literal `\_`, `\*`, `&lt;`, `&gt;`, `&amp;` beyond the
  source's own count fail. 5 MB caps; unreadable/oversized input = skipped, never a refusal.

Where it bites: `flow_verify` (any depth; a pass is recorded as `verdict: fail` with the refusals
in `VERIFY.md`, before any council spend), `context_load(root_status="complete")`
(`WorkingContext.update`), the completion-claim footer (`completion-check.ts`), and the autopilot
(`idealRootCompletion` keeps the run open and states the unmet check in the continuation prompt).
When nothing is refused the facts still head the verify council's "Host-recorded worker evidence".
