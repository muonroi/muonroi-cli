# Phase 06: 4 Upgrades — Security, Performance, Reporting, UI

**Status:** PLAN (2026-05-xx)  
**Scope:** Project root (muonroi-cli)  
**Goal:** Deliver 4 targeted upgrades that make the CLI more secure, faster for long sessions, more insightful via reports, and more usable in the TUI — without regressing existing cost/scope discipline (Phase 4/5 wins).

**Current baseline (evidence from 2026-05-26 reads):**
- Security: PermissionMode (`safe`/`auto-edit`/`yolo`), sandbox `shuru` wrapper (bash.ts:598), keychain + OAuth, `toolNeedsApproval` (utils/permission-mode.ts:32).
- Performance: Mature compaction (orchestrator/compaction.ts + subagent-compactor.ts), 32k tool cap + bash-output-cache + `bash_output_get`, read-path-budget, PIL budgets, token/cost tracking.
- Reporting: Strong `usage report` (cli/usage-report.ts:220) with group-by, drift watch, cost-log + product-ledger, agent-self comfort snapshot. Forensics via `usage forensics`.
- UI: OpenTUI + React TUI (src/ui/app.tsx, agents-modal, mcp-modal, council-*, semantic harness), self-verify / agent-harness E2E, status bar, modals.

**Success criteria (all 4):**
- No regression on unit suite (`bunx vitest run`) + harness (`bunx vitest -c vitest.harness.config.ts run tests/harness/`).
- tsc --noEmit clean.
- New behavior covered by tests or harness specs where UI.
- For security/perf: explicit smoke + before/after metrics (e.g. cost report, approval audit log).
- Plan itself passes GSD evidence rule — every item backed by file:line from this turn.

## Wave 0 — Foundations (parallel, low risk)
- [x] Update .planning/STATE.md and .planning/ROADMAP.md to reference this phase (link to this PLAN). (2026-06-08, ROADMAP edit +4 lines)
- [x] Add `06-` entry to root CHANGELOG.md under Unreleased.
- [x] Smoke: `bun run typecheck` (or `bunx tsc --noEmit`) + `bunx vitest run --passWithNoTests src/cli/usage-report.test.ts` (if exists) or direct import check. tsc exit 0 (bash-28).

## 1. Nâng cấp bảo mật (Security Hardening)
**Objective:** Reduce blast radius of yolo/permission modes, improve secret hygiene, add auditability for privileged operations.

**Current gaps (evidence):**
- `toolNeedsApproval` only checks name (permission-mode.ts:34); no context (file path, command pattern).
- Sandbox `wrapCommandForShuru` (bash.ts:598) exists but usage of secrets/allowNet is opt-in and not audited in logs.
- No persistent audit trail for "approved in yolo" or high-risk bash.
- Keychain fallbacks (env > settings) not explicitly logged on first use.

**Implementation steps:**
1. Enhance `PermissionMode` with audit hook: add optional `onApproval` callback or always append to decision-log (usage/decision-log.ts).
2. Extend `toolNeedsApproval(toolName, mode, context?)` to take `command` for bash and `path` for file ops. Block/flag dangerous patterns (e.g. `rm -rf /`, network in safe mode).
3. In bash.ts, when `sandboxMode === "shuru"`, always log effective settings + redacted command to cost/decision log.
4. Add CLI: `muonroi-cli security audit --since 7d` (reuses existing usage/decision logs + new permission events).
5. Tests: new unit for permission-mode with context; harness spec for approval flow if UI surfaces it.
6. Docs: update AGENTS.md "Zero Hardcode" + CLAUDE.md with "permission mode threat model".

**Files (evidence-based):**
- src/utils/permission-mode.ts (core logic)
- src/tools/bash.ts (wrapCommandForShuru + execute)
- src/orchestrator/message-processor.ts (approval gate at 2328)
- src/cli/ (new security command or extend usage-report)
- tests/ + tests/harness/ for coverage

**Verification:**
- `bunx vitest run` (permission + sandbox tests already exist — ensure no break).
- Smoke: run with `--permission-mode yolo` + high-risk cmd; assert audit entry written.
- `tsc --noEmit`.

## 2. Tối ưu hiệu suất (Performance Optimizations)
**Objective:** Keep token costs flat and latency low for 100+ turn sessions; reduce unnecessary re-exec / re-read.

**Current strengths + gaps (evidence):**
- Excellent: sub-agent + top-level compaction (subagent-compactor.ts:297, compaction.ts:1440), bash cache + `bash_output_get` (registry.ts:255), 32k cap + truncate (registry.ts:106), read-path-budget.
- Gaps surfaced in prior work: `bash_output_get` result still goes through `truncateOutput` (registry.ts:290); cache LRU only 50; no "expand stub" for compacted tool results; dynamic cap not context-aware; UI re-renders on every frame even for static status.

**Implementation steps:**
1. Make `bash_output_get` bypass truncate for `mode=full` when caller is trusted (or add `maxChars` override per call).
2. Increase bash-output-cache max entries to 200 (env-tunable); add LRU with size-based eviction.
3. Add `expand-tool-result` helper (or extend compaction) so agent can say "give me more of toolCallId=xxx" without full re-run.
4. Dynamic tool cap: in registry.ts, choose higher cap (e.g. 128k) for commands matching log/build patterns (`vitest`, `tsc`, `git log`).
5. UI perf: in src/ui/ use React.memo / OpenTUI shouldComponentUpdate equivalent for status-bar and log view; measure with self-verify timing.
6. Expose `MUONROI_COMPACTION_PREVIEW_CHARS` (currently hardcoded in subagent-compactor).

