# DECISIONS.md — muonroi-cli

> Locked architectural decisions. Append-only — never delete an entry; supersede with a new one referencing the old.
>
> Companion to `IDEA.md` (vision) and `.planning/PROJECT.md` (living context). Decisions here are binding for all phases unless explicitly revised.

---

## D-001 — License model for muonroi-cli's own code

**Date:** 2026-04-29
**Status:** Locked
**Context:** Phase 0 needs a license decision before first public commit. `LICENSE-grok-cli` (MIT, Vibe Kit) is preserved separately — this decision covers our own code only.
**Decision:** **MIT.**
**Rationale:**
- Matches grok-cli's existing license — minimizes legal complexity at fork point.
- Solo maintainer cannot afford AGPL compliance review for downstream commercial users.
- Source-available / commercial-source models add overhead with no clear ROI for v1 beta.
- Subscription pricing protects the product economically without copyleft enforcement.
**Consequences:**
- Anyone can fork, use, redistribute. We accept this tradeoff.
- Re-evaluate at Phase 4 launch if competitive cloning becomes a real risk.

---

## D-002 — Storage path naming

**Date:** 2026-04-29
**Status:** Locked
**Context:** grok-cli uses `~/.grok/` for sessions, transcripts, configs. The fork must rename. Two candidates: `~/.muonroi-cli/` (specific) vs `~/.muonroi/` (shared root with future Muonroi products).
**Decision:** **`~/.muonroi-cli/`.**
**Rationale:**
- Clear product boundary — if a future Muonroi product (web dashboard, daemon, etc.) ships, it gets its own dir without colliding.
- Easier to inspect / nuke / migrate without affecting unrelated state.
- No ambiguity in bug-reports about "which Muonroi tool wrote this file".
**Consequences:**
- All FORK-03 references update to `~/.muonroi-cli/`.
- Existing `~/.grok/` sessions are NOT migrated (clean break — already locked in REQUIREMENTS FORK-03).
- If we ever ship a second Muonroi tool, it adopts a sibling dir like `~/.muonroi-web/` — no consolidation back to `~/.muonroi/`.

---

## D-003 — Bun version pin

**Date:** 2026-04-29
**Status:** Locked
**Context:** Stack research recommends Bun 1.3.13 (released 2026-04-20, post the v1.3.5 Windows segfault era). Pitfalls research flags Bun-on-Windows ABI mismatches as the largest cross-platform risk. Day-1 Windows smoke test in FORK-08 validates the pin against the actual dev box.
**Decision:** **`engines.bun >= 1.3.13`** in `package.json`.
**Rationale:**
- 1.3.13 is post the known v1.3.5 Windows segfault history.
- Open-ended `>=` allows patch upgrades to land via `bun outdated` weekly job (FORK-05) without churning the pin.
- Dev box is Windows 11 Enterprise — same target as primary user base.
**Consequences:**
- FORK-08 day-1 smoke is the gate. If 1.3.13 fails on Windows 11, defer Phase 1 until resolved (do not bump to 1.3.14 without re-validation).
- `UPSTREAM_DEPS.md` lists Bun release feed — every minor bump triggers re-smoke before adopting.
- Native modules (sqlite, node-pty if used) must be tested against the pinned Bun, not assumed working from grok-cli.

---

## D-004 — Phase 0 sizing override

**Date:** 2026-04-29
**Status:** Locked
**Context:** IDEA.md proposed Phase 0 = 1 week. Research synthesizer mapped 5 HIGH-severity pitfalls (untracked upstream, key leakage, cap race, abort dangling state, license drift) plus 6 architecture deliverables to Phase 0. Sizing the work honestly requires more than 1 week.
**Decision:** **Phase 0 = 1.5–2 weeks. Phase 3 compressed to 7–8 (was 6–8) to absorb the slip.**
**Rationale:**
- Cannot defer key safety primitives, reservation ledger skeleton, EE HTTP client, abort handling, license preservation. Each is a Phase 1 blocker if missing.
- Phase 3 is mostly validation + CI matrix work — parallel-friendly and tolerates compression.
- Total v1 timeline (Phases 0–3) stays at 8 weeks. Phase 4 timing unchanged (9–12).
**Consequences:**
- ROADMAP.md Phase 0 estimate is "weeks 1–2", Phase 3 is "weeks 7–8".
- If Phase 0 slips beyond 2 weeks, escalate before consuming Phase 1 buffer.

---

## D-005 — Auto-judge feedback loop in Phase 1

**Date:** 2026-04-29
**Status:** Locked
**Context:** EE-09 (auto-judge feedback loop) is the fifth differentiator alongside router / principles / cap / compaction. Question: Phase 1 (early — EE evolves faster) or Phase 2 (lighter Phase 1, leverages `.muonroi-flow/` for outcome history).
**Decision:** **Phase 1.**
**Rationale:**
- EE evolution speed is the core value prop ("memory shrinks while capability grows"). Delaying auto-judge means principles take longer to stabilize.
- Outcome data (tool exit code, error class, simple diff) does not require `.muonroi-flow/` — it can live in process state and EE's existing principle storage.
- Phase 2's `.muonroi-flow/` adds richer outcome context (test results, run-level decisions) but the basic loop works without it.
**Consequences:**
- Phase 1 carries 27 REQs — tight but feasible per the maintainer's confirmation.
- Phase 2 enriches the loop with `.muonroi-flow/` outcome data (no new REQ needed; FLOW-12 already covers hook-derived warning persistence).

---

## D-006 — Multi-provider scope in Phase 1

**Date:** 2026-04-29
**Status:** Locked
**Context:** PROV-01 lists 5 providers (Anthropic, OpenAI, Gemini, DeepSeek, Ollama) all in Phase 1. Solo maintainer in 2 weeks (weeks 3–4). Question: ship all 5 in Phase 1 vs split (3 in Phase 1, 2 in Phase 2).
**Decision:** **Ship all 5 in Phase 1.**
**Rationale:**
- BYOK marketing claim requires 5-provider parity from beta day 1. Splitting weakens the pitch.
- AI SDK v6 abstraction means providers share most surface — incremental cost per provider is mostly the integration test matrix.
- `@ai-sdk/openai-compatible` covers DeepSeek + SiliconFlow with one adapter, reducing real adapter count to 4.
**Consequences:**
- Phase 1 sizing is tight. If integration test matrix surfaces real divergence (provider API quirks), defer the cheapest provider's polish to Phase 2 — but never ship beta without all 5 wired.
- Provider-specific quirks (parallel tool calls, streaming chunk shape) are surfaced in Phase 1 integration test suite, fixed in same phase.

---

## Decision Log Conventions

- **D-XXX**: Sequential identifier, never reused.
- **Status**: `Proposed` (under review) → `Locked` (binding) → `Superseded by D-YYY` (replaced).
- **Append-only**: Never delete or rewrite a Locked decision. To change one, mark it Superseded and add a new entry.
- **Where decisions live**:
  - This file: architectural / cross-phase decisions
  - `.planning/PROJECT.md` Key Decisions table: project-level decisions (overlaps OK)
  - PR descriptions: code-level decisions tied to a single change
- **When to add an entry**: Any decision that future-you will be tempted to revisit. If you would not want to re-debate it in 3 months, lock it here.
