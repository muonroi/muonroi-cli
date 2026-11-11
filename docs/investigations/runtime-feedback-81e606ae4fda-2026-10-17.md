# Evidence audit of five runtime weaknesses

Session: **81e606ae4fda**, including child **17c87acc8f8d**. Original DB/log inspection is read-only. No source, settings, provider configuration or consumer-project code was changed. No paid model/council calls were launched. This audits the evidence and conclusions in the supplied feedback, not the consumer project's functionality.

## Verdict

The report contains real observations, but **“all five weaknesses have been proved” is too strong**. Tool availability, historical logs, disk bytes, per-request context and comparative cost answer different questions.

| Claim | What is demonstrated | What remains unproved or contradicted |
|---|---|---|
| 1. Very high context / rate pressure | Nonzero prompt/tool overhead and historical shared provider cooldown. Current family has measured usage and prepared-request breakdown. | No stored provider error/429 event in this family. The cooldown expired before this session began. Disk log size is not LLM input or evidence of current TPM saturation. “Very high” requires a defined threshold. |
| 2. Heavy policy/tool complexity | Inventory returns 53 native tools; actual prepared system text is 24,302 characters and tool schemas/name/descriptions are 34,075 characters in the selected peak record. | Counts alone do not prove decision friction, slower task completion or redundant tool behavior. No matched experiment measures cognitive/latency impact. |
| 3. Incomplete tool / runtime bugs | lsp_mutation_preview is explicitly a stub; a fresh native invocation returns no proposed edits and changes no file. | A declared limited capability is not a newly reproduced crash. Global timeout/crash/error word counts do not identify an executed failing tool in this session. |
| 4. Windows/POSIX asymmetry causes problems | This environment supports Windows and Git Bash; different dialects exist. | The CLI is not architecturally POSIX-only: actual compiled BashTool also executes PowerShell and advertises its dialect. Both isolated controls pass. No quoting/parse failure was reproduced for the named task. |
| 5. Council has high runtime cost | Historical source=council usage events contain token and estimated-cost accounting. | 5.8 MB of breadcrumbs does not measure council token cost. No council invocation/usage is recorded in this family; no matched comparison establishes how much more expensive council is for the same task. |

## Session measurements

The registered muonroi-cli MCP `usage_forensics(prefix="81e606ae4fda")` agrees with the read-only DB family aggregate:

| Metric | Value |
|---|---:|
| Usage records | 16 |
| Recorded usage interval UTC | 2026-10-16 15:27:40.714 → 2026-10-17 01:25:32.813 |
| Input | 380,134 |
| Output | 9,866 |
| Cache read | 275,968 |
| Cache-hit ratio | 72.60% |
| Largest recorded usage-event input | 33,508 |
| CLI estimated cost | $0.043219 |
| Recorded tool calls | 27: 19 bash, 3 list_tools, 2 usage_forensics, 1 bash_output_get, 1 describe_tool, 1 todo_write |
| Stored interaction error events | 0 |
| Council usage/invocations | 0 |

These are stored CLI/SDK telemetry, not an HTTP capture or provider invoice. Summed input is not per-request context size or a TPM counter. Zero stored error events is bounded to this snapshot/family, not proof that no provider has ever returned 429 elsewhere.

Two child tool queries did return `ERROR not_found` for `usage_forensics(prefix="default")` at seq5 and seq19. Those are invalid session-prefix lookups, not provider quota failures. The final reported evaluation therefore did not use a successful session-usage query of its own; the correct query was executed during this audit.

### Actual prepared request

Largest stored prepared estimate: **interaction_logs 59911**, main session, **2026-10-17T01:25:22.821Z**, callId `4dc290e6-3529-4215-b253-a5206d78418d`, step3:

| Component | Characters |
|---|---:|
| System | 24,302 |
| History | 17,976 |
| Tool results | 38,671 |
| Messages (history + tool results; nested total) | 56,647 |
| Tool schemas/names/descriptions | 34,075 |
| Native portion of tool total | 31,796 |
| MCP portion of tool total | 2,279 |

Estimated input **31,164 tokens**, catalog context window **256,000**. System components: contract1,990; native guidance3,700; mode prompt12,078; skills6,534; custom instructions0. This establishes prompt overhead; it does not establish a rejected request or rate saturation. Do not add message totals to their component rows, or native/MCP rows to their parent tool total.

All16 records remain `orient`, source `initial`. This family uses shell/inventory/description tools, with no native read_file/edit_file/verification_run/context_load calls. Under the implemented observed-stage contract, arbitrary bash text does not infer a research/verify stage. This is not evidence that observed native-stage transitions failed.

Inventory evidence: root seq6 and child seq17 request `category="native"`, returning native_count53 and total57. Their mcp_count0 is a **filtered** count, not absence of all MCP tools. Child seq7 earlier requests all and reports total53. These are availability snapshots, not interchangeable measurements of request schemas.

## Shared ledger and historical logs

Current StepFun ledger snapshot has8 entries, token values **4,696–35,144**, with no in-flight entries. The supplied38,322 maximum is not retained in this current rolling snapshot; it is neither independently reproduced nor disproved by the changed snapshot.

