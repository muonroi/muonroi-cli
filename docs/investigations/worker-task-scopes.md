# Host-controlled worker write scopes

## Contract

Main can launch a bounded editing worker with `task(..., writeScope: ["src/A/", "src/B.cs"])`. Paths are relative to the explicit task cwd. A trailing slash means a recursive directory; another entry denotes an exact file. `[]` grants no workspace writes. Main chooses the paths for the assigned task; cwd and prose are not containment.

This mode uses a closed native tool inventory: read/search, guarded file write/edit, and bounded coordination/context helpers. Shell, MCP, LSP, verification commands, commits and arbitrary future tools are not granted. File edits also skip LSP synchronization so a language server is not implicitly launched by an otherwise scoped write. Existing permission/approval, read-before-edit and run-root guards still apply.

The host pins the canonical workspace and allowed targets at launch. Each native write resolves the target again and refuses traversal, sibling-prefix escapes, links outside the allowed targets, retargeted roots, hardlinked write targets, special filesystem names and Git metadata. New files under an allowed directory are supported. Errors fail closed instead of falling back to lexical authorization.

## Owner decisions during execution

Send an instruction or change paths without waiting for a worker question:

```json
{"id":"<owned-job-id>","message":"Only edit B now; leave A unchanged.","writeScope":["src/B.cs"]}
```

Use `delegation_send` with the exact pending question ID to answer and decide scope together:

```json
{"id":"<owned-job-id>","replyTo":"<question-message-id>","message":"C is now approved for this repair.","writeScope":["src/C/"]}
```

The array replaces the previous allowed paths; it is not an additive grant. `writeScope: []` revokes subsequent writes. Omit writeScope for an ordinary message; prose alone never changes permissions. Scope changes cannot change workspace, models, tool grants, permission mode or review restrictions.

The host validates and saves the message and scope version under the same per-job lock used to apply file writes. A decision takes effect before subsequent writes once the decision call succeeds. An in-flight write holding that lock finishes before the decision; earlier effects are not undone. Re-delivering the same actual SDK toolCallId returns its original receipt without restoring an old scope. Changed input under the same ID, invalid correlation, foreign ownership and escaping paths are refused without changing the scope.

Scoped native tool results carry the scope version used to authorize them. Launch receipts and delegation listings expose the effective paths/version. Owner decision history remains in the mailbox. Worker context receives the instruction at the next safe model step, including after compaction; host enforcement does not depend on the worker reading that instruction first.

When unclear or blocked on an out-of-scope repair, the worker must use `worker_message(kind="question")` and wait for main's decision. A message saying “edit elsewhere” with no host scope decision still cannot authorize the write.

## Compatibility and limits

- OS sandbox is unavailable; `worker_capabilities.isolation` reports this explicitly. This native file mode is not a sandbox for arbitrary build/test programs. Main must use a separately authorized execution context for commands; it must not call legacy shared execution isolated.
- Old/unscoped workers keep their shared behavior. A running unscoped worker cannot be safely converted to file isolation by a message because it may already hold shell/external tools. Stop/restart it with explicit scope when containment is required.
- Scope is limited to workspace writes through host-supplied tools. Normal host metadata, captures and mailbox persistence remain available. Read access is not isolated, and unrelated concurrent programs or filesystem races caused by them are not OS-contained by this policy.
- Scope does not fix SDK message-schema errors. Historical no-final/schema failures retain their separate diagnostics, saved partial effects and tool-free handoff recovery.

## Evidence

Before the change, isolated regression probes showed an out-of-task `C.txt` write succeeding under an intended A/B scope, and task dispatch dropping that scope. No consumer workspace was edited.

Behavior tests now cover A/B writes, C refusal, read-before-edit, no LSP effects, traversal/symlink/hardlink/special-path refusal, native identity filtering, live revoke/widen with a correlated question, exact idempotency, current scope on captured worker tools, foreign-owner denial, and serialization with an in-flight write. Validation run IDs and final command results are tracked in `.quick-codex-flow/sessions/01a19a34-2b32-7d10-b985-5f867afcc7e5/runs/worker-task-write-scope.md`.

- Broad regression: 280 tests/16 files passed. Later quota and native missing-file handling changes passed their affected regression groups (56 tests/4 files and 54 tests/3 files respectively). Counts overlap; the full repository suite was not run.
- Final build, including tsc, and scoped diff checks passed. Native workspace selfverify `dcad265c-c2e7-46f2-ac57-f6fe84c4d19b` passed smoke-boot 1/1; this is not a live-provider/schema test.
- Installed global CLI resolves to the workspace and compiled scope modules match. Reopen/resume the CLI to load new modules; legacy/unscoped running workers need replacement with explicit scope to gain this containment. No existing process was restarted, consumer source changed, or paid model call made for this patch.
