---
phase: 08
slug: session-end-extraction
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-01
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/ee/extract-session.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/ee/extract-session.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 0 | EXTRACT-01 | integration | `npx vitest run src/__test-stubs__/ee-server.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | EXTRACT-01,02 | unit | `npx vitest run src/ee/extract-session.test.ts` | ❌ W0 | ⬜ pending |
| 08-03-01 | 03 | 1 | EXTRACT-03 | unit | `npx vitest run src/ee/client.test.ts` | ✅ | ⬜ pending |
| 08-04-01 | 04 | 2 | EXTRACT-01,03 | integration | `npx vitest run src/orchestrator/cleanup.test.ts` | ❌ W0 | ⬜ pending |
| 08-05-01 | 05 | 2 | EXTRACT-04 | unit | `npx vitest run src/ee/extract-session.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/__test-stubs__/ee-server.ts` — add `/api/extract` route handler to existing stub
- [ ] `src/ee/extract-session.test.ts` — unit test stubs for extractSession(), buildExtractTranscript(), threshold check
- [ ] `src/orchestrator/cleanup.test.ts` — integration test stub for Agent.cleanup() with extract

*Existing vitest infrastructure covers all framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SIGINT extraction fires | EXTRACT-01 | Requires real signal delivery | Run CLI, Ctrl+C, check EE logs |
| Shutdown < 2s with slow EE | EXTRACT-03 | Requires real timing measurement | Run CLI with latency stub, time exit |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
