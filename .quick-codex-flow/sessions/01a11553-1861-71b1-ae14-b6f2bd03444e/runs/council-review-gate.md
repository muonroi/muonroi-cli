# Council review delivery and research gate

## Resume Digest
- Goal: unblock evidence gathering and clarification during heavy plan review; deliver the model verdict contract to the final council leader.
- Gate: research; mode auto; single agent; balanced budget.
- Required outcomes: read-only delegate and ask_user work under a locked heavy gate; mutations remain locked; GSD verdict requirement survives intermediate spec/planner transformations and synthesis retry.
- Protected: user .planning artifacts, session DB, settings, exports; permission checks, helper ownership and read-only enforcement; conservative parsing, actual revise/block decisions; ordinary council output.
- Baseline: clean develop at 7a2694c8.
- Unknown: actual final-leader prompt propagation and runtime gate behavior; close with failing regressions before production edits.
- Next verify: isolated gate tests and runPlanning wire capture, then workflow integration.
- Session/context/burn risk: low; stall none; approval local-only.

## Research Pack
- Export ea7378aab8f8:1663-1664 actually blocks ask_user; :3598-3599 blocks delegate. :2544-2545 contains a real structured revise, and later reviews include concrete concerns. A parse failure does not establish approval.
- mutation-gate.ts allowlist omits ask_user/delegate. tool-engine.ts wraps both as guarded.
- delegations.ts:70 rejects all background agents except explore; no blanket task exception permitted.
- plan-council-prompts.ts appends VERDICT_OUTPUT_CONTRACT to the topic. Production synthesis is rebuilt from a ClarifiedSpec and model-selected outputShape in planner.ts/prompts.ts, without a caller-owned contract channel.
- Experience constraints: retain model-emitted JSON as authority; never infer approval from prose. Preserve cwd-owned workflow artifacts and main ownership.

## Roadmap and verified plan
1. Reproduce gate and contract-delivery failures in isolated fixtures, inspect complete delegation restrictions.
2. One execution wave: allow only proven research/control tools through the plan gate; thread an optional caller output contract from GSD review to final synthesis and retry. Preserve cancellation and default council behavior.
3. Verify focused units, build/typecheck, native workspace selfverify, full configured Vitest suite before release. Commit scoped changes with normal hooks; preserve user task state.
- Plan check: pending reproductions; no production execution while facts unresolved.

## Compact-Safe Summary / Wave Handoff
- Current phase P1 / wave W1 research, same-phase.
- Do not auto-pass user review or change PLAN-VERIFY.md; readonly research must not unlock editing.
- Recommended next command: run isolated regressions; close research and plan-check before production edits.

## Research closure / Plan check
- Reproduction council-review-repro.log: 2 failed, 14 passed. Actual runPlanning LLM call lacks the requested contract on both attempts; delegate gate returns blocked=true.
- Export confirms ask_user tool rejection, not merely an assistant claim.
- Required fix applies to verify council as well: it uses the same runDebate transport and verdict parser/contract.
- Resolved: optional contract string travels independently of spec and shape. Default callers omit it; ordinary synthesis stays unchanged. No full-debate retry or heuristic approval added.
- Plan check PASS: bounded gate exception only for existing explore-only delegate, ask_user and delegation_kill; task/bash/unknown remain gated. Cancellation and genuine revise/block retained. Full suite and native smoke required before push.
- Gate execute: phase P1 wave W1; next verification focused workflow/council/delegation tests and build/typecheck.

## Wave W1 implementation checkpoint
- Final leader gets an explicit optional synthesisOutputContract, bypassing lossy spec/shape transformation. Both plan and verification review supply the existing authoritative verdict contract. Ordinary council omits the option.
- Gate exceptions: explore-only delegate, ask_user, delegation_kill. SDK wrapper also exempts them from the mutation mutex. Foreground task and writes remain gated.
- Initial focused units: 48 passed; actual SDK integration and workflow bridge: 15 passed, including research + question + blocked write under persisted heavy/revise.
- Existing child restriction verified: stream-runner.ts:351 selects ask mode for explore; DelegationManager.start rejects non-explore.
- Native QA uses workspace tools-mcp because the external cached npx package has a known missing selector export; receipt will explicitly identify workspace build and boot scope.
- Broad verify handoff: scope fixed, no active gray areas, next full suite bun run test after final formatting/typecheck. Build and native QA can run independently of read-only test verification.

## Verification checkpoint
- Build succeeded (tsc plus import-extension repair); no build errors or warnings. Initial tsc --noEmit also passed.
- Final focused verification: 223 tests passed across 36 files, zero failed.
- Native workspace tools-mcp run a890a29c-93f0-4f7c-baef-f083bc04da60: tier1 smoke boot 1 passed, 0 failed, 0 inconclusive. This is boot evidence, not live-provider review or a full TUI interaction proof.
- Formatting: 16 files checked/fixed; existing broad-file lint warnings remain (115 warnings, no errors). No unrelated warning cleanup expanded the scope.
- Full configured suite running, log council-review-full-unit.log. Pre-suite hash manifest council-review-tested-source.log covers 1933 paths under src/packages/scripts/tests. Compare before push to prevent tested-source drift.
- Residual: model output compliance is not guaranteed; malformed/missing verdict stays conservative revise. Research and clarification remain available in that state. No automatic approval inferred from prose.

