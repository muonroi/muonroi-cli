# Provider flagship orchestration and delegated execution

Status: complete and verified on the local source/build. Final canonical run: 9,435 tests passed, zero failures. No commit, push or deployment was performed.

## Authority and design

The user requested the selected provider's highest eligible tier/price model as main, with high reasoning effort by default. Main coordinates, plans, asks questions and synthesizes evidence; workers read/edit source, execute commands and verify. Main chooses worker models explicitly. EE remains a memory aid rather than a model-selection authority. User-facing council becomes an on-demand background delegation. The user explicitly confirmed that title/compaction services may remain separate infrastructure calls.

Reference framework, read as design evidence rather than applied to this repository:

- `D:/sources/Core/shipd-challenge/shipd-verify/FRAMEWORK.md`: two loops, plan before dispatch, orchestrator ownership, worker/refuter separation.
- `shipd-verify/docs/HARD_RULES.md:610`: seven-field brief, role isolation and no self-signoff. The CLI adapts this to task/model capability selection; it does not import Shipd delivery, signed tier-raise or challenge-specific Docker rules.

An independent research checkpoint mapped current runtime seams. An independent plan review returned two blockers: preserve trusted GSD planning coordination, and enforce read/test-only review capabilities. Both corrections are in the authoritative run artifact before production implementation. Additional controls cover actual worker effects, durable role/model/effort, and permission modes.

Authoritative plan: `.quick-codex-flow/sessions/01a1393f-631b-7752-94f0-59a96a173e2c/runs/orchestrator-only.md`.

## Pre-change runtime evidence

Compiled Agent + actual SDK preparation, offline model fixture, isolated home/settings and SQLite. No paid provider call. Existing `dist` was used before rebuilding current changes. Captured `2026-10-17T09:50:25.194Z`.

| Observation | Actual |
| --- | --- |
| Main requested / selected | `deepseek-v4-flash` / `deepseek-v4-flash` |
| Provider-local eligible premium comparator | `deepseek-v4-pro` |
| Main tools in SDK request | 53, including `bash` and `read_file` |
| Tool schema characters | 36,964 |
| Serialized system-message characters | 80,068 |
| Serialized non-system-message characters | 2,339 |
| Native task public schema | No `modelId` property |
| Native council contract | Synchronous result in the same tool call |

These are fixture-specific JavaScript string lengths, not tokenizer counts, provider invoices or general latency/cost benchmarks. Different main tiers also select different prompt steering, so an after/before prompt-size difference cannot be attributed solely to a tool filter.

Artifacts: `.scratch/orchestration-only/compiled-baseline.mjs`, `compiled-baseline.json`, `compiled-baseline.log`. The first two attempts with `persistSession:false` hit the existing session-dependent path before any prepared SDK request; the accepted baseline uses an isolated persisted session. A chitchat-only initial prompt did not exercise the work tool set. Neither failed setup was counted as main capability evidence.

Source baseline: `.scratch/orchestration-only/baseline.json` and 14 pre-change source copies. HEAD `2d33b8d9a557a8fec30ea4713d98b8469f8f5603`; 189 dirty/untracked paths already existed. Historical WIP and evidence must be preserved and not attributed wholesale to this task.

## Required outcome and verification boundaries

- Deterministic catalog selection, eligibility and high effort; no hidden root routing, budget downgrade or worker substitution.
- Trusted final capability boundaries for root, implementation, research and independent review, including post-MCP assembly.
- Explicit worker model, workspace, budget and return evidence; no recursive dispatch.
- Versioned independent review and acceptance distinct from delivery/ACK; source changes invalidate review evidence.
- Durable asynchronous council with existing cancellation, completion and owner delivery.
- Actual isolated source edit and failing-before/passing-after verification by a distinct context, main follow-up while worker is pending, and negative controls.
- Fresh focused tests, build, native selfverify and independent final audit. Boot-only harness checks do not establish task or council execution. SDK mock results do not establish live entitlement, model quality or paid-provider reliability.

## Verification ledger

The following completed checks cover waves1-3; subsequent integration evidence is recorded below.

