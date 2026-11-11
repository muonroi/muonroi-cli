# Tool contract clarity after session a0440cf44684

Implemented the two confirmed clarity issues from [the runtime audit](session-a0440cf44684-runtime-feedback-2026-10-16.md). This patch concerns CLI tools only.

## Result

- `git_commit` outside a Git worktree now explicitly reports that no commit was created, returns `success:false`, `committed:false`, `skipped:true`, `reason:"not-a-repo"`, and advises continuing without a commit instead of retrying unchanged conditions. It does not initialize a repository. Real commit success and other failures retain their existing behavior.
- `read_file` prerequisites in edit/write descriptions and the missing-read error now identify the current tool run. Earlier-turn reads can require refreshing because a rebuilt registry owns a fresh tracker. Comments and the empty write-ledger explanation use the same lifetime. File hashes, stale-content protection and commit scope are unchanged.

Evidence motivating this patch: main session a0440cf44684 tool results at seq13/50 report `not-a-repo`; seq57/63 report missing reads after the new user turn at seq53. An isolated native-tool fixture independently reproduces fresh-registry behavior.

## Verification

1. Added an actual non-Git-directory regression using native tools. Before the production fix: 1 failed, 4 passed. After the fix, the focused scope passed **50 tests in 6 files**:

   ```powershell
   bunx vitest run src/tools/registry-git-commit-empty-ledger.test.ts src/tools/file-tracker.test.ts src/tools/file.test.ts src/orchestrator/__tests__/auto-commit-run-root.test.ts src/orchestrator/__tests__/commit-gate-detail.test.ts src/tools/__tests__/registry-arg-guard.test.ts
   ```

2. `bun run build` exited 0, including TypeScript compilation.
3. Actual compiled native tools in an isolated plain-text fixture passed **8/8** checks: same-registry read/edit, rebuilt-registry missing read, recovery after fresh read, descriptions naming the current run, missing-read guidance, non-Git skip fields, no Git initialization, and stale-content rejection. No model/provider calls were used.
4. Whitespace validation passed with CRLF accepted. Existing Vitest mock-hoist and fixture Git line-ending warnings remain in the logs.

The compiled fixture initially checked the wrong literal phrase (`current tool run` versus the returned `current content in this tool run`). Its corrected assertion passes against the same compiled production code. This was a fixture correction, not another production fix.

Private controls/logs are under `.scratch/a044-tool-contract-clarity/`: `red.log`, `tests.log`, `build.log`, `verify-compiled.mjs`, `compiled-result.json`, `compiled.log`, and `diff-check.log`. A SHA-256 manifest in `evidence/a044-tool-contract-clarity-2026-10-16.json` records source/control hashes at verification time; these hashes include any earlier workspace changes in shared files, not attribution of their entire diff to this patch.

## Limits and rollout

No full-suite, live-provider or live-TUI pass is claimed. This patch does not alter workflow gates, routing, permission policy or UI. No commit, push, user-settings change or server deployment was performed. Restart the linked local CLI/MCP process to load the rebuilt files. An `npx` published/cached installation is a separate executable provenance and is not updated by this local build.

Automatic stage selection, compaction changes, LSP suppression, retries, edit preview and more verification runners remain separate product/measurement questions. The original audit's evidence requests remain applicable; this patch does not claim those proposals are fixed.
