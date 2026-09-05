# Self-improvement plan — muonroi-cli improves itself via `/ideal`, on StepFun only

> Goal: use muonroi-cli's own `/ideal` product loop, driven **exclusively by StepFun models
> (`step-3.5-flash` → `step-3.7-flash`)**, to improve muonroi-cli — with the largest outcome
> being that it becomes **the CLI that agents drive, not humans**.
>
> This document defines what counts as an improvement, what must be met, and what stops the loop.
> Written 2026-09-04. Revised 2026-09-04 after adversarial review, a feasibility pass against the
> codebase, and the P0-5 provider measurement (§4.1 — **it leaked**). Baselines measured, not
> estimated. Every code reference below was re-read at revision time; §11 records where the review
> brief itself was wrong.

---

## 0. The premise is blocked. Read this first.

**`/ideal` cannot currently run unattended. It wedges, reproducibly (2/2).** Measured 2026-09-03,
both runs on `step-3.7-flash`:

- the last API call **completed 200** — the provider answered;
- **0 established TCP connections** afterwards → nothing in flight;
- CPU +0.32 s over 20 s (~1.6%) → not spinning;
- typing into the composer still advanced the frame (seq 420 → 421) → **event loop, renderer and
  input are all alive; only the `/ideal` turn is stuck**;
- `MUONROI_LOOP_PROFILE=1` armed and never fired — correct behaviour, it only triggers on a
  *blocked* loop, and this loop is not blocked. **It is the wrong instrument for this class.**

Those four discriminators — last-call status, established connections, CPU delta, does the UI still
take a keystroke — are the instruments. They localise the failure to **a promise that never
settles after a successful model response**, which no loop profiler can see.

**`Escape` produced no toast and no `sprint-halt` during the wedge — but this is NOT evidence about
the unsettled promise.** `interruptActiveRun` bails at `src/ui/use-app-logic.tsx:3847`
(`if (!isProcessingRef.current) return false`), and the `/ideal` dispatch path never sets that ref.
Only three sites do (`use-app-logic.tsx:2870-2871`, `:4005-4006`, `:5335-5336`), and the third is
`/council`, which fixed exactly this bug with an explicit comment: a detached
`dispatchSlash(...).then(...)` returns before the run finishes, so without re-arming the ref "Esc
never reaches `agent.abort()` — the multi-minute council was uncancellable." `/ideal` has the same
shape (`use-app-logic.tsx:5046-5047`) and never re-arms. **This is an independent, already-solved-
elsewhere UI bug (A3/P0-4), not wedge evidence.**

Second blocker: **`tui_stop` returns `ok` without killing the child.** All 8 TUIs started in one
session survived it. `tui.stop` unconditionally returns the string `"ok"`
(`packages/agent-harness-core/src/mcp-server.ts:662-664`) and `onStop` (`:876-884`) only calls
`stopBridge()` and nulls `currentDriver` / `currentPid` / `currentStartedAt`. It **never calls
`kill()`**, and structurally cannot: the child handle is destructured at `:1021`
(`const { proc, sendLine, onLine } = spawnResult`) and never stored in module scope — only the pid
is. `HarnessSpawnResult.proc` exposes `kill()` (`:44`). An unattended loop that starts a TUI per
sprint leaks a process per sprint.

A self-improvement loop that hangs silently at sprint 1 does not improve anything; it burns
quota and produces a transcript that reads like progress. **Phase 0 exists to fix this, and it is
done by a human, not by `/ideal`** — the tool cannot repair the thing that prevents it running.

### 0.1 Where to look for the wedge — the instrumentation already exists three times over

The wedge is not "un-instrumented product loop". It is **the specific await sites that were missed
while their neighbours were guarded**. Four guards in the same files already document this exact
"hung after its final response" symptom:

| Guard | Location | Covers |
|---|---|---|
| `runVerifyWithWatchdog` | `src/product-loop/sprint-runner.ts:104-137` | verify stage |
| `withImplIdleWatchdog` | `src/product-loop/sprint-runner.ts:243-289` | impl idle + total |
| `withIsolatedImplDeadline` | `src/product-loop/sprint-runner.ts:376-394` | isolated impl wall clock |
| `withTurnWatchdog` | `src/agent/turn-watchdog.ts:67`, wired `src/orchestrator/orchestrator.ts:3559` | orchestrator turn |
| council LLM calls | `src/orchestrator/council/llm.ts:354-358`, `:673` | 5-minute bound |

**Unguarded — investigate in this order:**

1. **`src/product-loop/sprint-runner.ts:851-857`** — bare `await planGen.next()` in the planning
   council loop. The impl and verify stages beside it both have watchdogs; this one has none.
   Sprint 1 *Planning* is the first stage after the approve card, which matches the observed wedge
   point. **Start here.**
2. **`src/orchestrator/orchestrator.ts:2649-2651`** — `runProductLoopV1`'s tail
   `for await (const chunk of gen) { yield chunk; }`, with **no `try/finally` and no
   `releasePendingWaits()`**. Compare `runCouncilV2` at `:2399-2408`, which has exactly that
   `finally` (`releasePendingWaits()` at `:2404`) plus a comment warning that an abandoned card's
   `beginInteractivePause()` "would leak and suppress the turn watchdog for the rest of the
   process." `/ideal` uses the same responders and never releases them on the abandoned path.
3. **`src/orchestrator/council-manager.ts:170` and `:204`** — `createQuestionResponder` /
   `createPreflightResponder` build `new Promise((resolve) => …)` with **no reject and no timeout**.
   That is literally "a promise that never settles". `holdWatchdogOpen()` (`:227-238`) suppresses
   *both* watchdogs for the duration, so an abandoned card is invisible by construction.
4. **`src/ui/use-app-logic.tsx:5046-5047`** — `/ideal` slash dispatch `for await (const chunk of
   gen)`, no watchdog, in a `@ts-nocheck` file.
5. **`src/product-loop/loop-driver.ts:752`** — same bare-await shape on `debateGen` (CB-1).
   `:1136` (`preflightGen`) is a deliberate human wait; leave it.

**Revised effort estimate: P0-1 is days, not weeks** — the pattern to copy is in the same file three
times. P0-3 and P0-4 are ~5 lines each (§6).

---

## 1. What "improvement" means here

Generic "make it better" produces slop and is unfalsifiable. Improvement is defined **only**
against the north star, in three properties an agent-driven CLI must have:

| Property | The question it answers | Failure looks like |
|---|---|---|
| **Legible** | Can the driver see what state it is in? | the wedge: no event, no node, no toast |
| **Steerable** | Can the driver change that state? | a flow that needs `render_text` to proceed |
| **Accountable** | Does every outcome announce itself? | a turn that ends without success *or* failure |

**A change is an improvement if and only if it moves an axis that has a committed baseline (§1.1),
breaks none of the others, and passes every gate in §5.** The "iff" binds only to baselined axes —
an axis with no baseline cannot adjudicate anything, and a sprint aimed at one is a discard by
construction. Anything else — refactors, tidying, "better structure" — is out of scope for this
loop. It is not that they lack value; it is that they cannot be adjudicated, and an unadjudicated
self-improvement loop optimises its own narration.

### 1.1 The Agent-Drivability Scorecard

Every axis needs a measurement command **and a named data source**. Where neither exists, the row
says so instead of carrying an invented target.

| # | Axis | Metric | Measurement | Baseline (2026-09-04) | Target |
|---|---|---|---|---|---|
| **A1** | Named-state coverage | fraction of scenario steps where a **named discriminating field** appears in `tui.query` / `tui.last_event` output within N s, letting the driver tell *waiting* / *working* / *hung* apart | `agent-drivability-score.ts` replays `GRADUATION-SCENARIOS.md` over MCP | **not baselined** — corpus does not exist yet (P1-3) | 100% of a fixed corpus |
| **A2** | Terminal-state coverage | every turn emits **at least one** terminal event (result node, `sprint-halt`, `toast(error)`, `askcard-open`, `askcard-answered`) within N s of last stream activity, **and** no turn exceeds N s with no event of any kind | harness spec + negative control (§2.6) | not enforced | invariant enforced by a spec that fails on the negative control |
| **A3** | Lifecycle integrity | `tui_stop` orphan count; does `Escape` abort a stuck turn | 10 × start/stop cycle, count survivors; Esc during a live `/ideal` turn | 1 orphan per stop (8/8 survived); Escape never reaches the abort path (`use-app-logic.tsx:3847`) | 0 orphans; Escape aborts or emits a toast within 5 s |
| **A4** | Decision-field coverage | fraction of scenario steps where **the field the driver needs to choose its next action** is present in structured output (`tui.query` / `tui.last_event` / `tui.snapshot`) | same replay as A1, asserted **positively** | **not baselined** (P1-3) | 100% of the same fixed corpus |
| **A5** | Harness determinism | `tests/harness` green at `retry: 0` for axis-defining specs; unallowlisted skip count | `bunx vitest -c vitest.harness.config.ts run tests/harness/`; `bun run lint:harness-skips:strict` | **67 spec files** (60 top-level + 7 in `tests/harness/auto/`); **8** counted hits (4 `.skip`, 4 `.todo`); **7** allowlist entries; **1 unallowlisted** (`tests/harness/gsd-pil-gate.spec.ts:389`); ratio 11.9% vs 40% threshold; **plus 11 `describe.skipIf` sites the linter deliberately exempts** | strict lint exits 0; unallowlisted = 0; the 4 CI-disabling `skipIf` sites accounted for (§2.7) |
| **A6** | Self-description | does the capabilities payload carry every field a scenario assertion references | field-by-field diff of `buildCapabilitiesPayload()` against the assertion set in `GRADUATION-SCENARIOS.md` | **21 MCP tools**, **22** protocol event kinds, but only **14** advertised `FEATURES` strings and **0** selector/role/event-kind/semantic-id information | every field referenced by any scenario assertion appears in the payload |

#### Notes that the table cannot carry

- **A1's original target of `0` blind states was unreachable in principle.** You can demonstrate
  `≥ n` blind states; you can never demonstrate `= 0` over an unbounded state space. There is no
  state enumeration anywhere in this repo, so any "count the blind states" script would count
  against a human-authored list — the exact failure mode §2 exists to prevent, and gameable by
  omission. A1 is therefore restated as a **bounded, positively stated proxy over a fixed
  denominator**: the scenario corpus. Reaching 100% is a real claim; it is a strictly weaker claim
  than "no blind states exist", and the plan says so rather than pretending otherwise.
- **A4 as "flows that *require* `render_text`" is not observable.** No referee can distinguish "the
  agent needed the scrape" from "the agent used the scrape". The only static proxy — counting
  `render_text` call sites in specs — is polluted, because `visual-capture.spec.ts` legitimately
  tests the visual API. A4 is therefore the same positive assertion as A1 stated per decision
  point: scrape-free means **the decision field exists in structured output**, never "the scrape did
  not happen."
- **A2 must not say "exactly one".** That is falsified by normal operation: `askcard-answered` is a
  distinct kind (`packages/agent-harness-core/src/protocol.ts:233`), so a turn that opens an askcard
  and then continues legitimately emits two terminal-ish events. An implementer told to satisfy
  "exactly one" will **suppress events** — the opposite of the north star, and it would score as an
  improvement.
- **A3 is the only axis that is fully measurable today**, with a real baseline and an unambiguous
  pass criterion produced by this session. It is the template the other rewrites follow.
- **A1, A2, A4 and A6 are referee-change axes** (§2.2). Improving them means changing the
  measurement instrument. They are human-reviewed sprints, not `/ideal`-driven ones.

### 1.2 The graduation test — the north star, made falsifiable

> A fresh agent, given **`tools/list` plus the output of `tui.capabilities` and nothing else** — no
> repo files, no `CLAUDE.md`, no `docs/` — completes the fixed scenario list end-to-end over MCP,
> with **0 human interventions** and **0 states it cannot name**.

Three corrections that the original phrasing got wrong, all load-bearing:

1. **The information budget was mis-stated.** Every MCP client receives `tools/list` for free at
   handshake — 21 tool names, descriptions and input schemas. "Given only `tui.capabilities`" is
   violated at t=0, and the cheapest way to "pass" is to stuff selector grammar into tool
   description strings. State the budget honestly as `tools/list` + `tui.capabilities`, and treat
   description-stuffing as green-by-deletion's twin: it moves information out of the payload the
   axis measures into a channel the axis does not measure.
2. **As literally written it is currently unpassable.** `buildCapabilitiesPayload()`
   (`packages/agent-harness-core/src/mcp-server.ts:261-284`) returns exactly `protocol`, the
   14-string `FEATURES` array, `eventLogPath`, and three capability flags. It carries **no semantic
   ids, no role vocabulary, no selector grammar, and no event-kind list** — so a fresh agent cannot
   construct one valid selector. Making the payload sufficient is concrete Phase-0/1 work, not an
   aspiration.
