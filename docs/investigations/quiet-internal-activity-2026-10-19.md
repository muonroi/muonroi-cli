# Quiet internal activity

The user requested that routine job/sub-agent/delegation/EE completion details stay off the default screen while main retains full results.

## Changes

- Display-only projection hides internal coordination and EE tool cards and removes them from mixed tool-group counts, expansion targets and failure headers. Ordinary tool/diff output, user text and main answers are retained. No prose keyword filtering.
- Host notifications carry an internal display flag. Automatic wake turns receive host-owned provenance persisted with their full prompt; reloading the transcript preserves that provenance. System context entries stay stored but are internal to the display. An identical prompt typed by a user remains visible.
- Automatic worker activity lines, agent/job rosters and session tree are removed from the default transcript/rail. Explicit `/jobs`, job records and diagnostic commands remain available. No delivery, ACK, acceptance, scheduling or approval rule changed.
- EE event decorations and automatic EE failure toasts are file-only. Main's actual recall/guidance and raw tool results are unchanged. Actionable user approval/question/error paths remain in place.
- Main's operating contract requests concise user-facing progress/results rather than routine lifecycle/receipt/memory narration. Main still must read full results, verify, ACK and accept correctly.

## Evidence

All artifacts are under `.scratch/quiet-internal-activity/`.

| Check | Result |
|---|---|
| Native compiled before-control | Internal sentinels and hidden-only failure headers visible at120/64 columns; main/user controls passed (`before.json`) |
| Focused regressions | 196 tests /14 files passed (`tests.log`) |
| Typecheck/build | exit0 (`typecheck.log`, `build.log`) |
| Native compiled after-control | 11/11 checks: internal sentinels hidden, main/user/useful file action retained, raw fixture unchanged (`native-display.json`) |
| Built real SQLite reopen + actual SDK local transport | 9/9: private DB, full canonical receipts retained, host wake hidden, identical user copy visible, main answer visible, full receipts reach the SDK request, UI metadata absent from HTTP body (`compiled-reload.json`) |
| Native tools-MCP selfverify | Actual Bun TUI boot1/1 (`native-selfverify.json`) |

The render controls use synthetic host messages, not paid providers or real worker executions. The SQLite/transport fixture isolates HOME/USERPROFILE/CLI/auth/env paths and asserts the actual DB path is private. No old sessions, user settings, credentials or worker records were rewritten. The prompt rule guides model narration; no renderer attempts to erase arbitrary main/user prose mentioning internal systems. Existing historical wake text lacking host provenance is not guessed from its wording. Restart the current CLI once to load the built changes. No push/deploy or full-suite claim.