| Fresh check | Result | Artifact under `.scratch/orchestration-only/` |
| --- | --- | --- |
| Runtime policy, dispatch, role/auth/permission regressions | 129 tests / 11 files passed | `runtime-accepted.log` |
| Compiled main and actual SDK request preparation | 11 / 11 controls passed | `compiled-main.json` |
| Compiled effort-capable flagship main | 12 / 12 controls passed | `compiled-main-effort.json` |
| Real compatible SDK serialization with local fetch capture | Red: 9 failed / 3 passed; after correction: 15 / 15 passed | `effort-wire-red.log`, `effort-wire-check.log` |
| Related effort regressions | 91 tests / 5 files passed | `effort-wire-accepted.log` |
| Actual Bun TUI, native detached worker, real isolated source edit/test | 12 / 12 controls passed | `tui-worker.json`, `source-before.tap`, `source-after.tap` |
| Typecheck and build at wave1-3 checkpoint | Exit0 | `effort-typecheck.log`, `effort-build.log` |

The SDK wire capture uncovered a real gap: catalog support and an internal `high` setting did not establish transmission of `reasoning_effort`. The correction is verified at request serialization, including an actual StreamRunner worker request. It does not prove the remote account accepts or honors the setting.

The native TUI fixture changed `src/value.mjs` from0 to1. An actual Node assertion failed before and passed afterward. A second user message received a response while the worker was still running; completion later woke main with an owner/version-bound result. The fixture's measured follow-up interval is not a live-provider latency benchmark. Result delivery did not create an acceptance receipt.

At the final compiled checkpoint, root exposed25 tools, with19,869 serialized schema characters and76,047 serialized system-message characters. The baseline fixture exposed53 tools and36,964 schema characters. These are the named SDK fixtures, not a total-cost benchmark: workers add separate requests and the main tier/prompt steering also changed. Root SDK requests excluded direct source/file/shell/test/git and arbitrary MCP execution. Explicit worker selection, persisted permission mode and provider-local credentials are separate controls.

## Independent acceptance protocol

A completed implementation is only a saved result. Independent review binds `reviewOf` to the target job/version and uses a distinct context with read/test-only capabilities. The host records actual tool evidence and a source fingerprint; structured model verdict alone is insufficient. A static review is labelled separately from an executed test review. Test failure, source mutation, stale/tampered output or missing actual evidence blocks acceptance.

The root must be able to read bounded command/input/cwd/exit/success/output evidence through `delegation_read`. ACK records that a version was handled; `delegation_accept` separately binds implementation and reviewer versions to the current source fingerprint. This is point-in-time provenance, not an OS sandbox or a guarantee that a model's semantic conclusion is correct.

Native independent review/ACK/accept, council lifecycle, headless durability, large/sparse Git guards, native boot selfverify and the final canonical suite have been executed. Independent source and documentation reviews passed. All planned outcomes are complete within the verification boundaries recorded here.

## Subsequent fresh acceptance checks

| Check | Result | Artifact under `.scratch/orchestration-only/` |
| --- | --- | --- |
| Compiled headless root -> real worker -> independent reviewer -> accept, including native raw tool retrieval | 11 / 11 passed | `headless-flow.json` |
| Native TUI worker, isolated home separate from source | 12 / 12 passed | `tui-worker.json` |
| Native TUI independent review, actual Node test, raw worker output tail after child exit, ACK separate from acceptance | 13 / 13 passed | `tui-review.json` |
| Final wave4-5 affected regression checkpoint | 117 tests / 7 files passed; typecheck/build0 | `wave4-5-checkpoint.json` |
| Bun-native transcript/export suites | 10 tests / 2 files passed | `bun-native.log` |
| Real managed Shipd worktree source snapshot | 117,808 tracked entries; 2,315ms; Git index unchanged | `shipd-worktree-source-fingerprint.json` |
| Native TUI council, existing full debate/synthesis algorithm | 8 / 8 passed | `tui-council.json` |
| Native TUI council startup failure and cancellation | 14 / 14 failure controls and 14 / 14 cancellation controls passed | `tui-council-lifecycle.json` |
| Actual headless root/child progress, instruction, correlated question/reply and completion | 13 / 13 passed; reply host wait 11,207ms exceeds configured 10,000ms stall limit | `headless-messaging.json` |
| Actual Bun TUI bidirectional exchange, user follow-up during the wait, exact reply and completion callback | 23 / 23 passed; 31,544ms wait exceeds configured 10s stall and 30s progress timeouts | `tui-messaging.json`, `tui-messaging.log` |
| Expanded mailbox, SDK, owner/result, review, tool-boundary, pause/budget and UI regressions | 179 tests / 14 files passed | `phase7-implementation.md` and its named test logs |
| Native selfverify, built tools-MCP and actual Bun TUI | 1 / 1 smoke-boot passed | `native-selfverify.json` |
| Final frozen-tree canonical suite | 1,004 files passed,6 skipped;9,435 tests passed,14 skipped,2 todo;zero failures;exit0;1,134.74s | `broad-final.log` |
| Final typecheck and rebuild after fixture corrections | Both exit0;build log contains zero warning lines;3,470 compiled files scanned | `final-typecheck.log`, `final-build.log` |