3. **The graduation agent's model was never pinned.** The loop is StepFun-only but the graduating
   agent was unconstrained. Passing with a frontier model and declaring "a CLI that agents drive" is
   the single most likely false victory in this plan. `GRADUATION-SCENARIOS.md` **must pin the model
   class**, and graduation requires **at least one clean run driven by `step-3.7-flash`**. A pass by
   a frontier agent alone is recorded as a partial result, never as graduation.

A6 and the graduation test must not be the same claim measured the same way, or each resolves to
the other. A6's independent criterion: **every field referenced by any scenario assertion appears in
the capabilities payload** — a static diff, computable without running the scenarios.

The scenario list is versioned at `docs/agent-first/GRADUATION-SCENARIOS.md` (written in Phase 1)
and may only grow, never shrink, between attempts.

---

## 2. Anti-gaming rules (non-negotiable)

A system that both writes the change and judges it will optimise the judge. This session produced
the relevant warning: a model narrated two fixes it had not applied, and the transcript read like
success. A small set of controlled follow-up tasks did match their artifacts, but that sample is far
too small to say anything about the rate of a rare behaviour — it is not evidence of absence. Build
the loop as if narration-without-action will happen, because at scale it will.

1. **Artifacts decide, never the agent's report.** The gate reads test output, exit codes and
   scorecard numbers. What the agent says it did is discarded.
2. **The referee is immutable within a sprint.** The improving agent may not modify, in the same
   sprint as the claim:
   - `scripts/agent-drivability-score.ts`
   - `.husky/**`
   - `package.json` test/lint scripts
   - `vitest*.config.ts`
   - any spec that defines the axis being improved
   - **`packages/agent-harness-core/src/**` and `packages/agent-harness-opentui/src/**`**
   The last entry is the fix for the plan's most severe structural defect: those two packages **are**
   the measurement instrument for A1, A2, A4 and A6. Improving A2 means emitting new `LiveEvent`
   kinds; improving A6 means changing `buildCapabilitiesPayload()`. Without this line, §2.3 would
   re-measure every legitimate A1/A2/A4/A6 sprint against the pre-change instrument and score it
   **zero by construction**.
3. **The score is recomputed on the pre-change referee.** If a sprint touches a spec, the axis is
   re-measured with the previous revision of that spec.
4. **Independent verification.** The gate runs outside the agent's session — a clean process, in the
   worktree, by the human or CI. Not a tool call the agent makes, and not a hook the agent's own
   session can iterate against.
5. **No credit for green-by-deletion.** A sprint that improves a metric by removing tests, widening
   an allowlist, or adding a skip fails automatically. **Extended:** *removing an MCP tool, a
   protocol event kind, a semantic node, or a capabilities field counts as green-by-deletion for
   every axis it appears in.* Without this, A4 and A6 are both satisfiable by deleting
   `tui.render_text` and `tui.render_visual` — they are two entries in a static `FEATURES` array
   (`mcp-server.ts:245-260`), so deleting them takes A4 to target *and* shrinks what A6 must
   describe. Making the CLI less capable is not making it more drivable.
6. **Every axis spec ships a negative control.** A deliberately broken fixture the spec must
   **fail** on, run as part of the gate. A referee that cannot detect a known-bad change measures
   nothing. Concretely for A2: without a negative control, an agent can emit a synthetic terminal
   event unconditionally from a wrapper, turn the spec green, and leave the wedge exactly as
   invisible as it was. The negative control is what makes "the spec is green" mean something.
7. **No green-by-dilution, and no invisible skips.** Three mechanisms in the current linter break
   this, all verified:
   - `SKIP_RE` is `/^\s*(it|describe)\.(skip|todo)\s*\(/` (`scripts/check-harness-skips.ts:57`) and
     `describe.skipIf` is **explicitly excluded** at `:58`/`:68` with an in-code comment calling it
     "a legitimate platform/env guard, not coverage." There are **11 `describe.skipIf` sites**, and
     four of them disable real E2E in CI: `council-flow.spec.ts:26`, `discovery-askcard.spec.ts:28`,
     `session-rotation-delegation.spec.ts:66` (all `skipIf(!!process.env.CI)`) and
     `ideal-e2e-live.spec.ts:155`. **Council, askcard and delegation E2E never run in CI.** An
     `it.skipIf` would be invisible to both regexes. Extend the pattern to `\.(skip|todo|skipIf)\b`
     and account for each site, or state in the allowlist that CI does not cover those flows.
   - The ratio denominator is `specFiles.length` — files, not tests — and
     `src/self-qa/spec-emitter.ts:34` writes a new file into `tests/harness/auto/` on every passing
     self-verify scenario. **The loop inflates its own denominator and buys headroom for skips.**
     Gate on the allowlist alone, or change the denominator to test count.
   - The allowlist keys on `path:line`, so any sprint that edits a spec above an allowlisted line
     silently invalidates the entry and turns a known skip into an unallowlisted one.
8. **Clear the pre-existing unallowlisted hit before Phase 1** so the A5 baseline is honestly green.
   `bun run lint:harness-skips:strict` **exits 1 today** (`check-harness-skips.ts:128-130`), which
   means gate §5.4 fails before sprint 1 unless `tests/harness/gsd-pil-gate.spec.ts:389` is fixed or
   allowlisted.

---

## 3. Safety rails for self-modification

The target of the change is the tool making the change. Rails, in order of importance:

1. **Never the main working tree.** Each sprint runs in a `git worktree` on `self/<axis>-<n>`, under
   `.claude/worktrees/` — safe, because `vitest.config.ts:43` already excludes `.claude/**` from
   collection, and MCP `validateCwd` accepts a path under the repo root.
2. **Never the referee** — see §2.2, including both harness packages.
3. **Never `dist/`.** The installed CLI keeps running the last human-blessed build; a sprint that
   needs its change live rebuilds only after the gate passes. (`dist/` and the `muonroi-cli`/`mu`
   bins are currently absent — this checkout runs in source mode, and `/update` classifies it
   `dev-link` at `src/utils/install-manager.ts:265`.)
4. **Auto-commit scoped to the worktree branch.** Never `develop`, never `master`.
5. **A sprint may not change the model policy** (§4). Escaping to a non-StepFun model to get unstuck
   invalidates the experiment.
6. **Human merge.** No sprint merges itself. The gate produces a verdict; a human presses merge.
7. **A sprint has a hard token budget and a hard wall-clock budget. Exceeding either is a
   *discard*, not a retry**, logged as a gate failure naming the axis. See §3.3 for how the budget
   is set and measured.

