---
phase: 01
slug: brain-cap-chain
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-29
---

# Phase 01 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest@4.1.5 (locked Phase 0 D-007) |
| **Config file** | vitest.config.ts |
| **Quick run command** | `bunx vitest run --reporter=dot` |
| **Full suite command** | `bunx vitest run` |
| **Estimated runtime** | ~30s for unit; ~90s with perf bench harness |

---

## Sampling Rate

- **After every task commit:** Run `bunx vitest run --reporter=dot` against the touched file's nearest test
- **After every plan wave:** Run `bunx vitest run` (full suite)
- **Before `/gsd:verify-work`:** Full suite must be green; perf-guard must report p95 ≤ 25ms
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

Filled by gsd-planner once tasks are sliced. Each plan must populate the rows for its tasks.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| (TBD) | 01–08 | TBD | REQ-* | unit/integration/e2e/perf | `{command}` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `bun add tree-sitter-typescript tree-sitter-python` — grammar packages for Plan 02 classifier
- [ ] `bun add proper-lockfile` — file-lock dep for Plan 04 ledger (pending Bun-Windows compat spike)
- [ ] Bun version bump to ≥1.3.13 on dev box (D-003); update `engines.bun` if relaxed
- [ ] `tests/fixtures/providers/{anthropic,openai,gemini,deepseek,ollama}/` directories with recorded JSONL streams
- [ ] `tests/perf/pretooluse.bench.ts` harness scaffolding for EE-08 p95 ≤ 25ms guard
- [ ] `tests/runaway/` harness for USAGE-07 (infinite loop, large file, model thrash, parallel burst)
- [ ] EE endpoint contract stubs in `tests/fixtures/ee/` for `/api/intercept`, `/api/posttool`, `/api/feedback`, `/api/route-model`, `/api/cold-route`, `/api/principle/touch`
- [ ] `vitest.config.ts` arch test wired for Plan 02 ROUTE-01 network-free classifier guard

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| OpenTUI status bar renders model + tier badge + tokens + USD | TUI-05 | Terminal rendering not asserted in vitest | `bun run dev`, observe slot order and color (hot=green/warm=cyan/cold=magenta/degraded=yellow blink); kill stream mid-flight, confirm tokens freeze |
| `/route` slash command prints decision + reason | ROUTE-05 | Slash UI flow needs interactive shell | Run prompt, then `/route`, verify output shows tier + reason + cap-driven note when applicable |
| 50%/80%/100% threshold UX | USAGE-02 | Real-time UX flow | Set cap=$0.10, run prompts to drive `current_usd` past thresholds, observe banner / toast / halt + downgrade announcement |
| Live-smoke per provider with real API keys | PROV-01/04 | Costs token credits; gated by env-var keys | Per provider: `ANTHROPIC_API_KEY=... bunx vitest run tests/live/anthropic.live.test.ts` (and equivalents) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (grammar packages, lockfile dep, perf harness, runaway harness, fixtures)
- [ ] No watch-mode flags (`--watch`) in any task command
- [ ] Feedback latency < 30s
- [ ] PreToolUse perf-guard p95 ≤ 25ms passing in CI
- [ ] ROUTE-01 arch test fails CI on any network import in `src/router/classifier/**`
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
