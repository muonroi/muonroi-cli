# Forensics measurement coverage follow-up

The CLI agent's report mixed one `prepared-request` row with two legacy `gate-accounting` rows. It also compared `messagesChars` with its contained `toolResultsChars`. The API exposed per-row kinds but only one combined total and no explanation of component nesting.

## Read-only live evidence

Direct queries against the original CLI SQLite DB on 2026-10-15 found:

| Exact session scope | Legacy call_accounting | New prompt_breakdown |
| --- | ---: | ---: |
| 5a74a2451830 | 29 | 3 |
| c9fdef1b04d4 | 109 | 0 |
| d6c4742f147c | 143 | 0 |

These are exact-session queries; the forensics API retains its existing root-and-descendants family scope. Counts must not be compared without matching scope and cutoff. New prepared rows in 5a74a2451830 are 58605, 58613 and 58618, timestamped 10:00:36.420Z, 10:01:38.724Z and 10:02:30.282Z. The report's earlier 1/53 snapshot is not the current direct-session snapshot. These observations do not establish missing new telemetry. Old rows lack the newer schema/call measurements; do not manufacture a historical backfill.

For row 58605, 181,878 message characters equal 45,803 history + 136,075 tool-result characters. Disjoint prepared text totals 288,438 characters: system 69,109 (23.96%), history 45,803 (15.88%), tool results 136,075 (47.18%), tool schemas 37,451 (12.98%). These are character shares from one labeled preparation-layer observation, not provider token or cost shares. No instruction stripping or TCIS policy change follows from this sample.

## Change

- `requestMeasurements.byKind` exposes snapshot-wide prepared-request and gate-accounting counts, including zero, independently of the selected page.
- Shared native/MCP telemetry notes distinguish legacy coverage, nested versus disjoint components, measured character lengths and estimated token/cost values.
- Existing pagination, snapshot cutoff, session scope, estimators and provider routing are preserved. No additional scans, HTTP calls or historical DB writes.
- Reproduced and fixed a verification packaging blocker: public harness subpaths now provide compiled Node exports with matching tsup entries. CLI builds refresh the core workspace package before compiling the CLI. Type/browser/default conditions are retained.
- The all-subpaths Node test also reproduced a schema path failure in the compiled package root and spec-helpers. The schema is now imported at build time and embedded in the bundles, removing the dependency on a source-relative runtime docs path.

## Fresh verification

- RED: one missing-coverage regression failed before implementation; five existing tests passed.
- Initial focused unit tests: 40 passed / 5 files, including page/cutoff/zero-count coverage. Final expanded suite: **313 passed / 30 files**, including core harness, actual Node imports of every public subpath, self-QA and forensics.
- Build: exit 0.
- Before the packaging repair, 14 compiled controls passed but offline selfverify failed before TUI startup: Node could not load `packages/agent-harness-core/src/predicate.js` imported by `driver.ts`. Failed run 614263bc-6042-4cc3-a948-83232d6e6900 and its exit-1 evidence are retained as `node-loading-failure.json` / `.log`; the next test isolated the schema path failure (`schema-path-red.log`).
- Final compiled native and fresh stdio MCP with isolated SQLite: **15/15 controls passed**, including matching kind counts, unchanged counts across pages, error provenance, redaction, bounded output (24,976 characters), frozen-cutoff behavior and offline TUI boot.
- Final native offline selfverify run **d11f2fda-4e72-449d-a499-ed566e83ba2d** passed **1/1**. This proves the bounded boot scenario, not all UI workflows or paid-provider behavior.
- Private artifacts: `.scratch/forensics-measurement-coverage/` contains RED/test/build logs, compiled fixture runner and its full native result. No paid-provider calls, live DB writes, TCIS edits, commit/push or deployment.

No further CLI-agent measurement question is required for this bounded change. Restart existing CLI/MCP processes to load rebuilt modules. Instruction loading/deduplication remains outside this change because the supplied samples do not establish a concrete CLI duplication defect.