### 3.1 Worktree setup is not automatic — two must-fix steps

**Husky hooks silently do not run in a fresh worktree.** `core.hooksPath` is `.husky/_` and
`.git/config` is shared, but `.husky/_/.gitignore` is a single `*`, so `.husky/_/` is untracked and
`git worktree add` never creates it. Git finds no hook directory and **every gate skips with no
error** — semantic lint, self-verify Tier 1, and the compile smoke all vanish silently. It is
restored only by `bun install`, whose `prepare` script runs husky.

Mandatory worktree bootstrap, in order, before the first sprint command:

```bash
git worktree add .claude/worktrees/<axis>-<n> -b self/<axis>-<n>
cd .claude/worktrees/<axis>-<n>
bun install                                        # restores .husky/_/ — do not skip
bun --filter @muonroi/agent-harness-core build
git config core.hooksPath                          # must print .husky/_
ls .husky/_/pre-push                               # must exist
```

**`.planning/` is 29 tracked files despite `.gitignore:31`** — gitignore never applies to already-
tracked paths. `git ls-files .planning` returns `STATE.md`, `ROADMAP.md`, `REQUIREMENTS.md`,
`RETROSPECTIVE.md`, `config.json` and two `phases/` trees. So every worktree inherits a branch-point
`STATE.md`, and `nativeStateUpdate` (`src/gsd/native-state.ts:40`) dirties a **tracked** file that
auto-commit sweeps in and that conflicts across N sprint branches at merge. Decide once, and record
the decision here: either `git rm --cached` the mutable state files, or reset `STATE.md` to a known
value at worktree creation and exclude it from auto-commit.

### 3.2 What a worktree does and does not isolate

| Concern | Isolated? | Evidence |
|---|---|---|
| Session / workspace scoping | ✅ yes | `src/storage/workspaces.ts:61-71` — `scopeKey` is `findGitRoot(cwd)`, and a worktree has its own root |
| `~/.muonroi-cli/` DB | ❌ **shared** | `src/storage/db.ts:28-30` — `homedir()`-based |
| user settings | ❌ **shared** | `src/utils/settings.ts:436-437` |
| env store / API keys | ❌ **shared** | `src/providers/env-store.ts:16` (`MUONROI_ENV_FILE` overrides) |
| usage cap ledger | ❌ **shared, and racy** | `src/usage/ledger.ts` documents a `proper-lockfile` staleness window that lets two `reserve()` bodies run concurrently — main tree + worktree is exactly that shape |
| MCP harness extra roots | ⚠️ partial | `loadExtraRoots()` reads a gitignored `.muonroi-harness-roots.json` relative to `REPO_ROOT`, so a driver launched inside a worktree loses the allowlist — use `MUONROI_HARNESS_EXTRA_ROOTS` |
| `/update` | ⚠️ dangerous | from a worktree it would `git pull --ff-only` the **sprint branch** (`install-manager.ts:265`, `:561`). Do not run it during a sprint |

`MUONROI_CLI_HOME` only partially isolates the home-directory state. Run one sprint at a time
unless and until per-sprint home isolation is verified end to end.

`pre-push` on a fresh branch has no upstream, so the commit range is empty and both match variables
fall back to `"run-anyway"` → full lint + compile smoke on every first push. That is the desired
behaviour here; budget the wall clock for it.

### 3.3 Cost, quota and rate limits

The plan previously had no per-sprint budget, no maximum sprint count, no 429 behaviour and no
ledger check. §3's other rails govern only *where* changes land, not *how much* a run may consume.

**Rate limits are a hard planning constraint.** Both StepFun catalog rows declare
`rate_limits: { concurrency: 5, requests_per_minute: 10, tokens_per_minute: 5_000_000 }`
(`src/models/catalog.json`, the `step-3.5-flash` row at `:49` and `step-3.7-flash` at `:93`). **A
council debate fans out in parallel.** At 10 RPM, a multi-speaker debate plus a planning council is
rate-limit-bound, not latency-bound. Either cap council fan-out to ≤ 5 concurrent calls and pace to
10 RPM, or expect 429s mid-debate; a 429 inside a bare `await` (§0.1) is a wedge with a different
proximate cause.

| Budget | Value | Source / status |
|---|---|---|
| Tokens per sprint | **to be set from the first three sprints' measured data** | `interaction_logs WHERE event_type='call_accounting'` (see CLAUDE.md → "The metered gate"); `usage_events` for billed totals. No target is stated here because none has been measured — inventing one would violate §1. |
| Wall clock per sprint | **90 min, provisional** | A *chosen bound*, not a measurement. Justification: documented sprint planning alone runs ~12 min, and impl/verify carry their own multi-minute watchdogs. Revise after three sprints of data and record the revision here. |
| Max sprints per axis | **3** | After 3 discards on one axis, stop and escalate to a human decision. |
| 429 / quota exhaustion | **discard the sprint, log the axis, do not retry inside the same worktree** | see §8's third ending |
| Retry budget | **1 re-run per sprint**, and only for a gate failure whose cause is demonstrably external (infrastructure, 429, a flake reproduced as green at `retry: 0`) | prevents §5.2's absolutism from silently becoming "retry until green" |

**Every sprint records its cost next to its axis delta** (§5), so cost-per-unit-of-drivability is
visible from sprint 1 rather than discovered at sprint 20.

### 3.4 The GSD mutation gate fails OPEN — decide explicitly

`src/gsd/mutation-gate.ts:42` returns *allow* for `!depth || depth === "quick" || depth ===
"standard"`; it hard-blocks at `heavy` only, with an in-code comment saying over-blocking on "we
don't know" is the failure mode the design forbids. Depth comes solely from `readState(cwd).depth`
→ `.planning/STATE.md` (`src/gsd/workflow-engine.ts:147-159`), and a fresh worktree lacking plan
artifacts yields `depth: null`. **So the plan-review requirement does not apply to sprint work at
all** unless something sets depth to `heavy`. When it does fire, unblocking needs *both* a
`PLAN-VERIFY.md` verdict of `pass` and a `STATE.md` phase of `execute`
(`workflow-engine.ts:227-243`).

Pick one and record it in `GRADUATION-SCENARIOS.md`'s run notes:

- **(a)** reset `STATE.md` to a known depth at worktree creation and rely on the gate, or
- **(b)** run with `MUONROI_GSD_HARD_GATE=0` and state plainly that the gate is off.

What is not acceptable is the current situation: a plan that assumes the gate protects sprints while
the gate is structurally inert for them.