The source guard handles sparse flags, Windows regular-file representations of Git symlinks, in-root initialized linked worktrees and empty uninitialized gitlinks. File hashing streams64KiB chunks and checks stability. The dirty primary Shipd root reached the real shared256MiB materialized-data limit because it contains generated agent-home caches; it was refused and its index remained unchanged. No cache paths or specific repositories were whitelisted. This is an explicit capacity limit, not a successful primary-root snapshot.

Independent audit found three reachable gaps: council fan-out refusal, external-only static evidence, and unavailable raw worker output after exit. All three received bounded corrections and a source recheck. Native raw-tail retrieval subsequently established the actual detached capture -> child exit -> main read boundary. A separate native TUI review exposed ancestor Git metadata leaking into ignored nested workspace snapshots; a pure-cwd fallback and a regression corrected that failure without skipping reviewed source.

Native council launch preserved its explicit payload, remained a durable infrastructure job and left main responsive. Its first full-algorithm run produced synthesis but failed during an unintended post-synthesis continuation with a null session. The red proof is retained in `tui-council-null-session-red.json`. An explicit return-only option for detached council corrected that path; the fresh 8/8 full-algorithm probe then passed. The separate native failure/cancellation probe uses private child-startup fault/pause injection and establishes host lifecycle, callback and result retrieval only. Neither probe measures paid-provider reliability, model quality or comparative council cost.

## Added user requirement: bidirectional worker messages

The user explicitly requested main to send and receive worker messages during execution. An independent design review approved extending the existing durable job with bounded, correlated messages, next-step input delivery, idle callbacks, intentional-wait watchdog protection and headless interim-question receipts. Messages do not change role, model, permissions or review constraints; they are distinct from cancellation, result ACK and acceptance. Fresh headless and native TUI exchanges both pass.

Main uses `delegation_send({id,message,replyTo?})`; workers use their host-bound `worker_message({kind:'progress'|'question',message,waitForReply?,timeoutMs?})`. Instructions enter the next safe model step, not an in-flight provider request. Questions remain running jobs and wait for an exact correlated reply by default. See `docs/worker-messaging.md` for the bounded mailbox and lifecycle contract. Existing legacy workers and council jobs explicitly refuse unsupported message delivery; restarting main does not hot-reload their protocol.

The intentional wait suppresses idle/provider stall detection but keeps the original total execution deadline. A direct 80ms-budget control reproduced the old timer renewal during a 300ms wait; the corrected bounded pause expires at the original hard deadline. The headless probe independently holds a real host wait longer than its configured stall limit and completes the same-run exchange.

Worker notices keep raw correlation instructions in model/transcript/export evidence. The TUI renders only user-relevant worker content, including hydrated transcript entries. Pending updates use an update label rather than claiming that the worker has finished.

The native exchange initially exposed a stale semantic composer mirror in the test harness. Ordered native typing followed by Enter reached the root SDK while the worker was waiting; no product input-loss fix was justified. Another initial assertion expected child SQLite rows, although detached workers deliberately use `persistSession:false`. The accepted probe instead validates two raw native worker tool artifacts by SHA-256 and exact reply correlation, alongside three actual main SQLite tool calls. The failed fixture assertions are retained separately and are not counted as successful runs.

Final independent source/test-contract review passed, including the hard-deadline release paths and native-object identity checks. After the final rebuild, main controls passed11/11 and effort controls12/12 at11:54:20 UTC; native boot selfverify passed1/1 again. Final compiled `dist/src/index.js` SHA-256 is `afae4b7a2fff8d73f1bddc4152639cd3a9dba2dccbf37b1218431657ec671908`, matching the entry hash recorded by both main and detached worker in the accepted native messaging probe. This entry hash is a named provenance check, not a claim that it independently hashes every imported module.

