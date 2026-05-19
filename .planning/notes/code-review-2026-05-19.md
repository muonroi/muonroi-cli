# Code Review Findings — 2026-05-19

Cross-cutting review of muonroi-cli. 5 prioritised recommendations.

## Recommendations

1. **Audit 16 skipped/todo harness tests** — Phase 20.
2. **Upgrade cross-turn dedup hash sha1-12 → sha256-16** — Phase 22 (Rec #2).
3. **EE timeout observability + re-tune `PIL_SEARCH_TIMEOUT_MS`** — Phase 21.
4. **Monthly TODO/FIXME triage process** — Non-code process change (see below).
5. **Deprecation warning on `src/agent-harness/` shim** — Phase 22 (Rec #5).

## Rec #4 — Monthly TODO/FIXME Triage (process, no phase)

There are ~45 unresolved TODO/FIXME comments concentrated in `src/orchestrator/`, `src/pil/`, and `src/scaffold/`. They are not separated by priority, so a future agent cannot tell which are release-blockers vs. nice-to-have.

**Action:**
- First Monday of each month, owner runs `rg "TODO|FIXME" src/ -n` and categorises into HIGH/MEDIUM/LOW.
- HIGH items get a phase or quick task; MEDIUM enters backlog; LOW stays in code with a `// LOW:` prefix.
- Track the audit log in `.planning/notes/todo-triage-log.md` (append-only).

No code change required for this rec — process only. Re-evaluate if the count keeps climbing instead of falling after two cycles.

## Review Verdict

Codebase maturity ~75%. Security architecture, cost-leak mitigations, and provider abstraction are strong. Test coverage looks better than it is, EE failure modes are silent, and small tech-debt items are compounding. 2-3 weeks of hardening (Phases 20-22) brings it to production-ready.
