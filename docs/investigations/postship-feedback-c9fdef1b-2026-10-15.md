# Post-ship agent feedback: c9fdef1b04d4

Date: 2026-10-15. This follows the agent's 07:18 UTC feedback, after the earlier handoff release. Changes are in the current dirty checkout, with a rebuilt local dist; no commit, push or server deployment.

## What was repaired

### Selfverify inputs and failure latency

The export records two invalid fixture cases: an empty directory string, and tier1 `mockLlmDir="none"`. The native tool had advertised `none` without distinguishing modes. Agentic understood the sentinel; tier1 passed it as a literal directory. The latter child exited with `ENOENT ... scandir 'none'`, yet the report took approximately 61 seconds because pending driver waits were not rejected on transport closure.

`src/self-qa/validate-request.ts` provides shared mode-aware validation for native tools, MCP and the job manager. Both invalid tier1 values are rejected before starting a job. Omission selects bundled offline fixtures; `none` remains available only for explicitly configured agentic execution. Tier1 checks a missing fixture directory before spawning.

`packages/agent-harness-core/src/driver.ts` now closes pending waits, clears their timers and rejects future waits after transport shutdown. The native control uses an actual child that handshakes and then exits with an invalid model fixture: the final run reported failure in **1357ms**, rather than waiting for the 60000ms idle budget. This control does not establish early-exit handling before the initial harness handshake.

### Verification without unlocking arbitrary mutations

GSD heavy/revise blocked the agent's bash/test/selfverify calls. The solution preserves the real plan verdict and the ordinary mutation gate:

- New native/MCP `verification_run` executes the workspace's already installed `node_modules/vitest/vitest.mjs` with Node, without a shell or `bunx`. It accepts 1-100 explicit existing test files, checks real-path containment, rejects options/directories/arbitrary commands, bounds runtime, and propagates cancellation.
- Timeout cleanup uses the existing process-tree termination helper and waits for process closure with a bounded fallback. A Windows fixture-lock test caught the original premature return during implementation; the corrected control passes.
- `evaluateMutationGate` allows this bounded test operation and `selfverify_start` only when `mode=tier1` and `emit=false`. Bash, task spawning, edits, agentic harness execution and emitting harness runs retain their gate.
- `tool-engine.ts` forwards actual tool input to this decision. No `.planning/PLAN-VERIFY.md` was rewritten and no force override was used.

This is a workflow distinction, not an OS sandbox: existing trusted tests still run normal project code and can create their fixtures/cache. Other test frameworks continue through their existing project workflow. The runner does not install a missing framework or silently run a broader suite.

### Child instructions, capabilities and evidence retrieval

Child prompts now retain project instructions rather than stripping `CUSTOM INSTRUCTIONS`. Their execution contract assigns workflow coordination and integration acceptance to main; children apply project permission, scope, correctness and evidence boundaries to their assigned task and report conflicts instead of expanding the job.

Read-only ask/plan toolsets now include `ee_query`, `retrieve_tool_result` and `search_session_history`. They continue to exclude edits and task spawning. This closes the specific dead retrieval reference for explore children. Compact descriptions and acknowledgements now direct callers to local `retrieve_tool_result` instead of requiring EE. The existing actual-tool inventory is still built from the final granted toolset.

Tests assert the inherited project sentinel, main ownership, available read tools and absent mutation/spawn tools. They do not establish that a model will obey every instruction under every provider.

### Batched file sections

`read_file.file_paths` accepts legacy strings and independent objects such as:

```json
{"file_paths":[{"file_path":"src/a.ts","start_line":10,"end_line":20},{"file_path":"src/b.ts","start_line":30,"end_line":35}]}
```

Ranges are inclusive and validated. Capped outputs stop at complete line boundaries and identify the unreturned line range. Batches are limited to 20 files and reserve per-file marker space, reducing outer-cap loss. Legacy single-file and string-array reads remain covered.

### EE scope: client guard and server compatibility

The unchanged EE server's `handleRecall` explicitly runs recallMode without positive project filtering. Adding a `project` request field alone would not fix the observed wrong-repository recall.

The CLI now forwards the actual shell cwd and session, requests strict project scope, and requires a matching strict-scope response before injecting general recall. It discards unverified results and returns a visible `ee_scope_unverified` explanation, preserving repository-first progress. Exact artifact retrieval continues through local cache/disk/SQLite.

**Compatibility limit:** the running legacy EE server does not provide this proof, so native general recall currently degrades to that explanation. The separate EE server was not changed or deployed. This release protects CLI context from unverified cross-project lessons; it does not claim the server now performs strict filtering. Passive EE/PIL enrichment and the external Experience Engine MCP are separate surfaces.

## Durable evidence across a real process restart

`reports/postship-feedback-2026-10-15/tools/durable-roundtrip.mjs` runs independent producer and consumer processes with an isolated home and database:

1. Create linked main/child sessions and execute an actual child `bash` tool command against a private proof script.
2. Persist the real command result in child SQLite, a bounded helper receipt in main, and a SHA-versioned delegation artifact.
3. Compact the long handoff and flush its local disk artifact. Serialized context decreases from **34512 to 4431 characters**.
4. Exit the producer, start a new consumer with an empty in-memory cache, and retrieve the handoff from disk plus the actual child command result from SQLite using main's session tree.
5. Verify the durable main receipt, ACK the saved result version and verify no completion replay.

Both processes exit 0. This exercises native tool/storage/compaction APIs with real command output, not seeded command-output text. It does not test paid-provider routing, sudden power loss or a model's final acceptance decision.

## Fresh acceptance

- **544 tests passed, 0 failed, 52 files, 45.95s**, covering verification, Self-QA, driver lifecycle, EE client/scope/formatting, file/registry contracts, GSD gate, prompts, delivery, compaction and real SQLite handoff.
- `bun run build`: exit 0; CRLF-aware diff check: exit 0.
- Rebuilt compiled CLI through native MCP: **12 controls passed**, including real installed local tests, invalid-input fail-fast, foreign-workspace TUI boot, gate decisions and child-exit latency.
- Native selfverify run: `825f10e3-f153-481f-9a02-9f9f4aa9ecce`.
- Independent durable roundtrip: all six behavioral checks pass, with both process exits 0.

Shareable tools, raw native reports and measurements are in `reports/postship-feedback-2026-10-15/`. Unit/build logs remain under `.scratch/postship-feedback/`. This is focused regression evidence, not a full-suite or complete modal-flow claim.

The global CLI package is linked to this checkout. Restart already loaded TUI/MCP processes to use the new dist and tool schemas, then resume the existing user session. User exports, live jobs, credentials and the TCIS checkout were preserved.