---

## 4. Model policy — StepFun only, and the preconditions that make it viable

| Role | Model | Why |
|---|---|---|
| classify / title / short verdicts | `step-3.5-flash` | measured 110 chars of reasoning in 4.9 s vs 4,017 in 16.0 s at `high`; the default behaves like `high` |
| leader / implement / verify / council | `step-3.7-flash` | premium tier, catalog `leader` role, 256K window verified 6/6 up to 246,738 input tokens |

**`reasoning_effort: "low"` is not implementable today — it is Phase 0 work, not a setting.** The
`step-3.5-flash` catalog row sets `"supports_effort": false` (`src/models/catalog.json:62`), and
`reasoningEffort` is emitted only by `OpenAIProviderCapabilities`
(`src/providers/capabilities.ts:242`) and `XAIProviderCapabilities` (`:265`). StepFun uses
`StepFunProviderCapabilities` (`:372-376`), which extends `ReliableProviderCapabilities` and
overrides only `consoleSignupURL()` — it emits **no** provider options at all. Making the low-effort
path real requires a catalog flip **and** a StepFun capability override that emits the right
namespace. Until both ship, every short-output call site must budget output tokens instead (see the
third bullet below).

**Verified preconditions** (checked 2026-09-04, do not re-litigate without re-measuring):

### 4.1 🔴 BUG-A on StepFun: MEASURED, deterministic, and not mitigable in-band

**P0-5 has been run.** Measured 2026-09-04 against `https://api.stepfun.ai/step_plan/v1`. The
question was whether `step-3.7-flash` leaks its native tool-call markup as plain text when the tool
set is empty but the message history contains prior tool usage — the BUG-A condition documented at
`src/orchestrator/tool-engine.ts:1889-1902`. **It does, deterministically.**

| Case | Request shape | Result |
|---|---|---|
| a | `tools:[]` + `tool_choice:"none"` — what `tool-engine` sends | **LEAK** |
| b | no `tools` key at all + `tool_choice:"none"` — **the forced-finalize shape** | **LEAK** |
| c | no tools, no `tool_choice` | **LEAK** |
| d | `step-3.5-flash`, `tools:[]` + `"none"` | **LEAK** |
| e | a real `tools` array (normal agent turn) | clean — proper `tool_calls`, no leaked text |
| f | system prompt explicitly saying "no tools available, prose only, never emit `<tool_call>` markup" | **LEAK** |

Verbatim leaked `content`, with `finish_reason: "stop"` and `tool_calls: false` — 101 chars of
markup where the user's answer should be:

```
<tool_call>
<function=read_file>
<parameter=path>
src/config.js
</parameter>
</function>
</tool_call>
```

Raw transcripts: cases a–b and c–f, captured by the operator on 2026-09-04.

**Four consequences, each of which kills a previously-held assumption:**

1. **Forced-finalize leaks. It is not safe — case (b) *is* the forced-finalize shape.** The original
   plan marked it ✅ on the reasoning that `forcedFinalize` (`src/orchestrator/scope-ceiling.ts:222`)
   and stall-rescue pass `toolChoice:"none"` **without** a `tools` array, and `generateTextStreamed`
   only sends `tools` when `hasTools` is true (`src/providers/streamed-generate.ts:57`), so "the
   model is given no tools to call." That reasoning was wrong twice over: BUG-A is not a tool call —
   it is plain text — and the no-tools shape is exactly the shape that leaks. So `forcedFinalize`,
   stall-rescue and the chitchat continuation **all emit this markup into the user-visible final
   answer on StepFun**, and the AI SDK does not parse it back out.
2. **`tool_choice` is irrelevant.** Cases a, b and c are identical outcomes. StepFun ignoring
   `tool_choice` is *not* the cause; the empty-tool-set-plus-prior-tool-history condition is. Do not
   frame the fix as "wait for StepFun to implement `tool_choice`", and do not expect
   `tool-engine.ts:1903-1904`'s `_finalToolChoice = "none"` mitigation — which is correct for
   DeepSeek (sessions `002df4014cb4`, `fc19b4daee20`) — to help here. It is inert.
3. **Prompt-level mitigation is disproven** (case f). Do not propose one.
4. **The model policy survives only with a provider-level output guard.** The markup is well-formed,
   so a guard at the provider boundary can either strip it from `content` or parse it back into a
   tool call. That guard is **P0-5b**, and it is a hard precondition for every later phase: without
   it, any StepFun-driven sprint can produce a "successful" turn whose visible answer is markup —
   which is precisely the transcript-that-reads-like-progress failure §8 exists to prevent.

**File this upstream.** It is the strongest StepFun bug report this project has produced: it breaks
every agent framework that has a final-answer-without-tools turn, not only muonroi-cli. Case (e)
proves the model is well-behaved whenever a schema is present, which makes the report crisp and the
repro three lines long.

### 4.2 Remaining preconditions

- ⚠️ Reasoning consumes the whole output budget before any content. A short-output path under
  ~1024 `max_tokens` returns `content: ""` with `finish_reason: "length"`. With `supports_effort:
  false`, the only available mitigation today is raising `max_tokens` at the call site.
- ⚠️ **Rate limits bind before latency does** — 10 RPM / 5 concurrent, see §3.3.

---

## 5. The gate — what every sprint must meet

A sprint is **accepted** only if all of these hold, measured independently, in a clean process:

| # | Check | Command | Pass condition |
|---|---|---|---|
| 5.1 | Typecheck | `bunx tsc --noEmit` | 0 errors (passes cleanly on `develop` today — this is a real baseline, not an aspiration) |
| 5.2 | Unit suite | `bunx vitest run` | **0 failed.** Not "no new failures" — zero |
| 5.3 | Harness E2E | `bunx vitest -c vitest.harness.config.ts run tests/harness/` | green |
| 5.4 | Lint gates | `bun run lint:semantic:strict` **and** `bun run lint:harness-skips:strict` | exit 0 |
| 5.5 | Targeted axis | `bun scripts/agent-drivability-score.ts --json` | the targeted axis moved in the right direction vs the committed baseline, measured on the pre-change referee (§2.3) |
| 5.6 | No regression | same | no other baselined axis regressed |
| 5.7 | Self-verify | `bun run src/index.ts self-verify --since <merge-base> --max 4 --json` | ran **and** passed; `ran:false` or any crash is a **FAIL** |
| 5.8 | Negative control | axis spec's broken fixture | the spec **fails** on it |
| 5.9 | Budget | §3.3 | tokens and wall clock within budget; cost recorded next to the axis delta |

