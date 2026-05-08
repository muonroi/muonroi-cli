---
phase: 14
slug: council-accounting-research-mcp
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-08
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `npx vitest run src/council` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds (council suite only) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/council`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | CQ-02 | — | N/A | type-check | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 14-01-02 | 01 | 1 | CQ-01 | — | N/A | type-check | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 14-02-01 | 02 | 2 | CQ-01, CQ-02 | — | N/A | unit | `npx vitest run src/council/__tests__/accounting.test.ts` | ❌ W0 | ⬜ pending |
| 14-02-02 | 02 | 2 | CQ-03, CQ-04, CQ-05 | — | N/A | unit | `npx vitest run src/council/__tests__/research-tools.test.ts` | ❌ W0 | ⬜ pending |
| 14-03-01 | 03 | 2 | CQ-02 | — | N/A | type-check + unit | `npx tsc --noEmit && npx vitest run src/council` | ✅ | ⬜ pending |
| 14-03-02 | 03 | 2 | CQ-01, CQ-02 | — | N/A | unit | `npx vitest run src/council/__tests__/accounting.test.ts` | ❌ W0 | ⬜ pending |
| 14-03-03 | 03 | 2 | CQ-01 | — | N/A | type-check | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 14-04-01 | 04 | 2 | CQ-05 | — | N/A | unit | `npx vitest run src/council/__tests__/research-tools.test.ts` | ❌ W0 | ⬜ pending |
| 14-04-02 | 04 | 2 | CQ-03, CQ-04 | — | N/A | unit | `npx vitest run src/council/__tests__/research-tools.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/council/__tests__/accounting.test.ts` — RED tests for CQ-01 (stats.calls) and CQ-02 (finalPositions) — created by Plan 02 Task 1
- [ ] `src/council/__tests__/research-tools.test.ts` — RED tests for CQ-03 (MCP merge), CQ-04 (URL browser check), CQ-05 (3-section template) — created by Plan 02 Task 2

*Existing tests that must continue to pass: `clarifier-options.test.ts`, `clarifier-max-rounds.test.ts`*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Acceptance: rerun audit topic against D:\sources\eBerth; council memory has stats.calls > 0, non-empty finalPositions, research citations | CQ-01..CQ-05 | Requires live MCP (tavily, playwright) + running app at localhost:3010 | Run council with topic from v1.6-council-quality-context.md §1; inspect `[Council Memory]` record in DB |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (accounting.test.ts, research-tools.test.ts)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