Final explicit `bun run typecheck` and `bun run build` exited0. The final build log contains no warning lines. `git -c core.whitespace=cr-at-eol diff --check` exited0; the ordinary whitespace check flags CRLF as trailing whitespace in existing mixed-line-ending WIP, so no unrelated line-ending rewrite was made.

The final canonical full-suite run completed successfully in `broad-final.log`:9,435 passed,zero failed,14 skipped,2 todo;1,004 passed files and6 skipped files;1,134.74 seconds,exit0. Live-provider smoke tests remain skipped under their existing configuration; this is not a paid-provider entitlement or quality claim. The two Bun-native SQLite suites were separately executed with10/10 tests passed.

The first completed canonical run is retained in `broad-canonical.log`:9,419 passed,16 failed,14 skipped,2 todo;998 passed files,6 failed files,6 skipped files;1,573.06 seconds. Initial default discovery included six private `.scratch` fixture test files; bounded exclusions of `.scratch/**` and `.quick-codex-flow/**` leave canonical source tests intact. Legacy implicit-helper/ideal fixtures have been aligned to explicit infrastructure roles, while default-root recovery, ownership and model-selection controls remain root tests. The interrupted initial broad run is not a passing-suite claim.

The first canonical run exposed six additional fixture mismatches. Each was reproduced independently before changing only the relevant test:

| Fixture | Measured cause and bounded correction | Fresh result |
| --- | --- | --- |
| `sandbox.test.ts` | Missing explicit `modelId` correctly refused before background launch. Default-root fixture now supplies its catalog-validated model and fake credential; original sandbox/settings/safe-permission assertions retained. | 4/4 pass, `sandbox-fixture-final.log` |
| `agent-base-url-switch.test.ts` | All eight constructors read real disabled-provider preferences before URL assertions. The exact original eight tests passed under isolated home before editing. Added only per-file temporary home and environment restoration; root URL/auth assertions unchanged. | 8/8 pass, `base-url-fixture-final.log` |
| `subagent-compactor-elision.spec.ts` | New exact argument-retrieval reference makes the marker265 characters, exceeding an obsolete200-character ceiling. Test now proves at least90% reduction and exact toolCallId/arguments retrieval; other no-inflation/idempotency/JSON controls unchanged. | Together with failure-loop: 8/8 pass |
| `stream-runner-failure-loop.test.ts` | Forged `childBash:{}` failed before SDK execution because it lacked `getCwd`. Added a typed fake method; actual repeated-failure call counts, abort stability and successful-call assertions retained. | Together with elision: 8/8 pass |
| `model-owned-council-entry.test.ts` | Forged tool-engine dependencies lacked `bash.getCwd`. Added the read-only fake and explicit orchestrator role; original heavy PIL labels, zero synchronous council and one leader turn remain. Added zero asynchronous council launch assertion. | 1/1 pass, `council-entry-fixture-final.log` |
| `compaction-proposer-malformed-json.test.ts` | Mock logger lacked `file`; file-only diagnostics therefore threw before null fallback. Added file logger capture and current parse/fallback assertions; both null cases, exact valid response, no console warning and exactly one proposer call preserved. | 3/3 pass |

These fixture corrections did not change production source, dist or real user settings. Fresh combined execution of all six corrected files passed24/24 in19.66 seconds,exit0 (`final-fixture-regressions.log`). The initial canonical red run is retained. The complete frozen tree then passed the final run above, with the same scope and verbose reporting.

## Handoff

Restart the interactive CLI with Bun to load the rebuilt runtime, for example `bun D:/sources/Core/muonroi-cli/dist/src/index.js`. A currently loaded older TUI or worker is not hot-reloaded. New worker jobs declare messaging protocol1; legacy jobs and council jobs reject unsupported sends explicitly.

Evidence manifest: `.scratch/orchestration-only/final-evidence.json`. The authoritative run and feature-close artifact record completion. No checkpoint commit was created because affected files overlap pre-existing uncommitted work; the original index, user settings, jobs, exports and unrelated WIP were preserved. No external release, push or deployment is implied by this local verification.
