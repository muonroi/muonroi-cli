# Session 0717b08730a1 export comparison — 2026-10-15

The reported export contains a complete matching DB prefix followed by live output from an unfinished turn. This observation does not establish a transcript comparison or tool-group flattening defect. No production change was made to suppress the dual-source safeguard.

## Exact artifact

- Path: `D:/sources/Core/shipd-challenge/.claude/worktrees/debt-w7-win-portability/chat-export-0717b08730a1.txt`.
- Export timestamp: 2026-10-15 03:30:07 UTC / 10:30:07 UTC+7.
- Bytes: 215,816; SHA256 `d4780066e9f160e5a3f0a1725491386457b96bd6c5010919ddfc87d940b5aa34`, unchanged after investigation.
- Header: 65 DB entries / 61 grouped live entries; expanded counts 65 DB / 77 live.

## Comparison

The diagnostic parser separated the two exported sections, parsed all 65/77 entry headers, removed export timestamps and section framing, and compared entry type/content sequences. All 65 DB entries match the live prefix; there are no replacements, deletions or differences inside that prefix. The only sequence edit is insertion of 12 live entries at the end:

| Additional live entries | Count |
|---|---:|
| Assistant text | 3 |
| Completed tool results | 8 |
| Pending bash tool call | 1 |
| Total | 12 |

The additional content spans 03:28:43–03:30:07 UTC. It includes delegation/process checks, worker-report reads, git/control checks and the bash call starting exactly when the file was exported. The file retains all this output in Section B.

## Read-only DB corroboration

At 03:33:00 UTC the inspected DB had user message seq55 (03:28:08) and seq56 (03:30:19) marked pending; its latest completed assistant ModelMessage was seq54 at 03:27:48. The second pending message was created after this export and is not part of the export-time comparison.

All eight exported tail tool results already exist in write-ahead `tool_results`, joined to tool-call rows7372–7379, with stored timestamps preceding export. Their rendered outputs match the eight exported tool results exactly. The bash call that was pending in the export, row7380, started03:30:07.038 and completed03:30:57.777 UTC. Its current completed state must not be mistaken for its export-time state.

`buildChatEntries` (`src/storage/transcript.ts:1018`) renders effective ModelMessages, resolving their tool results from storage. It does not append every write-ahead tool row as an independent transcript message. Tool results are persisted as they arrive (`persistToolResultWriteAhead`, line855); assistant/tool ModelMessages are appended by the completed-turn path (`src/orchestrator/orchestrator.ts:3785`, calls to `appendMessages` at3811/3820). These lifecycle boundaries explain the measured live tail while the turn remains unfinished.

This proves that the eight observed tool outputs were durable in write-ahead storage and retained in the export. It does not claim all streaming assistant text was already committed, or that every later export will match. A comparison after the turn settles is a separate observation.

## Scope and diagnostic tools

No original DB/export/Shipd file, running CLI process or production source was modified. No inference request or worker was launched. Automated product tests were unnecessary for this read-only investigation.

Reproduction tools/results are under `.scratch/session-export-0717-20261015/`: `compare.py`, `sections.json`, `analysis.json`, `db-read.ts`, `db-current.json`. SQLite was opened read-only with a read transaction. The persistent workflow record is `export-0717-active-turn.md` in the current qc-flow run directory.