### 5.3 / A5 determinism

`vitest.harness.config.ts` sets `retry: 2` for **every** spec. "Green harness" therefore tolerates
flakes, and §5.3 cannot distinguish a fixed axis from a lucky attempt. Pick one and state it:

- run the **axis-defining** specs with `retry: 0` (preferred — it is the only way A5 can gate an
  improvement), or
- accept that A5 gates **regression only, never improvement**.

Do not leave this unstated; it is the difference between a referee and a coin flip.

### 5.4 must use the `:strict` variants

The original gate named `lint:semantic` and `lint:harness-skips`. Both are the **non-strict**
variants and both end in an unconditional `process.exit(0)`
(`scripts/check-semantic-wrap.ts:113`, `scripts/check-harness-skips.ts:137`). **As written, the gate
could not fail.** The `:strict` scripts exist (`package.json`) and exit 1 on findings
(`check-semantic-wrap.ts:107-109`, `check-harness-skips.ts:128-130`).

### 5.7 must be an independent step, not the in-sprint hook

The Tier-3 hook inside `/ideal` cannot serve as the gate, for four verified reasons:

- **It fails open through a silent catch.** `src/product-loop/sprint-runner.ts:1304-1306` wraps the
  Tier-3 call in `catch { /* self-verify must NEVER block the sprint pipeline */ }` — a bare catch
  that also violates this repo's own No Silent Catch Rule. Any spawn failure, timeout or parse
  failure leaves the verdict `PASS`. And `sv.ran === false` prints nothing, so "never ran" and "no
  watched surfaces touched" are indistinguishable in the transcript.
- **It inspects one commit.** `baseRef: "HEAD~1"` (`sprint-runner.ts:1288`) means a three-commit
  sprint only checks the last commit. **Evasion:** commit the `src/ui/**` change first and a README
  touch last, and the watched-surface detector sees nothing.
- **The defaults contradict each other in code.** `sprint-runner.ts:1282` says "Default OFF; opt-in
  via `MUONROI_SPRINT_SELF_VERIFY=1`"; `src/product-loop/sprint-self-verify.ts:66-73` implements
  default **ON**. The implementation wins, but a plan cannot rest on a flag whose own comments
  disagree.
- **In a fresh worktree it does not run at all** — the husky problem in §3.1.

It also violates §2.4 on its face: it is a check the agent's own session runs and can iterate
against. Run it as its own step with `--since <merge-base>`, and treat `ran:false` as FAIL.

### 5.10 Failure context lives outside the worktree

Rejected sprints are discarded with their worktree. **Failure context must therefore not live inside
it.** The original plan wrote it to `.planning/GATE-FAILURES.md`, a file that does not exist anywhere
in the repo and would sit in a directory that is both gitignored and inside the discarded worktree —
so "discard by deleting the worktree" would destroy the exact artifact the next attempt needs.

Write failure context to **`docs/agent-first/gate-failures/<axis>-<n>.md`, committed on the main
branch**, before the worktree is deleted. It records: the axis, the gate item that failed, the
verbatim failing output, the token and wall-clock spend, and one sentence on what the next attempt
should do differently.

### 5.11 Outcomes are three, not two

| Outcome | Meaning | Action |
|---|---|---|
| **Accept** | all of §5 passed | human merges |
| **Reject** | a gate item failed | discard worktree, write §5.10 record |
| **Discard-with-reason** | the sprint produced **zero file mutations**, or exceeded budget (§3.3), or died to a 429 / quota exhaustion | discard, write §5.10 record, and flag **the loop** as the suspect — not the axis |

The third row exists because the gate as originally written scores a zero-mutation sprint as "no
axis moved", which reads as evidence about the axis when it is actually evidence about the loop.
There is documented precedent in this repo for a `/ideal` run producing 0 code in 50 minutes; that
must surface as a loop failure, not as an axis result.

---

## 6. Phases

### Phase −1 — Commit the baseline (before anything is touched)

Run the §1.1 measurements and commit the scorecard **before** Phase 0 changes a single line. The
original ordering recorded the baseline at P1-2, *after* the human had already moved A1 and A3 to
target — which would understate the human's work and overstate the loop's. Anything Phase 0 fixes
must show up as Phase 0's credit, not as the loop's.

At this point A1 and A4 have no baseline (no corpus yet). Record them as **not baselined** rather
than as a number.

### Phase 0 — Unblock (human-driven; `/ideal` cannot do this)

Ordered by "cheapest test that can kill the whole plan" first.

| ID | Work | Effort | Exit criterion |
|---|---|---|---|
| **P0-5** | ✅ **DONE 2026-09-04.** Measured whether `step-3.7-flash` leaks native markup on a chitchat continuation with an empty tool set and prior tool history, including through `forcedFinalize`. | 6 API calls, no code | **Result: LEAKS, deterministically, in 5 of 6 cases including the forced-finalize shape; `tool_choice` irrelevant; prompt mitigation disproven** (§4.1). Model policy survives only via P0-5b |
| **P0-5b** | 🔴 **BLOCKING — new work created by P0-5.** Provider-level output guard for StepFun: detect the well-formed `<tool_call>…</tool_call>` block in `content` and either strip it or parse it back into a tool call. Must sit at the provider boundary, not in a prompt and not behind `tool_choice` — both are disproven. Cover `forcedFinalize` (`scope-ceiling.ts:222`), stall-rescue and the chitchat continuation. | small-to-medium, one seam | all six P0-5 cases replayed through the CLI produce prose or a parsed tool call, never markup; a regression spec pins case (b), the forced-finalize shape |
| **P0-3** | `tui_stop` kills the child: store the `proc` handle in module scope and call `kill()` in `onStop` | ~5 lines (`mcp-server.ts:876-884`, `:1021`, `:44`) | 0 orphans across 10 start/stop cycles |
| **P0-4** | `Escape` aborts a stuck `/ideal` turn within 5 s, or emits a `toast` explaining why it cannot | ~5 lines — mirror the `/council` fix at `use-app-logic.tsx:5335-5336` | Esc during a live `/ideal` turn produces an abort or a toast |
| **P0-6** | Make `tui.capabilities` sufficient: add selector grammar, role vocabulary, the full event-kind list and the semantic-id inventory; advertise all 21 tools in `FEATURES`; add `resume-request` to the `tui.last_event` kind enum (`mcp-server.ts:625-645`) so that call stops being rejected at the MCP boundary | small, mechanical | A6's static criterion is satisfiable at all |
| **P0-7** | Clear `tests/harness/gsd-pil-gate.spec.ts:389` (fix or allowlist) so `lint:harness-skips:strict` exits 0; extend `SKIP_RE` per §2.7; decide the 4 CI-disabled E2E sites | small | gate §5.4 is green before sprint 1 |
| **P0-2** | Every terminal state emits an event (A2 invariant), **with a negative control** (§2.6), so a wedge is observable even before it is fixed | medium | spec green, negative control red |
| **P0-1** | `/ideal` completes a full run without wedging, 3/3 consecutive. Work the unguarded await sites in the §0.1 order | **days, not weeks** — the guard pattern already exists three times in the same file | 3/3 clean runs |
| **P0-8** | *(conditional on P0-5)* If low-effort reasoning is needed: flip `supports_effort` for `step-3.5-flash` and add a StepFun capability override that emits the provider option (§4) | small | a StepFun call demonstrably carries the effort parameter |

