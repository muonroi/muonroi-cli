# Worker catalog admission under a locked heavy workflow

## Evidence and attribution

The user supplied a bounded probe transcript captured at 2026-10-19T02:24:07.044Z, cwd `D:\sources\Core\muonroi-cli`, yolo with sandbox off. It contains verbatim FLOW refusals for `worker_models` and one `task(agent=general, background=true, maxToolRounds=6)`. Its session ID, toolCallIds and loaded process revision are unknown. No claim is made that this transcript proves Unicode/schema behavior, zero transport requests, or worker execution.

At inspection, this workspace's `.planning/STATE.md` contained depth `heavy`, phase `plan`; `.planning/PLAN-VERIFY.md` contained `verdict: revise`. These were read, not changed. Their latest write timestamps were 02:24:06Z and 02:10:50Z respectively, before this repair.

## Two distinct outcomes

1. **Catalog discovery was incorrectly blocked.** `worker_models` and `worker_capabilities` are native orchestrator introspection tools. The shared workflow read-only list omitted both, so the top-level tool wrapper called `canExecute` before their executors. The actual SDK regression reproduces this refusal with heavy/revise state and an isolated database.
2. **General task dispatch is deliberately subject to mutation admission.** Existing regression controls explicitly deny general/verify tasks under heavy/revise. General workers receive mutation tools; exempting their dispatch would route around the gate that protects workspace writes. This repair does not unlock general dispatch, change a review verdict, or override permissions. A read-only explore worker's shell remains independently gated against the originating workspace.

## Changes

- Add only the exact `worker_models` / `worker_capabilities` names to `WORKFLOW_READ_ONLY_TOOLS`. Final native identity/role filtering, provider eligibility, MCP grants and permission checks remain in place. Capability discovery may connect configured MCP servers; it does not execute their content tools or grant them to a worker.
- Give denied `task` calls a specific mutation-capable-worker refusal. It states no worker was launched by the call, distinguishes workflow admission from authentication/permission mode, names available discovery/read-only alternatives and instructs a probe that forbids workflow changes to stop. It does not recommend forcing the gate.
- Correct `flow_status.gateScope`: `canExecute` is not a universal dispatch lock, but an enabled heavy-depth mutation gate separately checks mutation-capable task dispatch. Safe/auto/yolo permission mode does not satisfy a plan review.

## Verification

Evidence directory: `.scratch/worker-catalog-gate/`.

| Check | Result | Boundary |
| --- | --- | --- |
| Unit before-control | 3 new expectations fail, 18 existing pass | Both catalog refusals and generic task message reproduced |
| Corrected SDK before-control (`sdk-before.log`) | Fails on missing native inventory output | Real Agent/tool wrapper, mock provider, heavy/revise private state; catalog names removed only for this control and restored afterward |
| Focused regression (`tests.log`) | 65 tests / 7 files pass | SDK inventory calls, no general worker launch, heavy write/edit/bash refusal, originating explore shell gate, model/role routing and status |
| Typecheck (`typecheck-final.log`) | Exit 0 | Earlier fixture-only ProviderId type error corrected before successful run |
| Build (`build-final.log`) | Exit 0 | Fresh dist produced; does not prove a previously running process loaded it |
| Built registry/admission (`compiled-controls.json`) | 8/8 pass | Native catalogs readable, targeted task refusal, zero dispatch callback calls, mutation lock retained, explore admission, accurate status, planning digest unchanged |
| Native `selfverify_*` (`native-selfverify.json`) | Boot 1/1 pass | Isolated tools-MCP + real Bun TUI, offline provider; boot only |

The initial SDK test used `persistSession=false` and failed on a null session before any model request. This was a fixture defect, not gate reproduction. The corrected fixture persists only to a private HOME/USERPROFILE/CLI DB and asserts its path before running. The later failing before-control and green run are the accepted SDK evidence.

No paid-provider calls, real detached worker, source fixture write/edit probe, historical schema reproduction, production session/credential/settings changes, deployment or push occurred. Local mock provider requests establish the tool-wrapper path only. Full suite was not run.

## Remaining boundary

Restart the built CLI with Bun to load this repair. Inventory calls should become available; a general write/edit probe in the existing heavy/revise workflow remains refused. A separate design would be needed to bind workflow admission to individual active tasks rather than shared workspace state. This repair neither invents that ownership nor clears another task's reviewed state. Unicode write/edit/read and the historical ModelMessage schema failure remain unverified by this probe.
