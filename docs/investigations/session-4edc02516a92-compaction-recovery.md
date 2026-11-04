# Compaction recovery: exact tool IDs

Session4edc02516a92 message seq304 requested compact. The tool receipt at seq305 instructed recovery with original tool_call_id. At seq308, main submitted two truncated IDs to retrieve_tool_result: call_f56f2b2 and call_2dee53d. Seq309 correctly returned exact-lookup not-found errors.

Read-only SQLite queries found zero tool_calls rows for either exact short ID, but found complete IDs in the same session, each joined to a nonempty persisted tool_results row:

| Attempted ID | Persisted full ID | Tool | Saved result characters |
| --- | --- | --- | --- |
| call_f56f2b2 | call_f56f2b2b980c4ea7861f126c | delegation_read | 33855 |
| call_2dee53d | call_2dee53dc384249bcb4e40535 | delegation_read | 33628 |

Therefore the two misses do not establish lost local evidence. The exact results remain in the native SQLite fallback, which uses WHERE tool_call_id = ? AND session_id = ?. This investigation does not establish where the IDs were shortened (compaction summary versus subsequent model output).

Main lacking read_file is intentional: orchestration-policy.ts grants coordination/recovery tools while workers perform project reads. A bounded read-only worker re-reading current PLAN is a valid fallback. EE availability is independent of exact local evidence recovery. Prefer the original full IDs, or version-bound delegation_read with the actual manifest IDs; do not add ambiguous prefix matching or substitute semantic recall. No production code, consumer plan or gate was changed by this check.

## Native repair after the user requested autonomous recovery

`retrieve_tool_result({view:"index",query:"literal tool name, ID fragment or input path"})` now discovers references without requiring a known ID. The host returns ten metadata entries per page from the same session family already permitted for exact retrieval. It does not return raw arguments/results. Copy the full returned ID for a separate exact read. A failed shortened-ID lookup supplies bounded full-ID candidates when present, without silently retrieving any candidate; ambiguous prefixes remain explicit choices. Pending calls without a stored result are labelled unavailable and do not suggest retrying the same missing result indefinitely.

The tool description/schema, compact receipt, main operating contract and all summary variants now explain local discovery and preserving full opaque IDs. Main does not need the user to look up an internal ID, and unavailable EE does not block this recovery. Source-file grants and version-bound worker artifact rules are unchanged.

An isolated probe invoked the rebuilt native tool with the actual session binding and a driver-enforced read-only SQLite connection. It discovered both complete IDs and recovered 4000-character pages through the SQLite fallback (32062/32061 total decoded content characters; earlier 33855/33628 measurements counted the stored JSON envelope). The probe never printed raw user evidence. Owned-fixture tests also recover after cache clearing and persisted compaction markers, exclude another conversation in the same workspace, test sibling sessions in the permitted family, duplicate prefixes, literal filters, unavailable results and pagination.

The current implementation run is `.quick-codex-flow/sessions/01a19a34-2b32-7d10-b985-5f867afcc7e5/runs/native-evidence-discovery.md`. No live session restart or consumer-plan/gate change was performed.

Final combined evidence-recovery and owner-instruction regression suite passed82 tests/7files. Build/typecheck passed. The rebuilt workspace native selfverify endpoint passed smoke-boot1/1 in run f70a2ce7-c9bc-4974-b159-212afeefcab9; the installed-global build matches the workspace build. Running main processes require a fresh process to receive the new tool schema and operating contract.