Cooldown: strikes5, recorded **2026-10-15T01:52:02.258Z**, until **2026-10-15T01:53:02.254Z**. Root session was created **2026-10-16T14:00:11.895Z**. Thus the retained cooldown is historical and expired before the session started. Entries contain id/pid/time/tokens/inFlight, not session identity. The token field is an estimate until settled; it is not by itself a provider request trace or proof of the counter reached. See rate-ledger.ts:100–111 and its settle method.

Observed file sizes and lexical counts match much of the supplied feedback:

- debug.log:841,940 bytes, 2,809 lines, timestamps **July27–October17**;989 lines matching ERROR/WARN,58 containing429,60 containing limit,30 timeout,5 stub. These are substring counts, not deduplicated HTTP failures scoped to this session.
- crash.log:15,169 bytes,171 lines, timestamps **July31–October15**;40 lines matching UNCAUGHT/REJECTION/ERROR. Its latest stored timestamp predates this session.
- artifact-cache.jsonl:5,286,044 bytes. A disk cache's size is not the amount injected into a model request.
- council-breadcrumbs.jsonl:1,621,681 bytes/5,845 lines, **October6–17**,46 distinct session-id buckets;81 records belong to the current family.
- council-breadcrumbs.1.jsonl:4,194,178 bytes/11,637 lines, **September9–October6**,55 session-id buckets;0 records belong to the current family.

Combined breadcrumb size is **5,815,859 bytes**,17,482 lines at this audit snapshot. The supplied5,844-line active count can change as a process appends another record. Current-family markers are startup, PIL, routing, sub-session and main-stream markers, with no council-phase/debate markers. The filename is shared by non-council instrumentation too.

The `mem` object contains **rss, heapUsed, heapTotal, external**: process memory counters. Those are not context-token counters. Other fields include marker/session/pid/timestamps and numeric promptChars/systemChars measurements; serializing those counters repeatedly does not establish that the breadcrumb file was sent to the model. See council/crash-breadcrumb.ts:172–188.

## Fresh native experiments

Script: `.scratch/runtime-feedback-20261017/native-controls.mjs`, invoking existing compiled `dist/src` tools in an isolated fixture. Final invocation exits0 with **4/4 controls passed**:

1. Native lsp_mutation_preview returns `{op:"allowlist", dryRunResult:{proposedEdits:[],tokenEstimate:0},schemaVersion:"1.0"}`; fixture bytes remain unchanged. This proves the advertised stub behavior, not a general LSP failure.
2. Git Bash reads `folder with spaces/fixture.env`, preserving literal `$not_expanded`, quoted spaces and `C:\Windows\System32`: **success,671ms**.
3. PowerShell reads the same file with `Get-Content -Raw -LiteralPath`: **success,308ms**.
4. PowerShell BashTool reports isPosix=false and its description explicitly instructs PowerShell syntax.

Times are single functional observations, not a performance comparison. These fixtures do not cover every .NET/env/path command. They disprove unconditional “the CLI only supports POSIX” and leave specific interoperability failures requiring an actual failing command/exit/result. The original session's selected POSIX dialect does not make every Windows-native command unavailable: prompts.ts:196 explicitly allows calling powershell/cmd when needed, and the following branch supplies PowerShell-specific guidance.

The first control process printed all passes but retained imported runtime handles; it was stopped by its exact verified script PID. The accepted script performs workspace-LSP cleanup and exits explicitly. No user CLI process was terminated. No production fix or test-suite pass is claimed from this audit.

## Council cost: the relevant evidence source

Use **usage_events**, not breadcrumb bytes. Historical example, separate session **c9fdef1b04d4**, source=council, **2026-10-15T07:04:36.947Z–07:17:32.495Z**:

- 31 usage records;158,307 input;16,601 output;**$1.475195 CLI estimated cost**.
- Council usage covers generate/debate/research/ideal paths through the shared LLM wrapper; these31 records are not proof of one31-round debate or31 unique HTTP transport requests.
- The current family has no such events. Comparing these two different tasks/models would not be a matched council-overhead experiment. A “council costs X times more” conclusion still requires the same task, model roster, acceptance criteria and measured usage/cache/time on both paths.

This establishes that council-family calls have real recorded cost in history. It does not validate the supplied reasoning from log volume or prove council is wasteful for every routine task.

## Corrected feedback for the runtime agent

“There is measured prompt/tool overhead and an explicitly incomplete LSP preview capability. This session does not establish active429/TPM saturation, an actual Windows parsing failure, or expensive council execution. The shared cooldown and error/crash logs are historical; breadcrumb memory/disk bytes are not prompt tokens. Report per-request components and session-scoped errors, and use usage_events for council cost. Treat policy complexity as a hypothesis until an observed task failure or matched experiment demonstrates its impact.”

Private numeric evidence and measurement tools: `.scratch/runtime-feedback-20261017/{audit.py,audit.json,mcp-usage-forensics.json,native-controls.mjs,native-controls.json,native-controls-accepted.log}`. Public hash manifest: `evidence/runtime-feedback-81e606ae4fda-2026-10-17.json`. Original DB is opened mode=ro with a read transaction. File snapshots are individually hashed, not an atomic multi-file snapshot. Compiled-control hashes record what executed; a dirty working tree/source HEAD alone does not identify executed bytes.