**Nothing downstream starts until P0-1 through P0-4, P0-5b and P0-7 pass.** P0-5 is done and its
verdict (§4.1) makes **P0-5b the gate on everything else**: until the output guard ships, a StepFun
turn can return markup as its final answer, so no sprint transcript on this stack can be trusted —
and a plan whose evidence channel is untrustworthy measures nothing (§8).

### Phase 1 — Build the referee

- **P1-1** `scripts/agent-drivability-score.ts` — computes A1..A6 from artifacts, emits JSON.
  Written by a human. It is the referee; §2.2 protects it from here on. Reuse, do not rebuild: see
  §9.
- **P1-2** `docs/agent-first/GRADUATION-SCENARIOS.md` — the fixed scenario corpus, the pinned model
  class for the graduation agent, and the per-step assertion set that A1, A4 and A6 all measure
  against.
- **P1-3** Baselines for A1 and A4 recorded against that corpus and committed. (The other four were
  committed at Phase −1.)
- **P1-4** Negative controls written for every axis spec (§2.6) and verified to fail.

### Phase 2..N — `/ideal`-driven sprints, one axis each

Each sprint: fresh worktree (§3.1 bootstrap) → `/ideal` with the axis as the goal → gate (§5) →
human merge, reject, or discard-with-reason (§5.11). One axis at a time; a sprint that touches two
axes cannot be adjudicated cleanly.

**Which axes are actually available to the loop:**

| Axis | Available to `/ideal`? | Why |
|---|---|---|
| A3 | ❌ | fully delivered by P0-3 + P0-4 |
| A2 | ❌ | fully delivered by P0-2 |
| A1, A4, A6 | ❌ as `/ideal` sprints | **referee-change sprints** (§2.2) — improving them means changing the measurement instrument, so they are human-reviewed |
| A5 | — | a constraint on every sprint, never a target of its own |

**This is the plan's most uncomfortable finding, and it is stated rather than hidden: after Phase 0,
the current scorecard leaves `/ideal` with no axis of its own to improve.** The original §6 ordering
("A3 → A2 → A1 → A4 → A6") opened the loop with two sprints whose targets P0-2/P0-3/P0-4 had already
met — P0-2 *is* A2 and P0-3 + P0-4 *are* A3, in the same sentences. A sprint told to improve an
already-met axis will invent scope, which is precisely §8's stated nightmare.

The honest consequence: **Phase 2 does not begin until the scorecard is extended with at least one
axis that is (a) baselined, (b) not referee-owned, and (c) reachable by a change confined to
`src/`.** Defining that axis is Phase 1 work, and if no such axis can be defined, that is itself the
answer to whether `/ideal` can improve muonroi-cli on the drivability dimension — report it under
§8, do not manufacture a sprint.

### Phase G — Graduation attempt

Run the scenario corpus with a fresh agent under the §1.2 information budget, **including at least
one run driven by `step-3.7-flash`**. Record the transcript. Any intervention or unnameable state is
a fail, and names the next sprint. A pass by a frontier model alone is recorded as a partial result,
never as graduation.

---

## 7. Explicitly out of scope

- Non-StepFun models anywhere in the loop (§3.5). The graduation agent's model is pinned separately
  (§1.2) and a frontier-only pass does not count.
- Refactors, renames, dependency bumps, "code quality" — unadjudicable here (§1).
- New features. This loop makes the CLI drivable, not larger.
- Anything in `dist/`, `.husky/`, or the referee — including both harness packages (§2.2, §3.3).
- `/update` from inside a sprint worktree (§3.2).

---

## 8. How this ends

Three endings, all honest. The third was missing and is the likeliest.

- **Graduation passes.** The scenario corpus runs clean with a fresh agent under the §1.2 budget,
  with at least one clean `step-3.7-flash` run and no interventions. "CLI for agents" becomes a claim
  with a transcript behind it.
- **The loop is abandoned with a reason.** If StepFun-only proves insufficient — for instance if
  **P0-5b's output guard cannot be made reliable** (P0-5 has already proven the leak is real,
  deterministic and immune to both `tool_choice` and prompting, §4.1), or if Phase 1 cannot define a
  non-referee axis for `/ideal` to target (§6, Phase 2) — that is a finding, and it is written up
  rather than papered over. A self-improvement loop that cannot fail honestly is not measuring
  anything.
- **The run stops on budget, quota or rate limits.** A sprint dies mid-flight at 10 RPM, or the
  ledger runs out, leaving a half-applied worktree and an ambiguous verdict. This is a
  **discard-with-reason** (§5.11), not a data point about the axis, and §5.10 records it as such.
  Without naming this ending in advance, it will be misread as evidence that the axis was hard.

The failure mode to avoid is none of those: sprints that run, produce commits, move no measured
axis, and generate a transcript that reads like progress. §2 exists to make that impossible to
mistake for success.

---

## 9. Machinery that already exists — cite it, do not rebuild it

The referee in P1-1 is largely assembly, not construction. `src/self-qa/` already provides:

| Piece | Location | What it gives the referee |
|---|---|---|
| Rule-based judge, **no LLM call** | `src/self-qa/judge.ts:5-13` | reproducible, cheap per-expectation verdicts (`pass` / `fail` / `inconclusive` — it refuses to claim pass-or-fail on a crash) |
| Numeric pass rate | `src/self-qa/judge.ts:230-248` (`summariseResults`) | the scalar A1/A4 need |
| JSON report | `src/index.ts:1674` (`self-verify --json`) | machine-parseable gate input |
| Job API over MCP | `selfverify_start` / `status` / `result` / `list` / `cancel` | driving verification from the operator agent |
| Pre-push gate | `scripts/self-verify-pre-push.cjs`, `.husky/pre-push:43` | the Tier-1 hook (§5.7 explains why it is not the gate) |
| Spec emitter | `src/self-qa/spec-emitter.ts:30` | passing scenarios become permanent regression specs (watch the denominator — §2.7) |

