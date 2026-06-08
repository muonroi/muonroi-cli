---
phase: 06-4-upgrades-security-perf-report-ui
plan: 02-reporting
type: execute
wave: 1
depends_on: ["Wave 0"]
files_modified:
  - src/cli/usage-report.ts
  - src/cli/index.ts
  - src/usage/decision-log.ts
  - src/usage/cost-log.ts
  - tests/cli/usage-report.test.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "`usage report --by callsite|role|phase|model|provider --breakdown` (cli/usage-report.ts:220) already excellent"
    - "Drift detection, agent-self snapshot, cost-log + product-ledger exist"
    - "Forensics command exists (prior context)"
  artifacts:
    - path: src/cli/usage-report.ts
      provides: "New subcommands: security-audit, perf-regression, ui-interaction; --format md|json export"
    - path: src/cli/index.ts
      provides: "Wiring for `usage security-audit`, `usage perf`"
    - path: tests/cli/usage-report.test.ts
      provides: "Tests for new report aggregation with security/perf events"
  key_links:
    - from: src/cli/usage-report.ts (line 220)
      to: runUsageReport + aggregate/printTable
      via: "extend for new audit types"
      pattern: "usage-report.ts:220"
---

<objectives>
Turn existing rich logs into actionable, user- and agent-consumable reports for security, perf, and product health.

Purpose: Leverage existing cost-log, decision-log, product-ledger to surface yolo usage, perf regressions, UI interactions without new storage. Reuse aggregate() and printTable() to avoid duplication.
Output: 
- `usage security-audit --since 7d`
- `usage perf-regression --compare baseline.json`
- `usage ui-interaction` (from LiveEvent if enabled)
- `--format md|json` for all
- Scheduled daily summary job
</objectives>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md
@src/cli/usage-report.ts (lines 200-274)
@src/cli/index.ts (usage subcommand registration)
@src/usage/decision-log.ts
@src/usage/cost-log.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extend usage-report.ts with security-audit and perf-regression subcommands</name>
  <files>src/cli/usage-report.ts, tests/cli/usage-report.test.ts</files>
  <read_first>
    - src/cli/usage-report.ts (lines 200-274: aggregate, printTable, agent-self snapshot)
    - .planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md (Reporting section lines 81-107)
  </read_first>
  <behavior>
    - Add runSecurityAudit(since: string): parse decision-log for yolo/high-risk/permission overrides
    - Add runPerfRegression(compare?: string): compare ctx_tokens, compaction savings, cache hits from cost-log
    - Reuse existing aggregate() and printTable(); support --format md|json
    - New tests: assert security-audit outputs yolo sessions; perf-regression computes deltas
  </behavior>
  <verification>
    - `bunx vitest run tests/cli/usage-report.test.ts`
    - `bun run src/index.ts usage security-audit --since 1h --json | jq`
  </verification>
</task>

<task type="auto">
  <name>Task 2: Add ui-interaction report + export + wire CLI</name>
  <files>src/cli/usage-report.ts, src/cli/index.ts</files>
  <read_first>
    - src/cli/index.ts (usage command setup)
    - src/usage/decision-log.ts (for LiveEvent integration if present)
  </read_first>
  <behavior>
    - ui-interaction: aggregate from harness LiveEvent or log (modals, slash, askcard)
    - Add --format to all reports
    - Wire in index.ts: usage security-audit, usage perf-regression, usage ui-interaction
    - Scheduled: use existing schedule tool for daily summary to ~/.muonroi-cli/reports/
  </behavior>
  <verification>
    - New commands in `bun run src/index.ts usage --help`
    - Smoke: `usage report --json | jq` still works; new ones appear
    - No duplicate code (reuse aggregate/printTable)
  </verification>
</task>

</tasks>

<verification_gate>
- `bunx tsc --noEmit && bunx vitest run`
- Smoke: `bun run src/index.ts usage security-audit --json`
- Harness if events used
- This sub-PLAN updated post-land
</verification_gate>
