---
phase: 6
slug: pil-router-migration
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `bun run test -- --reporter=verbose src/pil/` |
| **Full suite command** | `bun run test` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun run test -- --reporter=verbose src/pil/`
- **After every plan wave:** Run `bun run test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | PIL-04 | unit | `bun run test -- src/pil/__tests__/response-tools.test.ts` | Yes | pending |
| 06-01-02 | 01 | 1 | PIL-01 | unit | `bun run test -- src/pil/__tests__/layer1-intent.test.ts` | Yes | pending |
| 06-02-01 | 02 | 1 | PIL-02 | unit | `bun run test -- src/pil/__tests__/layer3-ee-injection.test.ts` | Yes | pending |
| 06-02-02 | 02 | 1 | PIL-02 | grep | `grep -c "handleSearch" ../experience-engine/server.js` | N/A (cross-repo) | pending |
| 06-03-01 | 03 | 2 | PIL-03 | unit | `bun run test -- src/pil/__tests__/task-tier-map.test.ts src/pil/__tests__/layer6-output.test.ts` | Co-created (atomic) | pending |
| 06-03-02 | 03 | 2 | ROUTE-11 | unit | `bun run test -- src/orchestrator/__tests__/route-feedback.test.ts` | Co-created (atomic) | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

All Wave 0 gaps are addressed by co-creation (source + test created atomically in the same task):

- [x] `src/pil/task-tier-map.ts` + `src/pil/__tests__/task-tier-map.test.ts` — co-created in Plan 03 Task 1
- [x] `src/orchestrator/__tests__/route-feedback.test.ts` — created as first step of Plan 03 Task 2 (test stubs before wiring)

*Existing test infrastructure covers PIL-01, PIL-02, PIL-03, PIL-04.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Vietnamese+code mix detection | PIL-03 | Requires Ollama model running | Send mixed Vi+code prompt, verify formality/codeHeavy detection |
| respond_general fallthrough | PIL-04 | Requires full conversation flow | Send prompt matching no typed tool, verify response generated |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (co-creation pattern)
- [x] No watch-mode flags
- [x] Feedback latency < 20s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
