---
phase: 4
slug: cloud-billing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-30
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | CLOUD-01 | integration | `npx vitest run src/cloud/__tests__/tenant-isolation.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | CLOUD-02 | integration | `npx vitest run src/cloud/__tests__/migration.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BILL-01 | unit | `npx vitest run src/billing/__tests__/webhook.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BILL-02 | unit | `npx vitest run src/billing/__tests__/tiers.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | WEB-01 | e2e | `npx vitest run src/dashboard/__tests__/dashboard.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Test stubs for cloud tenant isolation (CLOUD-01)
- [ ] Test stubs for migration flow (CLOUD-02)
- [ ] Test stubs for webhook idempotency (BILL-01)
- [ ] Test stubs for tier management (BILL-02)
- [ ] Test stubs for dashboard API (WEB-01)

*Exact file paths will be refined by the planner.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Cross-tenant query pen-test | CLOUD-01 | Requires live Qdrant with two tenant collections | Create 2 tenants, insert principles, attempt cross-query with wrong tenant JWT |
| LemonSqueezy checkout flow | BILL-01 | Requires real browser + LemonSqueezy test mode | Open checkout URL, complete payment with test card, verify webhook fires |
| Dashboard visual rendering | WEB-01 | Visual verification of React SPA | Open dashboard URL, verify principles list + usage chart render correctly |
| Migration resumability | CLOUD-02 | Requires simulated network interruption | Start migration, kill process mid-sync, restart — verify resume from last checkpoint |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
