---
phase: 6
slug: pil-router-migration
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| 06-01-01 | 01 | 1 | PIL-01 | unit | `bun run test -- src/pil/__tests__/layer1-intent.test.ts` | ✅ | ⬜ pending |
| 06-01-02 | 01 | 1 | PIL-04 | unit | `bun run test -- src/pil/__tests__/response-tools.test.ts` | ✅ | ⬜ pending |
| 06-02-01 | 02 | 1 | PIL-02 | unit | `bun run test -- src/pil/__tests__/layer3-ee-injection.test.ts` | ✅ | ⬜ pending |
| 06-02-02 | 02 | 1 | PIL-03 | unit | `bun run test -- src/pil/__tests__/layer6-output.test.ts` | ✅ | ⬜ pending |
| 06-03-01 | 03 | 2 | ROUTE-11 | unit | `bun run test -- src/pil/__tests__/task-tier-map.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/pil/__tests__/task-tier-map.test.ts` — stubs for ROUTE-11 tier mapping
- [ ] `src/pil/task-tier-map.ts` — new file for taskType-to-tier mapping

*Existing test infrastructure covers PIL-01, PIL-02, PIL-03, PIL-04.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Vietnamese+code mix detection | PIL-03 | Requires Ollama model running | Send mixed Vi+code prompt, verify formality/codeHeavy detection |
| respond_general fallthrough | PIL-04 | Requires full conversation flow | Send prompt matching no typed tool, verify response generated |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
