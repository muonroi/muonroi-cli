# Worker approval visual redesign

The user screenshot showed a nearly full-screen approval for one short `retrieve_tool_result` input. The previous `WorkerApprovalPanel` used terminal height minus two rows regardless of content. This change is confined to that component in `src/ui/modals/wallet-picker-modal.tsx`; the prior working tree remains intact.

The card is now centered, limited to 90 columns and sized to the request. A themed rounded border separates the operation/worker header, locally scrollable request, subdued correlation metadata and highlighted side-by-side choices. The exact call ID, digest and deadline remain readable. Input is neither summarized nor truncated. Permission decisions, keyboard routing, main payment and the host approval protocol are unchanged.

## Fresh verification

| Check | Result | Evidence |
| --- | --- | --- |
| Focus/navigation/modal regressions | 73 tests, 5 files passed | `.scratch/approval-visual-redesign/focused-tests.log` |
| Typecheck, build, semantic instrumentation, scoped diff check | Passed | `typecheck.log`, `build.log`, `semantic.log` under the same directory |
| Source and compiled native renderer | Each 3/3 passed | `source-native-report.json`, `built-native-report.json` |
| Rendered sizes and navigation | Short 150×48 and 80×24; long 80×24; prefix/middle/suffix, Home/End, selection and new-request reset passed | Native frame `.txt` and span `.json` files in the same directory |
| Actual compiled Bun App | 8/8 controls passed: model-only worker, Allow once, Deny, Esc, foreground, responsive follow-up, long preview and draft preservation | `.scratch/session5689/tui-safe-2SbKk3/report.json` |
| Native `selfverify_*` | Boot 1/1 passed | `.scratch/approval-visual-redesign/native-selfverify.json`, run `4b676a07-437b-4160-804d-29202fe7307a` |
| Frozen revision and settings | 51 file hashes stable through the App controls; real settings hashes unchanged | App report and `.scratch/approval-visual-redesign/freeze.json` |

The first private renderer attempt exposed overlapping action/footer rows. Explicit nonshrinking row heights fixed this; its failed log is preserved as `source-native-first-attempt.log`. Passing results above were captured afterward.

Compared with the preceding feature freeze, only `wallet-picker-modal.tsx` and its compiled `.js` changed among the 51 monitored paths. Colored previews `approval-short-wide.png` and `approval-short-compact.png` are rendered directly from captured native cell content/colors using Consolas; they are not a fabricated UI mockup or a screenshot of the user's running process.

These checks use isolated homes/projects and offline SDK responses with actual native UI/tools/detached file operations. They establish the named controls, not paid-provider behavior or the revision loaded by an already running user TUI. The old 9,478-test suite was not rerun for this presentation-only change. No commit, push or deployment was performed. Restart the CLI to load the rebuilt local UI.
