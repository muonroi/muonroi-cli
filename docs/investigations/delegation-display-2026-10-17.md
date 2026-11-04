# Delegation display: keep worker results, hide internal host instructions

User choice: hide internal English instructions, keep worker results; no broader UI translation.

- `message-view.tsx` now projects a recognized versioned delegation_read host envelope out of the user-visible tool card. Worker content after the envelope remains verbatim. Model prompts, raw transcript/export, ACK metadata and owner checks are unchanged. Unknown/error output is preserved.
- `tool-result-views.tsx` now parses both legacy state rows and `[execution=...] [delivery=...] [ack=...]`. The earlier native label change had left this parser behind and caused false `No background delegations` output. States remain separate in the compact display.
- Tests:30 pass across3 focused display/grouping/delivery files. Build exit0.
- Fresh compiled component + resumed actual Bun TUI with isolated seeded SQLite:7/7 checks, correct component content, nonempty list branch, model ACK instruction retained, session restored with both tool cards. Semantic frames expose short node names, not all rendered glyphs; no full visual-screenshot assertion is claimed.
- Rebuilt native controls16/16; native selfverify2/2 run52240b18-2b41-491f-bc21-873b031f2854.
- Evidence: `.scratch/delegation-display/{accepted-tests.log,build.log,compiled-tui.json,compiled-controls.json}`. Restart CLI with Bun to load the display update. No paid worker or real user session was modified.

The user subsequently rejected per-repository EE registration as a complete fix. Generic new-repository scope resolution is tracked separately; this completed display repair must be preserved while implementing it.
