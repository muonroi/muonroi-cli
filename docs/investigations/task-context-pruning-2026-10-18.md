# Task-aware context pruning

## Behavior

The coordinator can now choose a current working set through the existing native `context_load` tool. The request contains the selected task, current constraints, decisions, open items and retained evidence references. Updating these fields replaces the previous ledger; it does not append another session narrative. The coordinator chooses relevance. No EE/router/auxiliary model guesses the task or performs a separate pruning LLM call.

Unclassified history stays. Explicitly archived closed turns are excluded from model requests, while canonical SQLite messages and tool artifacts remain available. Main and child streaming `prepareStep` paths project the current selection on every SDK request, including subsequent tool steps. Existing context-window checks still apply.

The old summarizer remains an emergency fallback after selection. It receives only selected history, carries the bounded owned working-set receipt and preserves explicit dependencies. The receipt is committed atomically with the checkpoint using the existing transaction, so a DB reopen does not silently lose the selection. No database schema migration is needed.

## Native usage

1. Inspect when changing tasks or after noisy completed work, rather than on every tool step:

```json
{"topic":"working_set","action":"inspect"}
```

The result pages turn IDs/previews, revision, evidence IDs and protection reasons. `offset` pages more entries.

2. Update using the inspected IDs and revision:

```json
{
  "topic":"working_set",
  "action":"update",
  "expected_revision":0,
  "task_id":"council-verification",
  "goal":"Verify the current council behavior",
  "constraints":["Preserve permissions and unrelated user work"],
  "decisions":["Delivery and ACK do not establish verification"],
  "open_items":["Independent tool evidence remains unresolved"],
  "keep_tool_ids":["actual-call-id-from-evidence"],
  "archive":[{"turn_id":"turn-id-returned-by-inspect","reason":"Completed packaging work is unrelated"}]
}
```

`archive_through:{turn_id,reason}` retires a closed prefix while retaining protected dependencies; it avoids accumulating one archive record for every old task. `keep_turn_ids` can retain a related old turn. Dependency/negative-evidence relevance is selected explicitly by main, not inferred from keywords or age.

`replace_checkpoint:true` explicitly retires an old narrative checkpoint after main carries forward its still-valid state. It is refused while jobs remain unacknowledged or host protection lookup is unavailable. Ordinary system/repository/permission policies are preserved.

`restore_turn_ids` restores selected available archived turns. `reset` with the current `expected_revision` clears selection and restores available context. Within an SDK loop, restoration only re-inserts exact bundles this selector omitted itself; it never re-executes a command or performs whole-history/semantic EE rehydration. After emergency compaction, details absent from the active view require the existing exact artifact/history retrieval tools.

## Protection and persistence

- Current user turn, real user pins, original child scope, active/unacknowledged job references and incomplete/cross-turn tool chains are protected.
- Explicit dependency/error tool/turn IDs survive both pruning and existing per-step output elision. Media/opaque signed-reasoning bundles are conservatively retained.
- Turn bundles preserve matching call/result identity. Ambiguous/unknown IDs and stale revisions are rejected. Relevance selection grants no permissions, workflow approval, ACK or acceptance.
- State is bound to owner, absolute cwd and revision. Foreign-owner/cwd receipts cannot restore it. The newest bounded native receipt restores selection across turns and emergency compaction/restart.
- The host receipt remains persisted for resume but is hidden from rendered chat; raw transcript access keeps it. Arbitrary worker/user output is not translated or hidden by this change.
- State/inspection pages are bounded. Repeated updates replace ledger fields; long closed prefixes use a single boundary. `MUONROI_PROGRESSIVE_CONTEXT=0` retains the legacy path.

## Fresh verification

| Check | Result |
|---|---|
| Regression suite: selection, pins/jobs/protocol, negative evidence, main/child paths, checkpoint failure/recovery, storage resume/rendering | 230 tests / 27 files passed, exit 0 |
| Built Agent + StreamRunner + actual AI SDK + local mock model + native context_load + private Bun SQLite | 14/14 controls passed |
| Typecheck and build | Exit 0 |
| Built tools-MCP native selfverify with actual Bun TUI | Boot 1/1 passed |
| Semantic UI instrumentation | Exit 0 |

Artifacts: `.scratch/task-context-pruning-20261018/accepted-tests.log`, `compiled-controls.json`, `native-selfverify.json`, `typecheck.log`, `build.log`, `semantic.log`. Public manifest: `docs/investigations/evidence/task-context-pruning-2026-10-18.json`.

The compiled fixture history plus injected guidance shrank from **25,616 to 1,789 characters**. Two actual main SDK steps and one child SDK step excluded the stale sentinel while retaining the selected negative evidence, blocker, scope and permission constraint. The original stale text remained in canonical SQLite. An actual emergency compaction followed by DB close/reopen retained the exact owned selection and kept pruning correctly.

These are fixture character/protocol/continuity measurements, not provider-reported tokens, billing savings, or a live-provider quality comparison. `contextPrunedChars` is request-local gross omitted payload, not unique cumulative history or tokens. Batch transport remains the existing unavailable Phase-0 path; no batch execution support is claimed. The full suite, push, publication and deployment were not run. Restart existing CLI processes with Bun to load the built changes.

## Test isolation incident and remediation

The first checkpoint/rollback fixture redirected `MUONROI_CLI_HOME` alone. SQLite resolves its database from `HOME`/`USERPROFILE`, so that fixture reached the ambient database. Its exact `reject_context_receipt` trigger caused the broader check to fail. The trigger was removed only after comparing its definition with the fixture SQL.

Fourteen sessions were proven to be test-owned by exact seeded user/assistant/tool-call content, or the unique mock checkpoint with no user messages. Their rows were backed up privately before scoped deletion. The session-ID set comparison confirmed no other sessions were removed. Empty/ambiguous records without sufficient attribution were preserved. This is not a claim that the ambient DB was restored byte-for-byte to an earlier snapshot.

The fixture now sets and asserts its actual SQLite path under its private HOME, restores both HOME variables, and removes its injected trigger during cleanup. The final regression wrapper additionally isolates HOME, USERPROFILE, CLI/auth/env roots and test mode for the whole selected suite. EE is mocked in the checkpoint unit fixture so background queue work cannot race directory cleanup. Final ambient read-only inspection confirmed the fixture trigger is absent. Private audit/backup: `.scratch/task-context-pruning-20261018/db-fixture-remediation.json` and `owned-fixture-rows-backup.json`.
