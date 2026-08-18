# Harness CI failure repair

## Resume Digest

Goal: repair the failed GitHub Actions Harness Suite push run `32110502517`.
Current gate: execute. Execution mode: auto.
CI evidence: job `95628725595` failed after `928.77s` with (1) `council-plan-gate.spec.ts:113` expecting `10`, receiving `11`; (2) `determinism.spec.ts:282` timing out at `240000ms`; (3) `gsd-native-flow.spec.ts:72` missing `planningArtifact(..., "STATE.md")`.
Affected area: `tests/harness/` and the runtime paths each test exercises. Protected boundary: preserve user changes in `.planning/STATE.md` (`MM` before work).
Next verify: run the three focused harness specs after the planned minimal test repairs, then the complete harness suite.

## Research Pack

- GitHub run: `32110502517`, job `95628725595`, `harness`, push SHA `2a7217c6fb68dfb8b50b375e6961bf7dd53a7bf5`.
- The checkout HEAD is the same SHA; no later local commit changes the failure.
- Experience constraint `[id:b7eaf24f col:experience-selfqa]`: use the harness's rendered/live state rather than inventing event protocol fields when verifying a TUI card.
- Focused reproduction (`bunx vitest -c vitest.harness.config.ts run council-plan-gate.spec.ts gsd-native-flow.spec.ts`): identical failures at council line 113 and GSD lines 72/92.
- Council evidence: `src/council/launch-card.ts` now adds `Edit topic or outcome` when `allowEdit !== false`; the S1 card has 6 intent options plus 5 shape options. The harness assertion and fixture still state 10.
- GSD evidence: `packages/agent-harness-core/src/driver.ts:297-350` records an idle as a generic quiescence event, while `tests/harness/gsd-native-flow.spec.ts:67` uses it as completion proof. With `MUONROI_DEBUG_MOCK_MODEL=1`, the same focused GSD test passes and logs a task classification; the current source path then calls `loop-host.ensureHost` and `syncWorkflowContext` (`src/orchestrator/message-processor.ts:799-800`) before writing the planning artifacts. The test must wait for the promised filesystem artifact, not the non-specific idle signal.
- Determinism evidence: CI timed out each test attempt exactly at the configured `240000ms`; `tests/harness/determinism.spec.ts` has 5 sequential runs, up to 3 attempts each, and per-attempt timers totaling 135 seconds. Its reachable worst case exceeds its test timeout by a wide margin.

## Verified Plan

1. Update the council test and fixture to the 11-option launch-card contract; retain its rendered recommended-option assertion.
2. Make the GSD bootstrap test wait for `STATE.md` and `config.json` to exist before reading them, removing dependence on a false idle event.
3. Run determinism through the shared `spawnHarness` driver, disable interactive discovery, wait for the rendered assistant reply, and compare three normalized final frames. This removes the old retry/safety-timer path whose reachable runtime exceeded the 240-second test timeout.

Plan check: PASS. Each change is confined to the failing harness contract and has a focused verification command.

## Status

Execution wave P1/W1: complete. Test-only repair in `tests/harness/` and its LLM fixture; no production behavior change.

## Verification

- PASS: `bunx vitest -c vitest.harness.config.ts run tests/harness/council-plan-gate.spec.ts` — 1 file, 1 test.
- PASS: `bunx vitest -c vitest.harness.config.ts run tests/harness/gsd-native-flow.spec.ts` — 1 file, 2 tests.
- PASS: `bunx vitest -c vitest.harness.config.ts run tests/harness/determinism.spec.ts` — 1 file, 1 test.
- PASS: `CI=true bunx vitest -c vitest.harness.config.ts run tests/harness/council-plan-gate.spec.ts tests/harness/gsd-native-flow.spec.ts tests/harness/determinism.spec.ts` — 3 files, 4 tests, 12.65 seconds.
- PASS: `bun run typecheck` (`tsc --noEmit`).
- PASS: `git diff --check`.
- BLOCKED LOCAL FULL-SUITE: with `CI=true`, the three repaired specs did not reproduce their GitHub failures, but Windows Bun `1.3.13` child processes repeatedly crash in `opentui.dll`; unrelated `compact-progress` and `visual-capture` then fail, and several unrelated specs fail cleanup with `EPERM`. The original GitHub job `95628725595` did not report those failures. No speculative change was made for the different local runtime failures.

Current gate: phase-close. No commit or push was performed.

## Push Gate

The user requested commit and push after this repair. `bun test` was started as the repository-required pre-push gate on 2026-08-18 and produced no completion output before the 1,204-second command limit terminated it. The required full green test result is therefore absent; no commit or push was performed.
