# Session 441325f7b3c5: evidence provenance and passive-log repair

## Acceptance evidence from the previous run

The original files remain present at the CLI checkout, independently of application assembly logs in another workspace:

- `D:/sources/Core/muonroi-cli/.scratch/forensics-measurement-coverage/tests-expanded.log`: 30 files, 313 tests passed; historical run, not a new full-suite claim.
- `D:/sources/Core/muonroi-cli/.scratch/forensics-measurement-coverage/native-result.json`: fifteen named controls are true; run d11f2fda-4e72-449d-a499-ed566e83ba2d has one boot scenario, 1/1 passed.
- Packaging changes remain visible in the working tree: core package Node exports, tsup entry points and build-time schema import in spec-helpers. The generated file is `packages/agent-harness-core/dist/node/predicate.js`; it is not expected next to source driver.ts. A commit is not required for a working-tree diff to exist.

Portable, bounded evidence with original paths, byte lengths, SHA-256 hashes, summaries and run scopes: [cli-handoff-441325f7b3c5.json](evidence/cli-handoff-441325f7b3c5.json). Current source hashes are explicitly labeled current; historical acceptance files were not regenerated.

## Additional runtime failure and repair

Read-only session transcript evidence (messages 39 and 41) confirms run 0617e6d7-e347-40c7-8f59-af883297397e: smoke-boot passed, passive-log failed waiting 15 seconds for id=log. This 1/2 result covers a different scenario selection from the earlier boot-only 1/1 result; both are accurate for their own scopes.

The planner classified log as always present and waited for it without creating a transcript. `src/ui/app.tsx` renders log only inside hasMessages. The existing scroll-lock harness spec already submits a message before checking the transcript.

The log opener now waits for composer readiness, types a probe, submits it, and waits for id=log. Log is removed from ALWAYS_PRESENT. Selector and no-error assertions remain in place; the timeout was not increased and the scenario was not skipped.

Fresh validation:

- Regression RED: missing submit step, 1 failed / 15 passed.
- Final focused suite: **72 tests / 9 files passed**.
- Build and whitespace check: exit 0.
- Compiled native/MCP fixture: **15/15 controls passed**, including **smoke-boot + passive-log 2/2**. Run **92c4e20a-d887-42f6-9de4-dc3e15705b63**.
- Private artifacts: `.scratch/passive-log-evidence-handoff/`.

The isolated fixture initially forced unauthenticated boot through MUONROI_TEST_NO_KEYCHAIN=1, which suppresses all key sources, including fake environment keys. Those negative results are retained. The successful message scenario uses the existing harness approach: fake test credential, mock model, isolated home/DB and that forced-unauthenticated flag disabled. Production credentials/settings were not changed. This proves the bounded mock scenarios, not live-provider correctness or all UI surfaces.

## Repository policy attribution

Current source locations are:

- `D:/sources/CompanyLibs/tcis-libraries/CLAUDE.md:100`: permits direct breaking changes during development.
- `D:/sources/CompanyLibs/tcis-libraries/AGENTS.md:235`: requires Obsolete.
- CLI `AGENTS.md:100` discusses native platform features; CLI `CLAUDE.md:235` documents toast events. These are not the quoted TCIS policies.

Session metadata starts in tcis-libraries and records its latest cwd as muonroi-cli. This demonstrates that cwd changed, not which instruction source was loaded at each point. The report's relative paths and reversed file labels do not establish a CLI policy conflict. No guideline file was modified.

## New qualitative feedback

Two instruction issues are directly visible in current source and can be addressed without another generic evaluation: native-capabilities-workbook requires LSP diagnostics/impact before broad grep and prohibits fallback when status is ok; bash tool documentation prohibits output-filter pipes while its own example uses head pipes. The workbook also retains a fixed 500-token-per-call claim. These are separate follow-up targets, not changes included in the passive-log repair.

Automatic rehydration needs one concrete elision example before choosing retrieval rules or budgets. Request only: session + toolCallId, exact stub, task detail lost, retrieval attempted and its result. Seeing provider-limit guidance does not establish a real HTTP 429. No further broad report-polishing loop is needed.
