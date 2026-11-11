# Runtime permission visibility and verification defaults

## Evidence and scope

The latest agent feedback identifies two concrete problems: the agent cannot tell which permission mode applies, and several verification entry points are presented without a clear default for small tasks.

Before the repair, actual compiled `buildSystemPromptParts` calls with `safe` and `yolo` both omitted permission metadata (`safeVisible=false`, `yoloVisible=false`). The static prefix was identical, as expected. Three functional regressions failed before implementation. The source dynamic suffix contained date/cwd but no mode; `MessageProcessorDeps.permissionMode` is the same caller-owned property consulted by the streaming approval handler.

The existing operating contract and native capability text also instructed the agent to always run TUI selfverify when finishing any task. This conflicted with task-specific verification: the already available `verification_run` runs explicit installed local Vitest files, while selfverify drives the TUI. The feedback does not supply a measured latency or cost comparison, so this repair makes no such claim.

## Changes

- `src/orchestrator/prompts.ts:454,636`: optional caller-provided permission mode is rendered in the dynamic suffix alongside the actual passed sandbox mode. It is a **prompt-assembly snapshot**, not an authorization grant or a promise that every tool will auto-approve. Callers without the information explicitly display `unavailable`.
- `src/orchestrator/message-processor.ts:1687,1701`: first-call and reduced tool-turn prompts receive `deps.permissionMode`. The context estimator in `orchestrator.ts` also includes it. No user settings file is rewritten.
- The value stays outside the cached static prefix. Non-Claude dynamic-tail relocation retains it. This does not guarantee continuous refresh inside an already running SDK stream if a mode changes after assembly; enforcement continues to consult the actual runtime state.
- `src/pil/agent-operating-contract.ts:55` and `native-capabilities-workbook.ts:42`: one named verification-routing section gives the default: focused existing local Vitest tests through `verification_run`; repository-approved other runners/builds through `bash`; focused checks **plus** selfverify for UI/harness/workflow changes. Pure discussion needs no harness. Do not execute both entry points for the same check. Repository-required checks still apply.
- Known bounded small tasks use direct tools with focused checks; delegation is optional. Unresolved scope requires research, and local workflow requirements still apply. No new mode, runner, fixed size-to-depth mapping or forced GSD override was introduced.

The StreamRunner child prompt path does not pass a permission mode, so it reports `unavailable`; it does not claim that the parent's mode governs its independent execution path. This remains an explicit limit of permission visibility. Native sub-sessions that use MessageProcessor obtain their own caller snapshot.

## Fresh checks

| Check | Result |
| --- | --- |
| Existing baseline prompt/permission suites | 63 passed / 4 files |
| New missing-mode regression before implementation | 3 failed / 1 file |
| Final focused suites | **104 passed / 10 files**, exit 0 |
| Build | Exit **0**; initial nullable-provider test-fixture typing failure corrected using a catalog model, retained in build-red.log |
| Actual compiled prompt/cache/approval controls | **13/13** |
| Native/MCP controls | **15/15** |
| Native mock TUI smoke-boot and passive-log | **2/2**, run **9167d7a2-66ca-4ec8-82dd-f14530e61477** |
| Whitespace check | Exit **0** |

The compiled controls cover all three mode values, immutable prior snapshots, identical cached prefix bytes, reduced tool-turn context, unavailable-mode reporting, actual Bash sandbox state, non-Claude relocation, child non-inheritance claims and unchanged approval predicates. For example, the existing `auto-edit` predicate allows a non-dangerous shell command and requests approval for the tested dangerous one. The independent catastrophic-command guard still rejects the fixture command. These are predicate checks, not a new claim that every execution path requests approval identically.

Character measurements are not tokens or provider cost:

| Component | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Operating contract | 1,998 | 1,988 | -10 |
| Native capabilities | 13,149 | 13,883 | +734 |
| Dynamic policy snapshot in compiled fixture | Absent | 162 | +162 |

The verification explanation increases native guidance size. This is a clarification and permission-visibility repair, **not** total prompt compression, a measured cost reduction or measured faster agent behavior. The snapshot line includes terminal punctuation; the recorded count is from the compiled output. No HTTP token breakdown is inferred from character lengths.

Private reproduction scripts/logs are under `.scratch/runtime-permission-verification-guidance/`; [the bounded evidence manifest](evidence/runtime-permission-verification-guidance-2026-10-16.json) records their hashes. Native selfverify uses isolated settings/SQLite, a mock model and a fake fixture credential. No paid StepFun call, original DB write, user-process termination, TCIS edit, root GSD state edit, commit, push or deployment was performed. Existing processes must restart to load rebuilt modules.

## Remaining feedback

Full prompt minimization, automatic context restoration and a main-versus-worker cost comparison remain separate work. Earlier elision evidence-retention repairs do not restore historically overwritten arguments or remove explicit retrieval. A child invocation has its own context/request cost; simple reads do not require delegation.

MCP parameter schemas are intentionally reduced in the normal exposed schema and `describe_tool` reads the original server schema. This matches the reported discovery friction, but does not establish a broken schema or justify sending every full schema on every request. The preceding read-only gate repair allows `describe_tool` under heavy/revise.

The feedback supplies no fresh 429 headers/counters or erroneous GSD block for a one-line code fix. Existing quick/informational paths and the repaired read-only boundary remain in place; no further hard-gate bypass was inferred from subjective overhead. Sandbox configuration or threat-model text alone does not prove active isolation; the actual Bash fixture reports `off`.