Also reusable:

- **`tui.visual_quality`** — 0–100 render score with `issues[]`, already an MCP tool.
- **`scripts/gate0-ab.mjs`** — an existing `--json` metric harness with explicit falsifier rules;
  the closest thing in the repo to a working referee, and the right shape to copy.
- **`packages/agent-harness-core/src/lint.ts`** — semantic-wrap detection as an importable library
  (`findUnwrappedComponents`, `findInteractiveWithoutSemantic`), imported by
  `scripts/check-semantic-wrap.ts:16` via the `.js` NodeNext specifier. No subprocess scraping
  needed.

**Green light:** `bunx tsc --noEmit` passes cleanly on `develop` right now, so §5.1 starts from a
real zero.

**Latent bug found in passing, unrelated to this plan but worth a ticket:**
`src/cli/reporter-cmd.ts:37-39` — `resolveFlowDir()` hardcodes
`path.join(process.cwd(), ".planning")`, bypassing `planningRoot()` and the `.muonroi-flow` fold. It
will misbehave in exactly the worktree/alternate-root setups §3 depends on.

---

## 10. Preconditions this plan depends on — one table

Every row is a verified defect that silently neutralises part of the plan. None may be assumed fixed.

| # | Defect | Effect if left | Owner |
|---|---|---|---|
| 1 | `lint:semantic` / `lint:harness-skips` exit 0 unconditionally | gate §5.4 cannot fail | §5.4 (use `:strict`) |
| 2 | `lint:harness-skips:strict` exits 1 today (1 unallowlisted hit) | gate fails before sprint 1 | P0-7 |
| 3 | `describe.skipIf` invisible to the linter; 4 real E2E disabled in CI | "green harness" overstates coverage | §2.7 / P0-7 |
| 4 | Skip ratio denominator is spec **files**, inflated by the self-verify emitter | loop buys its own skip headroom | §2.7 |
| 5 | `vitest.harness.config.ts` `retry: 2` on every spec | A5 cannot distinguish fixed from lucky | §5.3 |
| 6 | Tier-3 self-verify has a bare `catch`, `HEAD~1` base, contradictory defaults | gate §5.7 fails open and is evadable | §5.7 |
| 7 | `.husky/_/` untracked → hooks absent in a fresh worktree | every hook-driven gate skips silently | §3.1 |
| 8 | `.planning/` is 29 **tracked** files | branch-point state dirtied per sprint; merge conflicts | §3.1 |
| 9 | `~/.muonroi-cli/` state + usage ledger shared across worktrees | cross-sprint interference; racy `reserve()` | §3.2 |
| 10 | GSD mutation gate fails open on `depth: null` | plan-review requirement inert for sprints | §3.4 |
| 11 | `buildCapabilitiesPayload()` carries no selector/role/event/id information | graduation test unpassable as written | P0-6 |
| 12 | `tui.last_event` enum omits `resume-request` | that call rejected at the MCP boundary | P0-6 |
| 13 | `supports_effort: false` + no StepFun capability override | `reasoning_effort: "low"` is not settable | P0-8 |
| 14 | StepFun 10 RPM / 5 concurrent vs parallel council fan-out | 429s mid-debate, read as wedges | §3.3 |
| 15 | 🔴 **StepFun emits native `<tool_call>` markup as the final answer whenever the tool set is empty** — measured, 5/6 cases, incl. forced-finalize; `tool_choice` and prompting both disproven (§4.1) | a "successful" sprint turn can be 101 chars of markup; every transcript on this stack is untrustworthy until guarded | **P0-5b — blocks all downstream phases** |

---

## 11. Corrections to the review brief (evidence trail)

The revision brief was verified line by line against the code. Four references had drifted; the code
wins, and the document above uses the corrected values.

| Brief said | Code says | Note |
|---|---|---|
| `orchestrator.ts:2655-2657` — `runProductLoopV1` tail for-await | **`:2649-2651`** | 6-line drift; the `runCouncilV2` `finally` is `:2399-2408` with `releasePendingWaits()` at `:2404` |
| `vitest.config.ts:42` excludes `.claude/**` | **`:43`** | `:42` is `tmp/**` |
| `council-manager.ts:169` — question-card promise; file under `src/product-loop/` | **`src/orchestrator/council-manager.ts:170`** | wrong directory and off by one; `:204` (preflight) and `:227-238` (`holdWatchdogOpen`) are correct |
| `packages/agent-harness-core/src/lint.js` | source is **`lint.ts`** | `.js` is the NodeNext import specifier used by `check-semantic-wrap.ts:16`, not a file on disk |
| `check-harness-skips.ts:135` unconditional `exit(0)` | **`:137`** | strict branch is `:128-130` |
| `sprint-runner.ts:105-137` `runVerifyWithWatchdog` | **`:104-137`** | declaration starts at `:104` |
| `streamed-generate.ts:56` gates `tools` on `hasTools` | **`:57`** | `:56` is the function signature |
| `mcp-server.ts:876-885` `onStop` | **`:876-884`** | |
| BUG-A condition at `tool-engine.ts:1888-1902` (operator note) | comment block is **`:1889-1902`**, `_toolsAreEmpty` at `:1903` | `:1888` is the preceding `}) as unknown as StopCondition` line |
| `describe.skipIf` sites are "neither counted **nor excluded**" | they **are** explicitly excluded | `SKIPIF_RE` at `check-harness-skips.ts:58`, `continue` at `:68`, with a comment declaring `skipIf` "a legitimate platform/env guard, not coverage." The *effect* the brief describes is real — 11 sites uncounted, 4 disabling CI E2E — but it is a deliberate exemption, not an oversight, so fixing it is a policy decision, not a bug fix. An `it.skipIf` would be invisible to **both** regexes. |

Everything else in the brief reproduced exactly, including: 67 spec files / 8 skip-todo hits / 1
unallowlisted; 21 tools vs 22 event kinds vs 14 `FEATURES`; `supports_effort: false` at
`catalog.json:62`; the three `setIsProcessing(true)` sites; `mutation-gate.ts:42`'s fail-open;
29 tracked `.planning` files; `.husky/_/.gitignore` = `*`; and `retry: 2` in the harness config.
