---
phase: 03-polish-headless-cross-platform-beta
plan: 05
subsystem: ops-support
tags: [github, issue-templates, status, beta, documentation]
dependency_graph:
  requires: []
  provides: [OPS-03, OPS-04]
  affects: [.github/ISSUE_TEMPLATE, STATUS.md]
tech_stack:
  added: []
  patterns: [GitHub issue forms YAML, structured beta status page]
key_files:
  created:
    - .github/ISSUE_TEMPLATE/bug_report.yml
    - .github/ISSUE_TEMPLATE/feature_request.yml
    - STATUS.md
  modified: []
key_decisions:
  - "Bug report template requires muonroi-cli doctor output and muonroi-cli bug-report bundle as structured fields with validations"
  - "STATUS.md documents 4 known issues with severity/workaround table for solo-maintainer ops surface"
metrics:
  duration_minutes: 2
  completed_date: "2026-04-30"
  tasks_completed: 2
  files_created: 3
  files_modified: 0
---

# Phase 03 Plan 05: GitHub Issue Templates and STATUS.md Summary

**One-liner:** GitHub bug report template (requiring doctor output + auto-redaction guidance) and feature request template created alongside STATUS.md with known issues table, 3-method beta enrollment, and 5-phase rollout plan.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create GitHub issue templates | 612682c | .github/ISSUE_TEMPLATE/bug_report.yml, .github/ISSUE_TEMPLATE/feature_request.yml |
| 2 | Create STATUS.md | 7cd244c | STATUS.md |

## What Was Built

### Task 1: GitHub Issue Templates

**`.github/ISSUE_TEMPLATE/bug_report.yml`**
- Markdown preamble with pre-submission checklist pointing users to `muonroi-cli doctor` and `muonroi-cli bug-report`
- Auto-redaction guidance listing `sk-` API keys, auth tokens, username paths, and private prompt content
- Required textarea for doctor output with example placeholder
- Required textarea for bug description
- Required textarea for steps to reproduce
- Required dropdown for permission mode (safe / auto-edit / yolo)
- Optional textarea for bug-report JSON bundle (render: json)

**`.github/ISSUE_TEMPLATE/feature_request.yml`**
- Required textarea for problem statement
- Required textarea for proposed solution
- Optional textarea for alternatives considered
- Required dropdown for scope (CLI/TUI, Provider/Model, Router/Cap, Experience Engine, Flow/Slash Commands, MCP/LSP/Tools, Headless/CI, Other)

### Task 2: STATUS.md

Current state summary with 7 capabilities listed. Four known issues documented in table format:
- Standalone binary keytar limitation (Low — ANTHROPIC_API_KEY workaround)
- LSP smoke test PATH dependency (Low — bun add workaround)
- Qdrant health check warn when not running (Info — by design)
- install.sh self-hosted fork path update (Low — will fix v1.0)

Beta Enrollment section with 3 install methods: npm global install, source clone + bun run dev, standalone binary download. First Run commands for TUI, doctor, and headless mode. Reporting instructions pointing to issue templates.

Rollout Plan table covers all 5 phases with current status (Phase 3 = In Progress, Phase 4 = Planned).

## Deviations from Plan

None — plan executed exactly as written. Note: `.github/workflows/ci-matrix.yml` referenced in `read_first` does not exist (was created in a different plan under a different name), but was not required for task completion.

## Known Stubs

None.

## Self-Check: PASSED

- .github/ISSUE_TEMPLATE/bug_report.yml: FOUND
- .github/ISSUE_TEMPLATE/feature_request.yml: FOUND
- STATUS.md: FOUND
- Commit 612682c: FOUND
- Commit 7cd244c: FOUND
