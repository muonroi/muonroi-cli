---
phase: 03-polish-headless-cross-platform-beta
plan: "03"
subsystem: ops
tags: [doctor, bug-report, health-checks, diagnostics, cli-commands]
dependency_graph:
  requires:
    - src/ee/health.ts (EE health check interface)
    - src/utils/redactor.ts (secret scrubbing singleton)
    - src/index.ts (commander CLI entry point)
  provides:
    - src/ops/doctor.ts (runDoctor, CheckResult, formatDoctorReport)
    - src/ops/bug-report.ts (buildBugReport, BugReportBundle, formatBugReport)
  affects:
    - src/index.ts (added doctor and bug-report subcommands)
tech_stack:
  added: []
  patterns:
    - "TDD red-green cycle for both modules"
    - "Named imports from fs/promises for vitest mock compatibility on Windows"
    - "Config allowlist pattern for zero-secret diagnostic bundles"
    - "redactor.redact() for error log line scrubbing"
key_files:
  created:
    - src/ops/doctor.ts
    - src/ops/doctor.test.ts
    - src/ops/bug-report.ts
    - src/ops/bug-report.test.ts
  modified:
    - src/index.ts
decisions:
  - "Used redactor.redact() not redactor.scrub() — plan had wrong method name; actual API from redactor.ts is redact()"
  - "Named import { readFile } from fs/promises instead of default import for vitest mock compatibility on Windows"
  - "Config allowlist includes cap.monthly_usd, router.confidence_threshold, mcp_servers_count — excludes ee.authToken and all token/key fields"
metrics:
  duration: "5 minutes"
  completed_date: "2026-04-30"
  tasks_completed: 2
  files_changed: 5
---

# Phase 3 Plan 03: Doctor and Bug-Report Commands Summary

**One-liner:** OPS-01/OPS-02 — doctor runs 7 named health checks (bun/os/key/ollama/ee/qdrant/error-rate) with pass/warn/fail table; bug-report builds a config-allowlisted, redactor-scrubbed JSON diagnostic bundle.

## What Was Built

### Task 1: doctor command (src/ops/doctor.ts)

- `runDoctor()` runs 7 checks in parallel via `Promise.all()`
- `CheckResult` interface: `{ name, status: "pass"|"warn"|"fail", detail }`
- `formatDoctorReport()` renders printable table with `[PASS]`/`[WARN]`/`[FAIL]` icons and a summary line
- Optional services (Ollama VPS, EE, Qdrant) always return `warn` on failure — never `fail` or crash
- `checkBunVersion()` validates `>= 1.3.13` semver with full major.minor.patch comparison
- `checkKeyPresence()` checks env var then OS keychain (keytar)
- `checkRecentErrorRate()` parses `~/.muonroi-cli/errors.log` ISO timestamps; warn at > 10 errors, fail at > 50
- Tests: 9 tests covering all 7 check names, status validity, formatDoctorReport icons, unreachable service behavior

### Task 2: bug-report command (src/ops/bug-report.ts)

- `buildBugReport()` returns `BugReportBundle` with: `generated_at`, `bun_version`, `os`, `doctor`, `config_redacted`, `error_log_tail`, `ee_status`
- Config loaded from `~/.muonroi-cli/config.json` via allowlist — only `cap.monthly_usd`, `router.confidence_threshold`, `mcp_servers_count` included; `ee.authToken` and all secrets excluded
- Error log tail limited to 20 lines, each passed through `redactor.redact()` to scrub API keys
- `formatBugReport()` serializes to pretty-printed JSON
- Tests: 7 tests covering required sections, timestamp validity, authToken exclusion, sk-ant redaction, 20-line limit, valid JSON output

### CLI Wiring (src/index.ts)

Added two commander subcommands after the `daemon` command:
- `.command("doctor")` — calls `runDoctor()`, prints table, exits 1 if any check fails
- `.command("bug-report")` — calls `buildBugReport()`, prints JSON to stdout

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan referenced `redactor.scrub()` — actual method is `redactor.redact()`**
- **Found during:** Task 2 implementation
- **Issue:** Plan's interface doc said `redactor.scrub(str: string): string` but `src/utils/redactor.ts` exports `redact(input: string): string` (the Redactor class has `redact`, `redactError`, `enrollSecret`)
- **Fix:** Used `redactor.redact()` in bug-report.ts and doctor.ts
- **Files modified:** src/ops/bug-report.ts
- **Commit:** b9db0ef

**2. [Rule 1 - Bug] Named import `{ readFile }` required for vitest mock compatibility on Windows**
- **Found during:** Task 2 TDD green phase (test failure debugging)
- **Issue:** `import fs from "fs/promises"` default import pattern breaks vitest module mocking — the mock spreads named exports but the default accessor fails on Windows+Bun
- **Fix:** Changed both `doctor.ts` and `bug-report.ts` to use `import { readFile } from "fs/promises"` and mock the named export directly
- **Files modified:** src/ops/doctor.ts, src/ops/bug-report.ts
- **Commit:** b9db0ef

**3. [Rule 1 - Bug] Windows path separator in test mocks**
- **Found during:** Task 2 test debugging
- **Issue:** `filePath === configPath` fails on Windows when path includes backslashes vs forward slashes
- **Fix:** Changed mock conditions to use `String(filePath).endsWith("config.json")` and `endsWith("errors.log")` for cross-platform compatibility
- **Files modified:** src/ops/bug-report.test.ts
- **Commit:** b9db0ef

## Known Stubs

None — all features fully implemented. No placeholder data or TODO stubs.

## Self-Check: PASSED

- src/ops/doctor.ts — FOUND
- src/ops/doctor.test.ts — FOUND
- src/ops/bug-report.ts — FOUND
- src/ops/bug-report.test.ts — FOUND
- Commit 9494bf7 — FOUND
- Commit b9db0ef — FOUND
