---
phase: 5
slug: ee-bridge-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-01
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `bun run test -- --reporter=verbose src/ee/bridge.test.ts` |
| **Full suite command** | `bun run test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bun run test -- --reporter=verbose src/ee/bridge.test.ts`
- **After every plan wave:** Run `bun run test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | BRIDGE-01 | unit | `bun run test -- src/ee/bridge.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | BRIDGE-02 | unit | `bun run test -- src/ee/bridge.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-03 | 01 | 1 | BRIDGE-03 | unit | `bun run test -- src/ee/bridge.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/ee/bridge.test.ts` — stubs for BRIDGE-01, BRIDGE-02, BRIDGE-03

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CLI starts without EE installed | BRIDGE-02 | Requires removing ~/.experience/ | Remove ~/.experience/experience-core.js, run CLI, verify startup + error log |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
