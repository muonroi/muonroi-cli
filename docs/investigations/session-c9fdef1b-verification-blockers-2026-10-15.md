# c9fdef1b04d4: verification bootstrap and durable handoff follow-up

Date: 2026-10-15. Workspace: `D:/sources/Core/muonroi-cli`.
This report concerns fresh verification of the current working tree, including uncommitted changes. It does not treat the earlier 160-test log as current evidence.

## Findings and repairs

### Verify worker invoked Shuru although its sandbox was off

The actual stored `clever-teal-wolf.json` records `sandboxMode: "off"`, execution cwd `D:/sources/CompanyLibs/tcis-libraries`, and error `Verify checkpoint bootstrap failed for "verify-dotnet-032b67da8312": ENOENT: no such file or directory, uv_spawn 'shuru'`.

The brief named the CLI repository, but the task API had no structured execution-cwd field. `StreamRunner.setup` used the parent's shell cwd and omitted the final sandbox-mode argument to `prepareVerifySandbox`. That function defaulted to Shuru and called `ensureVerifyCheckpoint` unconditionally. The separate top-level verify orchestrator already had an off-mode guard; native task workers used the other path.

Repairs:

- `src/orchestrator/stream-runner.ts`: pass the worker's actual sandbox mode and resolve an explicit `TaskRequest.cwd` relative to the caller's cwd.
- `src/verify/entrypoint.ts`: off mode skips checkpoint bootstrap. Explicit Shuru mode retains checkpoint preparation; absence of the executable is not silently bypassed for that mode.
- `src/tools/registry.ts`, `src/types/index.ts`, `src/orchestrator/delegations.ts`: expose, forward and persist task cwd, including background launch cwd. Owner-scoped result storage remains independent of execution cwd. Directory names in prose are not parsed as execution instructions.

The regression `does not bootstrap shuru when the worker sandbox mode is off` failed before the fix. A real compiled CLI background verify entrypoint subsequently completed with mode off in a disposable .NET workspace. This native control uses an offline model marker and proves bootstrap/lifecycle, not C# correctness.

### Selfverify resolved the CLI entrypoint in the caller's repository

Both tier1 and agentic Self-QA used `resolve("src/index.ts")` and cwd-relative test fixtures. From another project this selected that project's path instead of the CLI's entrypoint. A disposable foreign-cwd reproduction returned `Named pipe ... client did not connect within 1500 ms` with the reduced diagnostic timeout. The original session's report used the default 90-second timeout. No timeout increase was used as a repair.

`src/self-qa/runtime-paths.ts` now anchors CLI entry and offline fixtures to the executing module, for both source and compiled installations. The build copies the minimal fixture into `dist/src/self-qa/fixtures`, which is included by the package's existing dist rule. Explicit entry/fixture overrides remain available.

The native and MCP selfverify APIs now accept explicit `cwd` and `files`. The shared job/runner forwards them to the scenario planner, including an explicit empty list. A task can avoid selecting unrelated dirty/deleted files. Omitting `files` retains the existing diff-based behavior; this does not automatically discover which files an agent owns.

### Delivery claims could precede durable main-context storage

The manager previously saved notification delivery state before `Agent.consumeBackgroundNotifications` appended the notice to the main transcript. A failed append could therefore suppress a result that main had never durably received.

The manager now invokes an owner persistence callback under the job lock before recording delivery. Main stores the notice in SQLite before adding it to memory. Retrying after an interrupted job-record commit checks raw persisted transcript text before appending, avoiding duplicate durable notices. Failure of one job's handoff is logged and leaves that version pending without dropping other successfully delivered notices.

Fault-injection regressions cover a failed owner handoff, restart/retry, and a SQLite commit followed by a failed job-record write. The latter verifies one persisted notice across retry. ACK remains a separate explicit action and is not acceptance of a worker's conclusions.

This is durable handoff, not transactional exactly-once model processing across SQLite and filesystem state. Already delivered/ACKed versions are not routinely reannounced. A delivered but unACKed result is not automatically replayed on a timer.

### Error signalling, retention and child capabilities

- `DelegationManager.readResult` returns structured failure for missing/unreadable/tampered artifacts, and the Agent wrapper preserves that failure. The string-returning `read` helper remains for compatibility. A successfully retrieved failed-job report remains a successful read operation, with the job failure visible in the report.
- Compaction says a long log was retained only after the persistence callback returns successfully. Without that confirmation it explicitly reports `Artifact retention unconfirmed` and preserves job/version/saved-result references for another read.
- Child system prompts list the tool inventory actually granted after builtin/MCP composition and provider capability filtering. They instruct the child to report missing capabilities. This does not add absent tools or waive explore's read-only restrictions.

## Fresh verification

Private raw logs, reproducer and full native reports are under `.scratch/verification-blockers-c9fdef1b/`. Shareable measurements and the native measurement tool are under `reports/verification-blockers-c9fdef1b-2026-10-15/`.

The compiled native MCP experiment starts the actual `dist/src/index.js tools-mcp` from a disposable .NET directory with an isolated home. It checks discovery of the new schema, invokes `selfverify_start`, reads status/result, and asserts exact scenario input files. Two runs reached idle and passed 1/1. A separate compiled native background verify worker completed without Shuru. No real provider is called; all model output is an offline fixture.

The focused family includes all `src/verify` and `src/self-qa` tests; native/MCP selfverify routing; delivery, ownership, compaction, helper evidence, real SQLite handoff, stream-runner, main handoff and task routing. Final counts, durations and build exit status are recorded in the accompanying verification JSON.

## Runtime adoption and limits

The installed global CLI package is a junction to this checkout. Rebuilding updates its dist files for the next launch. Already running TUI/MCP processes keep their loaded code/schema and must be restarted, then the existing session can be resumed. No user session, job record, credentials, or TCIS workspace was changed by these controls.

The native selfverify results establish boot/transport/idle and task-input selection. They do not establish complete modal behavior, analyzer correctness, live-provider health, or paid StepFun rate-limit behavior. The focused suite is not a full-suite claim. No commit, push, npm publication or server deployment is part of this follow-up.

Strict EE project filtering, multi-file read range semantics, and broader inherited-workflow/budget policy remain separate work. The new explicit file-selection and actual-tool inventory contracts do not establish that those broader feedback items are fixed.
