# Read-only runtime feedback blocked by the GSD mutation gate

## Observed failure

Original SQLite evidence was read with `mode=ro`, session **2e52c89dc8a6**:

- Message 1, `2026-10-16T03:07:25.861Z`: the user requests runtime strengths/weaknesses and explicitly says not to inspect source.
- Message 2: `search_session_history`, call `chatcmpl-tool-9a2c96c1d57e19ce`, and `list_tools`, call `chatcmpl-tool-b00388bf02d86e2c`.
- Message 3, `2026-10-16T03:07:51.681Z`: both return `BLOCKED: this task was assessed as non-trivial. GSD requires a reviewed plan before any code edit.`

This is an authorization-routing failure for read-only tools. It is separate from the historical FTS syntax failure repaired in [the elision/FTS investigation](elision-durable-evidence-fts-2026-10-16.md).

The exact observed prompt already follows Layer 4's informational report path in the new regression, before changing production code. The reproduced defect was the tool boundary: history and inventory were absent from both the tool engine's read-only set and the mutation gate's exemption set. An existing heavy/revise workspace state could therefore block evidence gathering during a feedback request. No broad meta-keyword bypass or classifier change was required.

## Repair and boundaries

- `src/gsd/mutation-gate.ts:11`: one frozen list names the verified read-only history, evidence retrieval, inventory, tool-description, diagnostics, forensics and existing result/status readers.
- `src/orchestrator/tool-engine.ts:1339`: the execution wrapper consumes the same list. These readers skip mutation authorization and the write mutex.
- Heavy/revise still blocks `edit_file`, `write_file`, arbitrary `bash`, `task`, unknown tools and agentic/emitting selfverify in the tested ordinary gated path. Existing direct-answer/disabled-gate exceptions are unchanged. This repair does not grant tools, change permission approval modes, clear state, force GSD execution, or exempt arbitrary MCP tools.
- `src/tools/native-tools.ts:287,310`: removed two stale LSP descriptions that still advertised an LSP-before-grep requirement. Text/config/log search is independent of diagnostics; semantic impact and completeness checks retain their meaning. LSP execution is unchanged.

The explicit list prevents disagreement between these two authorization boundaries. Existing exemptions outside this list are preserved; this is not a redesign of all workflow or side-effect policy.

## Fresh verification

| Check | Result | Scope |
| --- | --- | --- |
| Before-fix regression | 4 failed, 40 passed | Four history/inventory calls blocked under heavy/revise; informational prompt test already passed |
| Final focused suite | **86 passed / 7 files**, exit 0 | Mutation gate, Layer 4, native tools, hydration, inventory, prompt contracts and argument guards |
| Build | Exit **0** | Includes compiled core exports and CLI TypeScript build |
| Compiled handler controls | **17/17** | Actual gate + registered handlers + isolated real SQLite; history/inventory/description/retrieval/forensics return data under heavy/revise |
| Negative controls | Included in 17/17 | File mutations, bash, task, unknown tools, agentic/emitting selfverify remain blocked; offline non-emitting tier1 remains allowed |
| State preservation | Included in 17/17 | Temporary STATE.md and PLAN-VERIFY.md SHA-256 hashes remain unchanged |
| Native/MCP controls | **15/15** | Isolated subprocess, forensics scope/cutoff/pagination/redaction and mock TUI checks |
| Native selfverify | **2/2**, 0 failed | smoke-boot + passive-log; run **7aa07f85-75c2-4c6e-a040-57971d9257dd** |
| Whitespace | Exit **0** | Working-tree diff check with CRLF-aware configuration |

Private reproducible runners and raw outputs are in `.scratch/readonly-feedback-gsd-gate/`: `verify.mjs`, `verify-native.mjs`, `compiled-result.json`, `native-result.json`, `observed-trace.json`, `red.log`, `tests.log`, `build.log` and `diff-check.log`. [The bounded evidence manifest](evidence/readonly-feedback-gsd-gate-2026-10-16.json) records results and hashes without copying full transcripts or credentials.

The compiled controls call the actual gate and registered handlers; they do not replay a full paid-model orchestration turn. Native selfverify drives the compiled TUI with a mock model and fake test credential in an isolated home. These checks do not prove StepFun availability, spontaneous model tool selection, universal informational classification, or every TUI surface. No paid provider request, original database write, root workflow-state edit, TCIS edit, commit, push or deployment was performed.

The latest feedback's rate-limit discussion contains no new HTTP trace or counter. It does not establish a new provider failure or exhausted credits. Unused MCP availability is task-dependent and does not establish a defect. Language matching in one interaction likewise does not independently prove which PIL stage caused it. Interactive `task` can run in the background under the current routing; a universal task=foreground/delegate=background description is incomplete.

Restart existing CLI/MCP processes to load the rebuilt modules; processes already running retain their loaded implementation.
