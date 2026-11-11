# Windows file index: CMD error in the TUI

The user's `operable program or batch file` text comes from the non-Git file suggestion index. The TUI caller constructs FileIndex in use-app-logic.tsx; useTypeahead asks it for matches. The old fallback ran `find ... | head -5000` with execSync's default shell/stderr, then silently returned an empty index on failure.

Fresh compiled reproduction at UTC07:08:17Z, from the actual `D:/sources/Core/extension/ai-dock` cwd: gitRoot=null, index size0, stderr exactly `'head' is not recognized as an internal or external command, operable program or batch file.` The Git CLI cwd control worked with2539 files and empty stderr. This matches the user's stderr mirror at07:05:10Z.

Repair in `src/utils/file-index.ts`:
- Asynchronous native directory enumeration for non-Git folders; no find/head/default-shell dependency. Skip dependency/build/Git directories and directory links; cap file/directory visits and elapsed scan time.
- Keep Git tracked/untracked/ignore semantics through argv-based `execFileSync`, captured stderr, hidden Windows child and NUL-delimited paths. Unicode and leading spaces survive parsing.
- File-only diagnostics through the existing UI logger namespace; no blanket terminal/error suppression.
- Coalesce concurrent refreshes and reject stale cwd results while retaining the existing TTL cache.

Verification:
- RED:6 failed/1 passed before repair. Acceptance:34 passed/0 failed across FileIndex/logger suites (including8 FileIndex cases), exit0.
- Build exit0, including TypeScript. First build exposed an unsupported log namespace; corrected to existing `ui` before acceptance.
- Fresh compiled same-cwd after probe at07:12:18Z: ai-dock index69 files, stderr empty; Git CLI control2541 files, stderr empty. Counts differ from baseline as new source/test files were added; no claim of byte-identical Git listing across different working-tree snapshots.
- Compiled controls16/16, actual mock-provider TUI routing/status1/1, native selfverify2/2, run `1b73f8d8-5210-42fe-a07d-143af01475ca`, exit0. TUI boot/status checks do not independently assert dropdown contents; focused native controls prove the file index/error producer.

Artifacts: `.scratch/file-index-windows/{probe.mjs,before.json,after.json,red.log,tests-accepted.log,build-accepted.log,compiled-controls.mjs,compiled-controls.json,compiled-controls.log}`. No project settings, real provider requests, running user session restart, publication or push. Start a fresh **Bun** CLI process to load the repair.
