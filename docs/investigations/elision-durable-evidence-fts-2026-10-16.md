# Durable elision evidence, argument recovery and literal history search

## Reproduced defects

The supplied session references were read directly from the original CLI SQLite DB without writes. Session 5a74a2451830 message 70 contains marker arguments for retrieve_tool_result; message 71 records its guard refusal. fd368bc65efb message 107 contains blocked bash marker calls. d70dc7e732e2 message 106 contains assistant edit_file calls carrying markers. Outer toolCallIds remain present: these examples establish unusable arguments and marker imitation, not deletion of every call ID.

An isolated real-SQLite regression then proved that appendMessages could overwrite captured arguments with __elided_note and replace previously stored results with compactor stubs. Both preservation tests failed before the fix. The first valid/full payload and a compacted model-history view must not be treated as equivalent evidence.

The reported FTS query was also reproduced read-only:

`permissionMode OR permission OR approval OR auto-edit OR yolo OR safe mode`

SQLite returned `no such column: edit`. Quoting the punctuated term as `"auto-edit"` worked. This was an interface/grammar problem, not proof that permission data was absent.

## Changes

- Compacted assistant inputs retain previously captured tool_calls arguments. Compactor result envelopes no longer replace an existing stored tool result. Ordinary full final arguments/results remain authoritative over write-ahead data.
- `retrieve_tool_result` supports opt-in `view="arguments"`: captured arguments are read only from the current root/descendant session family, with a default 4,000-character page and existing chunk_index/max_chars pagination. Output-cache/remote EE fallbacks are not used for arguments. Default result retrieval keeps its existing tier order.
- New args markers name their source call and the read-only recovery operation. Existing no-inflation checks measure the larger marker and keep original inputs whenever the marker would cost more. Marker-shaped inputs remain rejected for all tools; recovery never replays bash or edits.
- `search_session_history` adds explicit `query_mode="literal"` to quote the entire query as an FTS phrase, including embedded quotes. Default FTS grammar, operators, global history scope, bounded excerpts and paging are preserved. A malformed raw FTS query returns quotation/literal-mode instructions; it does not silently broaden the search. Literal mode uses FTS tokenization, not byte-exact substring matching.

Examples:

```json
{"tool_call_id":"<source call ID>","view":"arguments"}
```

```json
{"query":"auto-edit","query_mode":"literal"}
```

```json
{"query":"permissionMode OR approval OR \"auto-edit\" OR \"safe mode\""}
```

## Fresh validation

- Storage RED: 2 failed / 1 passed before the retention repair. Recovery/FTS regression additions also failed before implementation.
- Final focused regression: **177 passed / 20 files** covering storage, hydration, compaction, marker guards and child handoff.
- Build: exit 0.
- Compiled end-to-end controls: **12/12 passed**. Actual compaction reduces the fixture to 1,305 JSON characters while retaining its stored arguments and 11,900-character result. Child recovery reconstructs original arguments in two pages; database close/reopen preserves them. Foreign-family argument reads are rejected, marker-only archives report unavailable, literal punctuation and FTS operators both work, and a guarded edit executor remains uncalled.
- Native/MCP controls: **15/15**, including smoke-boot + passive-log **2/2**, run **c6ab00b0-755e-4e1e-b388-2e85782cd07f**. Mock model/fake test credential; no paid-provider requests.
- Private artifacts: `.scratch/elision-durable-evidence-fts/`. Bounded portable evidence: [manifest](evidence/elision-durable-evidence-fts-2026-10-16.json).

## Correct interpretation of the supplied telemetry

The reported fda543b0be14 totals match its **two-session family**: 44 usage rows, 2,284,505 recorded input-token units, 86,047 output-token units, 1,892,352 cache-read-token units and 984,663 maximum input in one stored usage event. These are not character counts or a measured per-layer prompt breakdown. Usage events can aggregate model steps; the legacy peakSingleCallInput field does not prove a single HTTP request of that size.

Those family rows span 02:36:57.620Z to 02:52:27.403Z on 2026-09-22. At the quoted cutoff 02:38:59.567Z, only 15 family rows existed, totaling 630,939 input-token units. The quoted timestamp and later totals cannot describe one identical frozen snapshot. Prepared-request rows remain absent in that historical session; no historical layer measurements were reconstructed.

The supplied historical 429 messages establish refused worker calls, but not the particular counter or credit state. Missing request IDs/response headers cannot be recovered from those message strings. Permission-mode provenance and completed-job cost attribution remain separate evidence gaps; the FTS error no longer has to block literal searches.

## Limits

This protects evidence captured before a compacted append. Historical arguments already overwritten, or never captured, cannot be reconstructed from a marker. The argument reader reports that explicitly. Whole-history automatic rehydration, permission modes, provider routing and retry behavior were not changed. Original user DBs, TCIS files, unrelated WIP and previous frozen artifacts were preserved. No commit/push/deployment. Restart existing CLI/MCP processes to load the rebuilt modules.
