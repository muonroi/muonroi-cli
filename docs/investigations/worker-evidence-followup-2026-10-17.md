# Cross-worker runtime evidence follow-up

User evidence: `calm-white-heron` completed an MCP docs search; `nimble-emerald-falcon` could not independently retrieve it. The latter's `read_file` was refused outside the workspace, a resultVersion was supplied as tool_call_id, and main's later correct ID returned a semantically related EE lesson rather than the saved tool result. This follow-up preserves the compact approval UI and fixes the host evidence path.

## Proven causes and changes

1. **Exact recovery used semantic search.** Both `retrieve_tool_result` and the artifact branch of `ee_query` selected EE `points[0]` without exact artifact identity. Two regression cases reproduced the incorrect substitution before the change (`exact-evidence-red.log`:2failed/13passed). Exact recovery now uses local evidence only and reports absence explicitly. Ordinary semantic EE recall remains available for lessons; it is not proof of a particular tool call. Worker evidence is retrieved through versioned `delegation_read`, whose response now includes a concrete invocation with the actual distinct IDs.
2. **The review child lacked a peer-artifact route.** `readReviewArtifact` binds the child to its running host review record, parent owner, workspace and exact successful target resultVersion. It exposes a compact host manifest and validated raw output, without arbitrary paths or author reasoning. The review child's existing `retrieve_tool_result` is bound to this target before capture, cumulative budgets and safe approval wrappers. Workspace `read_file` restrictions remain in place. Foreign/stale targets, wrong identifiers, traversal and altered manifests/payloads are refused.
3. **Runtime corroboration was conflated with source verification.** Host review evidence now records `worker-artifact` reads with job/version/call/digest and page coverage. Main may explicitly accept a separate structured independent review at `reviewLevel=artifact` only after a complete saved tool envelope was read and revalidated. Partial reads cannot establish this acceptance. This level never claims freshly executed tests; existing `static` and `executed` levels remain distinct. Delivery, ACK and acceptance stay separate, and changed payloads invalidate displayed artifact acceptance.
4. **Auth failures were retried as connection failures.** The MCP pool now reports `mcp_auth_required`, avoids replaying a tool on HTTP401, and suppresses repeated unchanged-config connection attempts for60seconds. Changed configuration, explicit interactive sign-in and pool teardown remain available recovery paths. Ordinary transient transport reconnect still has its existing one-attempt behavior. Pool/runtime diagnostics use the file logger; capability errors remain visible to the model. No credentials or server settings were changed.
5. **Guidance repeated stale permission assumptions.** Main's contract now distinguishes artifact corroboration from source/test verification, names the four distinct identifiers and asks for bounded matching reviews. Safe-mode permissions are determined by the host, never inferred from a read/search label or an old EE lesson. The two contradictory EE lessons `4a5ac567` and `8e6430a7` received `noise/stale_rule` feedback; checkpoint binding hint `010599c9` received `followed`.

## Incident correction from original job records

Read-only inspection of the original saved jobs is in `.scratch/worker-evidence-followup/incident-permission-summary.json`:

- `calm-white-heron` was safe-mode and its actual `mcp_muonroi-docs__docs_search` approval was consumed. Approval waited3330ms. Its success does **not** establish an exemption for MCP read/search tools.
- `nimble-emerald-falcon` ran382530ms in total. Its `read_file` and `retrieve_tool_result` approvals waited110790ms and242046ms respectively:352836ms combined. The remaining29694ms is not a measured breakdown of model, tool and orchestration time. The six-minute duration cannot all be attributed to orchestration cost. No safe-to-yolo workaround was introduced.

## Fresh verification

Machine manifest: [worker-evidence-followup-2026-10-17.json](evidence/worker-evidence-followup-2026-10-17.json). Private fixtures/logs live under `.scratch/worker-evidence-followup/`.

| Control | Fresh result |
| --- | --- |
| Delegation/review/permissions/receipts/recovery/prompt/MCP/preview regression set | 202tests across15files passed; `regression.log` |
| Final auth/runtime-hydration/prompt-contract checks | 22tests across3files passed; `final-auth-contracts.log`; client-pool file overlaps the preceding set, counts are not additive |
| Typecheck/build/semantic/scoped diff | Passed; build0warning lines |
| Compiled review control | 14/14 passed; actual compiled StreamRunner + SDK mock, saved host artifacts, independent context, page/digest binding, separate delivery/ACK/acceptance and post-acceptance tamper rejection |
| Actual compiled Bun App | 8/8 passed, including Allow/Deny/Esc, foreground/default-background, follow-up handling, long local preview and draft preservation; `.scratch/session5689/tui-safe-s4NR90/report.json` |
| Native `selfverify_*` | Boot1/1 passed, run `dff3dc0a-ba67-4e91-96c5-1bd5fd7325dc` |
| Provenance/settings | 59source/compiled paths stable through App execution; real settings hashes unchanged; freeze SHA256 `dcd60705617782420d01b2e9498cb5a5b81e3c70663e636ef66731906e6cdb39` |
| Live StealthGPT initialize | HTTP401 `invalid_token / No authorization provided`; first probe979ms/2HTTP requests, second0ms/0HTTP requests during cooldown. `live-auth-probe.json` |

The compiled control's first attempts exposed fixture mistakes: it treated the internal `runStream` outcome as a public `success` result and counted a blocked localhost catalog probe as a provider request. Its original failed/diagnostic artifacts remain saved. No production workaround was made for those fixture mistakes. The passing control used exactly two offline mock SDK calls and attempted no external provider requests.

## Remaining boundary

StealthGPT's current configuration has no Authorization header; the external server still requires valid authentication. The CLI cannot invent third-party credentials. Set up that server through `/mcp` with valid credentials/sign-in, or disable it when unused. No token was copied, manufactured or printed.

The regression/native controls use isolated fixture homes and offline model responses with real local host/UI/I/O behavior. The live auth probe is an external initialize/list failure, not a successful authenticated tool call. No paid-provider quality, global cost/latency improvement, whole-catalog sweep or old-process module-load claim follows. The historical9,478-test full suite was not rerun and no push is performed. No commit, push, remote deployment or user DB/job mutation was issued. Restart the built CLI with Bun once to load these changes together with the approval redesign.
