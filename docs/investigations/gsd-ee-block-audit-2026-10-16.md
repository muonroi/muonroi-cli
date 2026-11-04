# GSD / EE block audit and executed installations

## Scope and method

Read the latest 1,800 message rows from the original CLI SQLite database with `mode=ro`. This is a bounded window, not all sessions. Window timestamps: `2026-10-05T10:00:55.322Z` through `2026-10-16T06:45:19.106Z`.

Count only tool-result values **starting with** the actual GSD BLOCKED directive or `[ee_scope_unverified]`. Source reads, test output, and history search excerpts that quote the directive are excluded. An initial substring search included those quoted strings; its counts were discarded.

No production source, user configuration, GSD verdict, original DB, or running user process was changed during this audit.

## Confirmed historical blocks

| Tool | Direct GSD blocks |
|---|---:|
| bash | 9 |
| selfverify_start | 3 |
| list_tools | 3 |
| task | 2 |
| list_mcp_servers | 2 |
| delegate | 1 |
| ask_user | 1 |
| todo_write | 1 |
| search_session_history | 1 |
| **Total** | **23** |

There is also one direct EE scope refusal in this window. Historical delegate refusal exists in session `ea7378aab8f8`, seq 42, on October 8; it was not called in the latest feedback session `7fea31350fc7`.

Replay of the 23 captured tool names/inputs against the **current compiled** gate and a fresh temporary heavy/revise workspace allows **13** and still blocks **10**. This is a policy fixture, not a reconstruction of historical plan state or a live agent turn.

The 13 now admitted are the readers, question/progress tools, exact built-in explore task, and three explicit tier1/emit=false selfverify requests. The ten remaining requests are nine bash commands and one verify worker. Current shell gating does not distinguish `git status`/`pwd` from commands with mutation effects. This explains real friction for shell-based inspection; opening all bash or write-capable verify workers would also open mutations before plan approval. Existing alternatives include native read/grep tools, `verification_run` for explicit local Vitest files, and non-emitting offline selfverify.

## Two installed copies and processes older than the build

Observed running main Bun process PID 20612 started **09:45:54, UTC+7**, using the global Bun CLI path. Its installation is a junction to `D:\sources\Core\muonroi-cli`. Current compiled gate file was written **14:02:27, UTC+7**. An existing process does not automatically reload already imported modules after rebuilding; its start time alone does not identify every in-memory module revision, so this audit does not claim to have inspected its heap.

Several registered MCP processes use an independent npx cache copy:

`C:\Users\phila\AppData\Local\npm-cache\_npx\f473c9721d119990\node_modules\muonroi-cli`

Its compiled gate was written `2026-10-14T04:32:08.649Z`. Both copies report version **1.9.0**, but their SHA-256 hashes differ:

- Workspace/global junction: `d058ad305a61625088679cfe9a91851b96f49116d8b13afe9a43d967b8bfe8c3`.
- npx copy: `66a959c719fe9a6258aa4dd087a92f452142808d1dff8baf147eec30a88bde1d`.

The npx copy has neither the exact explore exception nor the new context_load exemption. The observed Codex config selects it through `npx -y muonroi-cli@latest tools-mcp`. Restarting this MCP alone does not establish use of the local workspace build.

For development verification, the concrete local configuration is:

```toml
[mcp_servers.muonroi-cli]
command = "node"
args = ["D:/sources/Core/muonroi-cli/dist/src/index.js", "tools-mcp"]
```

Preserve any existing tool configuration subtables. This is a proposed entry, not a configuration change applied by this audit. The main CLI should be restarted after its current work is safely saved; resume its existing session afterward. MCP reconnection/restart is also required to load a changed command or build.

## EE is a separate contract incompatibility

The current CLI requires strict project proof to avoid injecting another repository's lessons. `ee_query` bypasses the main GSD mutation wrapper; the refusal comes from `recallEE`, not plan review or safe-mode approval.

The immediately preceding live probe, measured at `2026-10-16T07:00:05.447Z`, returned health 200 and a recall response after 8,104ms with keys `text/entries/count/query`, 21 entries, and **no scope proof** despite a strict request. It is documented in [the runtime report](runtime-explore-recall-output-2026-10-16.md). No duplicate network recall was needed for this audit.

The CLI diagnostic fix explains this more accurately but does not restore strict recall. The server must actually enforce the requested project scope and provide a matching proof; returning an unconditional `strict:true` flag or disabling client verification would not establish filtering. Verify the deployed EE revision and its scope contract before implementing/deploying the server change. No server deployment was performed here.

## Evidence and practical next steps

Private evidence: `.scratch/gsd-ee-block-audit/direct-blocks.json`, `current-policy-replay.json`, `replay.mjs`, `processes.json`, `installations.json`. The replay uses no paid provider or child worker.

1. Restart the main CLI to load the current build; reconnect MCP using an explicitly selected installation for verification.
2. Retest read-only tools and exact explore. New unexpected blocks need the new session/toolCallId; old exports remain historical evidence.
3. Keep EE strict refusal visible as degraded functionality until the server contract is repaired and proven. A healthy endpoint is insufficient.
4. Treat shell-based read-only inspection as a separate usability improvement requiring an enforceable execution boundary; do not remove GSD wholesale to make these historical calls pass.
