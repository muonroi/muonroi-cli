# Worker process boundary and failed-after-edit handoff

## Verified incident

Session `4edc02516a92`, `lively-ivory-panda`, resultVersion `9b978bc0911c273932e9a15936fa12362767de7b45acd8af9bb7651c836f912c`, ended with `worker_incomplete: no final answer was produced` and `Last action: Edit file`. The job has 106 captured tool results. This is an observed missing final answer; a schema or output-limit cause is not established.

The final five capture digests were checked against their raw bytes. The last three are successful `edit_file` results for `src/src/TCIS.MCP.Docs/Indexing/DocIndexer.cs`:

| toolCallId | capturedAt UTC | result |
| --- | --- | --- |
| chatcmpl-tool-914c55123de60ebe | 2026-11-04T03:28:06.369Z | success=true |
| chatcmpl-tool-8aef3c51a2c6a1d7 | 2026-11-04T03:28:17.619Z | success=true |
| chatcmpl-tool-a91fc3c55a7cdd11 | 2026-11-04T03:28:27.961Z | success=true |

These prove saved tool results, not the current consumer file or a successful build. No consumer edits, builds or failed-job replays were performed here.

The earlier external `taskkill //F //PID 37968 //PID 23116` execution and unsupported prompt-length/lock claims are documented in [the preceding schema investigation](session-4edc02516a92-worker-schema.md#follow-up-audit-of-the-coordinators-recovery-report).

## Changes

- Worker BashTool instances and the final native registry refuse explicit process termination, dotnet build-server shutdown and NuGet cache clearing. Checks run before cwd changes, shell spawning and safety overrides. Covered command forms include shell wrappers, chains, pipelines and executable paths. Native process_stop remains restricted to the owning instance's background map. Host cancellation keeps its existing own-child cleanup.
- Failed durable jobs now retain a host-derived recovery record: observed terminal symptom, root cause unestablished, captured edit/command counts, evidence-gap marker, and at most eight recent mutation/command references. The full existing capture manifest remains authoritative. Counts refer to calls, not confirmed applied changes.
- Failed-job titles/summaries no longer promote partial model narration such as “Everything is done.” The original output remains available as evidence. Status stays failed and independent acceptance is unchanged.
- Result reads and owner notifications direct main to inspect the version-bound captures and current files before assigning the remaining repair. Existing failed results receive guidance on read without rewriting their saved output or resultVersion. No automatic edit/command replay is introduced.
- Main and worker contracts distinguish schema errors from prompt/context limits, access denial from lock ownership, and later recovery from a proven original root-cause fix.

## Validation

- Before the policy change, all eight safe preparation-only reproductions accepted prohibited worker commands; the regression failed eight assertions. No historical destructive command was executed.
- Before recovery metadata, four isolated failure-handoff tests failed, including promotion of a false completion summary.
- Final focused regression: **126 tests, 12 files, zero failed**. Includes actual mock SDK worker execution in yolo, safety-override refusal, native owner/foreign process-map handling, partial edits retained, raw-capture digest verification, no replay, unchanged acceptance, legacy result immutability, rate-limit guidance, error redaction and UI delegation projection. One stale root-role test was updated to assert the already-authorized read_file/grep grants while retaining mutation/command exclusions.
- Typecheck passed; final `bun run build` passed including TypeScript compilation. Scoped `git diff --check` passed.
- Built workspace native selfverify `2c6c5600-1ea8-4715-8a59-66c246774f21`: smoke-boot **1/1 passed**, zero failed/inconclusive. This boot test does not establish live provider behavior or solve the historical missing-final cause.
- Global install resolves to this workspace; compiled boundary/recovery/stream-runner files match through both paths. Existing processes must reopen/resume to load new modules.

## Limits

This is a visible-command policy, not an OS sandbox. Arbitrary scripts, indirect invocation and granted external tools are not proven contained by it. The historical worker's no-final root cause remains unknown. Recovery guidance improves what main can inspect; it does not certify current consumer contents, tests, whole-goal completion or model compliance. The full repository suite was not run; no commit/push or live restart was performed.
