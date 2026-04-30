---
phase: 3
slug: polish-headless-cross-platform-beta
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-30
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `bunx vitest run --reporter=dot` |
| **Full suite command** | `bunx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `bunx vitest run --reporter=dot`
- **After every plan wave:** Run `bunx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | CORE-01 | integration | `bunx vitest run tests/integration/headless-golden.test.ts` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | CORE-02 | integration | `bunx vitest run src/mcp/smoke.test.ts` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 1 | CORE-03 | integration | `bunx vitest run src/lsp/smoke.test.ts` | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 1 | CORE-07 | unit | `bunx vitest run src/utils/permission-mode.test.ts` | ❌ W0 | ⬜ pending |
| 03-04-01 | 04 | 2 | OPS-01 | unit | `bunx vitest run src/ops/doctor.test.ts` | ❌ W0 | ⬜ pending |
| 03-04-02 | 04 | 2 | OPS-02 | unit | `bunx vitest run src/ops/bug-report.test.ts` | ❌ W0 | ⬜ pending |
| 03-05-01 | 05 | 2 | CORE-05 | CI | `.github/workflows/ci-matrix.yml` | ❌ W0 | ⬜ pending |
| 03-05-02 | 05 | 2 | CORE-06 | CI | `.github/workflows/release-binary.yml` | ❌ W0 | ⬜ pending |
| 03-06-01 | 06 | 3 | OPS-03 | manual | `ls .github/ISSUE_TEMPLATE/` | ❌ W0 | ⬜ pending |
| 03-06-02 | 06 | 3 | OPS-04 | manual | `test -f STATUS.md` | ❌ W0 | ⬜ pending |
| 03-03-02 | 03 | 1 | CORE-04 | arch | `bunx vitest run tests/arch/` | ✅ (indirect) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/headless-golden.test.ts` — stubs for CORE-01
- [ ] `src/mcp/smoke.test.ts` — stubs for CORE-02
- [ ] `src/lsp/smoke.test.ts` — stubs for CORE-03
- [ ] `src/utils/permission-mode.test.ts` — stubs for CORE-07
- [ ] `src/ops/doctor.test.ts` — stubs for OPS-01
- [ ] `src/ops/bug-report.test.ts` — stubs for OPS-02

*Existing infrastructure covers CORE-04 (arch tests exist), CORE-05/06 (CI yaml, no test stubs needed), OPS-03/04 (manual verification).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Issue templates render correctly on GitHub | OPS-03 | Requires GitHub UI rendering | Push `.github/ISSUE_TEMPLATE/` files, open "New Issue" on GitHub, verify templates appear |
| STATUS.md content is accurate | OPS-04 | Content review | Read STATUS.md, verify known issues list and beta enrollment instructions match reality |
| Binary runs on target OS | CORE-06 | Cross-platform execution | Download binary from GitHub Releases on each OS, run `muonroi-cli --version` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
