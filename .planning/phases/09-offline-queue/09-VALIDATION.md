---
phase: 09
slug: offline-queue
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-02
---

# Phase 09 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `bunx vitest run src/ee/offline-queue` |
| **Full suite command** | `bunx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bunx vitest run src/ee/offline-queue`
- **After every plan wave:** Run `bunx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | QUEUE-01 | unit | `bunx vitest run src/ee/offline-queue` | ❌ W0 | ⬜ pending |
| 09-01-02 | 01 | 1 | QUEUE-03 | unit | `bunx vitest run src/ee/offline-queue` | ❌ W0 | ⬜ pending |
| 09-01-03 | 01 | 1 | QUEUE-04 | unit | `bunx vitest run src/ee/offline-queue` | ❌ W0 | ⬜ pending |
| 09-02-01 | 02 | 2 | QUEUE-02 | unit | `bunx vitest run src/ee/offline-queue` | ❌ W0 | ⬜ pending |
| 09-02-02 | 02 | 2 | QUEUE-05 | unit | `bunx vitest run src/ee/offline-queue` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/ee/__tests__/offline-queue.test.ts` — unit tests for enqueue/dequeue/cap/drain
- [ ] Test fixtures for temp queue directory (use `homeOverride` pattern from auth.ts)

*Existing vitest infrastructure covers framework setup.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CLI operates normally when EE is down | QUEUE-01 | Requires live EE server shutdown | 1. Stop EE server 2. Run CLI command 3. Verify no error shown 4. Check queue dir has entries |
| Queue replays on EE recovery | QUEUE-02 | Requires EE server restart | 1. Queue entries from above 2. Start EE server 3. Trigger any EE call 4. Verify queue drains |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
