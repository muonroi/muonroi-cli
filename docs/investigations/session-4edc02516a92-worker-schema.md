# Terminal worker synthesis schema blocker

## Proven live-job boundary

Session `4edc02516a92` tool message seq908 (`2026-11-04T02:52:53.377Z`) returns `eager-teal-wolf` as failed with `Invalid prompt: The messages do not match the ModelMessage[] schema.` Its saved resultVersion is `71a34fd85711c3908bcc8c79034d4987604e5e42b36477e47fbc540414259221`.

The job configured30 model rounds and captured44 tool calls:16 reads,12 edits,12 shell calls and4 searches. Rounds can contain several calls;44 does not itself violate30 rounds. Native `debug.log:8043` records terminal `finishReason=tool-calls`, no terminal text and `synthesisRequired=true` immediately before the failure. The earlier `steady-indigo-heron` has201 captured calls/110 rounds and the same terminal synthesis boundary at `debug.log:8036`. Another preceding worker was cancelled; these records do not establish three identical schema failures.

The last saved build artifact `call_26b66066f2cf4beeb78e2780` at02:49:02.500Z contains actual C# compiler errors, including CS0246 for MarkdownParser/StringBuilder, CS0118 for RedactionReport and CS1061 for IReadOnlyList.Add. The final shell artifact is a failed `head` lookup of Internal/MarkdownParser.cs, not a new build. These are historical worker results; no current consumer build was run here. A NuGet concurrency cause is not established by this investigation.

## Evidence limits and repair

All44 captured artifact byte digests were verified. Offline SDK replay of their inputs/output strings plus tool-free synthesis passed (`worker-schema-replay.json`); shell and edit inputs were data only and were never executed. The original invalid message field, provider metadata and reasoning were not saved, so replay does not reproduce the historical malformed field and no specific metadata value is claimed as its cause.

An offline regression deliberately attaches non-JSON provider metadata to an otherwise completed tool call. This reproduces the same SDK ModelMessage schema error when `StreamRunner` starts its separate final synthesis. Before the change the worker failed despite the completed effect.

The fix catches only the first typed ModelMessage-schema error at tool-free synthesis, before any synthesis text. It converts the existing captured transcript through the existing bounded text serializer, checks context capacity and attempts the tool-free handoff once more. Raw captures remain unchanged. The model is told metadata/reasoning are omitted and long entries may be excerpted, and must keep missing evidence explicit. No tool is re-executed. HTTP/provider errors, initial invalid prompts, cancellation, incomplete/length results and independent acceptance keep their existing behavior.

Worker SDK error callbacks now write bounded context and schema paths/codes to the file log, instead of sending the SDK's full prompt error to the detached child's ignored stderr. Nested union paths are retained along with existing top-level issues. Logs do not contain prompt bodies or metadata values.

## Visible receipt removal

At the user's request, the host no longer emits or persists `Native Flow evidence` in assistant replies. The internal completion guidance and Flow status facts remain. Assistant display hides exact repeated historical receipt suffixes without modifying raw history or user messages. Quoted/fenced examples, ordinary prose and incomplete lookalikes remain intact. `PRESERVE` is unaffected by this change.

## Validation and delivery boundary

- `worker-schema-regression.log`:82 tests/5files passed, including actual SDK recovery, one effect, exactly two actual mock provider requests, tool-free handoff, private prompt sentinel protection, other error behavior and receipt suppression.
- `worker-schema-context.log`:54 tests/7files passed for compaction, context, role boundaries, messaging and UI projections. Combined136 tests/12files passed; this is focused coverage, not the full suite.
- `worker-schema-typecheck.log` and `worker-schema-build.log`:exit0.
- Rebuilt workspace native selfverify `4693a284-e84e-45cb-9f8a-48b8cf878eb6`:smoke-boot1/1 passed. Boot QA does not reproduce the worker's original provider messages.
- Installed-global and workspace compiled stream runner/UI text helper hashes match. A running host still needs reopening/resuming to load the changes.

No consumer file edit, dotnet execution, paid provider call, failed-job replay, admission/gate edit, commit/push or live restart was performed. Historical failed jobs remain failed and their completed effects require current inspection/review before further work.

## Follow-up audit of the coordinator's recovery report

The later claim that these schema errors were caused by an overlong prompt is unsupported by the saved data. Later successful jobs demonstrate continued progress, not the original invalid field or cause. The prior offline replay and synthetic recovery evidence above retain their stated limits.

Read-only inspection of `calm-teal-wolf` resultVersion `9b44b330c5345cc12156bb5f4621658d0f55b84b5908c559524ee2a7a92c1a01` confirms NuGet Access denied failures for SourceLink.GitHub.dll and Build.Tasks.Git.dll in artifacts `chatcmpl-tool-abb0658a255abd51` and `chatcmpl-tool-a2bc9f6f7cdfe46f`. These captures do not identify a lock owner or prove a lock rather than access permissions. No handle-owner utility was resolved locally during this audit.

The taskkill action is real: `clever-silver-sparrow`, artifact `chatcmpl-tool-93c80be8634adfe4` at2026-11-04T02:57:41.199Z, has a verified capture digest, command `taskkill //F //PID 37968 //PID 23116`, and SUCCESS for both PIDs. That does not establish ownership of those processes or that either held the affected DLL.

Local `dotnet build-server shutdown --help` says its default shuts down all dotnet build servers; it is not a single-worker operation. Local `dotnet nuget locals --help` identifies all cache locations, including global packages and HTTP/temp caches. `locals all --clear` therefore does not mean clearing only the two affected packages. Only these help commands were executed; no shutdown, cache clearing or process termination was performed by this audit.

At the follow-up snapshot, `lively-ivory-panda` was running as Bun PID81368 (confirmed in the process table) with59 captured artifacts and a recent capture at03:20:12.234Z. This supports ongoing worker activity, not completed implementation or a verified absence of every CLI defect. No new consumer build/test was run and no fresh SourceLink lock was established.
