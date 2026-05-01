---
phase: 10
slug: prompt-stale-reconciliation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-02
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | STALE-01 | unit | `npx vitest run src/ee/intercept.test.ts` | ✅ | ⬜ pending |
| 10-01-02 | 01 | 1 | STALE-02 | unit | `npx vitest run src/ee/posttool.test.ts` | ✅ | ⬜ pending |
| 10-01-03 | 01 | 1 | STALE-03 | unit | `npx vitest run src/hooks/index.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 1 | STALE-01,02,03 | integration | `npx vitest run src/ee/__tests__/pipeline.integration.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- Existing infrastructure covers all phase requirements. vitest is installed and configured, test files exist for intercept, posttool, and pipeline integration.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Prompt-stale does not add visible latency | STALE-03 | Latency is perceptual — requires human timing | Run CLI with EE server, execute 3 tool calls, confirm no visible delay between turns |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