## Reopened boundary and relock
- New concrete SDK reproduction council-review-child-repro.log: explore bash executed `echo MUTATION > forbidden.ts` successfully under heavy/revise. Ask mode removes write/edit tools but retains bash; it is not a shell read-only guarantee.
- Prior artifact statement about explore read-only enforcement applies only to agent type / tool registration, not shell effects. Corrected scope: background research must carry the same GSD bash gate as main.
- Old full-suite process 43012 stopped because source changes require a fresh full pass; it is not a release result.
- Plan amendment: wrap explore child bash with evaluateMutationGate at dispatch, using the originating topBash cwd and current hard-gate flag; keep normal tool guards, sandbox and execution unchanged after a genuine pass or gate opt-out.
- Gray area resolved by actual executed shell/file reproduction. Plan check PASS: same authorization boundary, one extra production file stream-runner.ts; no command regex or custom shell security parser; unit test asserts physical file absence and visible blocked result.
- Wave W1 remains active; next narrow verify SDK research + child gate, then formatting/build and a fresh complete unit suite.

## Child authorization checkpoint
- Child verify: 17 tests across 4 files passed after the shell gate fix. Added genuine-pass and opt-out cases to prove unchanged authorized behavior.
- Native questions TUI: askcard.spec.ts 3 passed, zero failed; live TUI startup, question modal and keyboard option navigation verified using mock providers in an isolated cwd.
- Final build and expanded focused suite running. Fresh full-suite source manifest captured after final formatting; previous interrupted suite log retained only as aborted evidence.

## Final-source verification in progress
- Final build passed, no compiler/import errors or warnings.
- Expanded focused suite: 228 passed across 37 files, 0 failed. Includes child shell blocked under heavy/revise, permitted under real pass and hard-gate opt-out, parent research/question dispatch, cancellation, schema contract and normal-council compatibility.
- Final full suite command bun run test, log council-review-full-unit-final.log, session 66728. Baseline hashes re-captured after child fix and final formatting, 1933 files; old suite result invalidated rather than reused.
- Next: await complete green unit summary, compare source map, normal hooks/commit/push, remote SHA, final receipt.
- Final-source native run: 1af75a8c-dee9-4c43-bb77-1353d55b5f82, workspace tools-mcp, smoke-boot 1 pass / 0 fail / 0 inconclusive.
- Experience feedback closed: c2d2f6cc followed for model-first verdict; 00d7f8c6 followed for protecting cwd-owned state; cb5558f9 ignored because no depth-to-council policy changed.

## Commit checkpoint
- Implementation commit c957f10b created with normal secret scan, lint-staged and commit-message hooks.
- Post-hook comparison: all 1933 tested paths match baseline SHA256; no source drift.
- Full unit suite still pending; no push attempted. Final native QA evidence supersedes initial boot run.
- Raw synthesis return verified at council/index.ts:3130; GSD consumes full councilManager.lastSynthesis rather than readable-only UI text, preserving the additional verdict block.

## Concurrent remote integration
- Full suite completed: 8860 passed, 0 failed, 14 skipped, 2 todo; 946 passed files / 6 skipped; 840.10s. Source map checked after suite: 1933 paths, zero hash or path drift.
- First push passed native pre-push and binary compile hooks, then remote rejected non-fast-forward.
- origin/develop advanced to ab12c5b2 via a master/develop merge. Compare the exact baseline 7a2694c8 to the fetched remote tree before integrating; no force-push or reset.

## Phase / feature close
- P1 W1 DONE. Required outcomes verified: research and questions available during heavy/revise; mutations gated in main and explore shell; final leader receives explicit verdict contract on normal and compact synthesis attempts; actual pass and opt-out remain supported.
- Full suite 8860 passed, 0 failed; build clean; 228 focused units; 3 TUI question tests; workspace native smoke 1 passed / 0 failed / 0 inconclusive.
- Source unchanged through commit hooks and history-only remote integration: 1933 hashes match, no path drift. Remote ab12c5b2 had an identical tree to the original baseline; integrated via merge without reset/rebase/force.
- Implementation c957f10bdc93883cfb2bbc7394da03b8186e1a48 and merge a5acbd28364cf9643133d139c357bd98cb8100fe pushed with normal hooks; origin/develop SHA confirmed a5acbd28364cf9643133d139c357bd98cb8100fe.
- Remote required-check expectations were reported by the server; remote CI is not verified by this local release.
- Model compliance remains probabilistic: missing JSON keeps conservative revise, with research/clarification usable. No live paid-provider review was invoked, no user plan verdict overridden, no DB/settings/export edited.
- Execution gate: done. Mode auto; session/context/burn risk low; stall none; approval local-only; phase relation feature-close.
- User runtime next step: restart CLI and resume ea7378aab8f8 so the rebuilt junction-linked CLI loads the new code. Main remains responsible for the current plan and any genuine review concerns.