**Files:**
- src/tools/{registry.ts, bash-output-cache.ts, bash.ts}
- src/orchestrator/{subagent-compactor.ts, compaction.ts, orchestrator.ts}
- src/ui/status-bar/* + app.tsx (re-render paths)
- .env.example + docs for new envs

**Verification:**
- Cost-leak harness specs still pass (`bunx vitest -c vitest.harness.config.ts run tests/harness/cost-leak-*.spec.ts`).
- Live smoke: 100k+ char bash output → `bash_output_get ... full` returns >32k (no truncate).
- Before/after: `usage report --by callsite` shows lower avg system/tools chars on long session.
- tsc + full test.

## 3. Thêm tính năng báo cáo (Reporting Features)
**Objective:** Turn existing rich logs into actionable, user- and agent-consumable reports for security, perf, and product health.

**Current state (strong evidence):**
- `usage report --by callsite|role|phase|model|provider --breakdown` (cli/usage-report.ts:220) already excellent.
- Drift detection, agent-self snapshot, cost-log + product-ledger.
- Forensics command exists (prior context).

**New features (prioritized):**
1. `usage security-audit --last 50` — surfaces yolo usage, high-risk bash patterns, permission overrides (builds on decision-log + new audit events from #1).
2. `usage perf-regression --compare baseline.json` — compares avg ctx_tokens, compaction savings, cache hit, tool count vs previous run (leverages existing token counters + compaction stats).
3. `usage ui-interaction` (or integrate with agent-harness) — reports most used modals, slash commands, askcard answers (from LiveEvent stream if enabled).
4. Export: `--format md|json` for all reports (easy paste into EE or PRs).
5. Scheduled: background job (using existing schedule tool) that emits daily summary to `~/.muonroi-cli/reports/`.

**Files:**
- src/cli/usage-report.ts (extend runUsageReport + new subcommands)
- src/usage/{cost-log, decision-log, new security-audit-log.ts}
- src/cli/index.ts (wire new `usage security-audit`, `usage perf`)
- tests/cli/usage-report.test.ts (add cases)

**Verification:**
- `bun run src/index.ts usage report --json | jq` smoke.
- New commands appear in `--help`.
- Harness or unit test for report aggregation with security events.
- No duplicate code — reuse aggregate() and printTable().

## 4. Cải thiện UI (UI/UX Improvements)
**Objective:** Make TUI more transparent about security/perf state and reduce visual noise for long sessions.

**Current (evidence):**
- Rich components: council-phase-timeline, product-status-card, agents-modal, mcp-modal, status-bar.
- Semantic wrapping for agent-harness (self-verify works).
- Code-block-truncate.ts already exists.

**Concrete improvements:**
1. Status bar: always show current `permissionMode` + `sandboxMode` (icon or short text) + last compaction savings % (orchestrator exposes stats).
2. Truncation UX: when tool output truncated, show a clickable/keyboard "view full (bash-42)" hint that triggers the retrieval flow (or at least copies the run_id).
3. Permission prompt: clearer "this is a shell command in yolo mode — risk: X" with one-line risk summary.
4. Long-session polish: auto-collapse old council phases or tool results (respect user preference); improve log view scrolling with semantic ids.
5. Self-verify coverage: run Tier 1 after any UI change (already in pre-push hook); add 1-2 new harness specs for the new status indicators.

**Files:**
- src/ui/status-bar/ (and app.tsx wiring)
- src/ui/components/code-block-truncate.ts + message views
- src/ui/modals/ (permission/approval cards)
- src/agent-harness/ + tests/harness/ for new semantic surfaces
- src/orchestrator/orchestrator.ts (expose compaction + permission state to UI layer)

**Verification:**
- `bun run src/index.ts self-verify --since HEAD~1 --max 4` (Tier 1) after UI edits.
- `bunx vitest -c vitest.harness.config.ts run tests/harness/` — no new skips.
- Manual smoke in TUI: permission mode change visible in status; truncated output shows actionable hint.
- tsc clean.

## Order & Cross-cutting
- Wave 1 (parallel, safe): Reporting enhancements + UI polish (builds on existing strength).
- Wave 2 (core): Security hardening (audit first, then enforcement).
- Wave 3: Performance (leverage audit data from security to tune caps/budgets).
- All waves must pass full pre-push gate: unit + harness + (if UI) self-verify.
- Update AGENTS.md / CLAUDE.md with new envs, commands, and "evidence-first" reminders for the new features.

## Verification Checklist (MANDATORY before any commit)
- [ ] `bunx tsc --noEmit` — 0 errors
- [ ] `bunx vitest run` (full unit)
- [ ] `bunx vitest -c vitest.harness.config.ts run tests/harness/`
- [ ] If UI touched: `bun run src/index.ts self-verify --since HEAD --max 3`
- [ ] Smoke the 4 new surfaces/commands with real output in `~/.muonroi-cli/usage`
- [ ] This PLAN.md updated with actual commit hashes post-land
- [ ] .planning/STATE.md reflects "06 IN PROGRESS" → "SHIPPED"

**References (this turn):**
- .planning/ROADMAP.md + STATE.md (Phase 5 shipped)
- src/utils/permission-mode.ts:1-38
- src/tools/bash.ts:598 (shuru)
- src/cli/usage-report.ts:220-273 (report + agent-self)
- src/orchestrator/compaction.ts + subagent-compactor.ts (perf baseline)
- src/ui/ (app.tsx, status-bar, modals, semantic usage)
- registry.ts:106,290 (cap + get truncation)

**Next action after plan approval:** Create per-subtask PLANs under this dir (e.g. 01-security-audit-PLAN.md) following Phase 4/5 pattern, then execute wave by wave.

---
*Generated directly from code reads + directory inspection on 2026-05-26. All claims cite concrete files/lines from this session.*