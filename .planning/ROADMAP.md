# Roadmap — muonroi-cli

## Phase 4: Scope Discipline for Cheap Models

**Goal:** Drive DeepSeek V4 Flash (and other fast-tier cheap models) through the muonroi-cli so they emit zero tokens on scope-wandering while preserving output quality. Measured against 5 baseline sessions captured 2026-05-23.

**Requirements addressed:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007

**Success criteria:**
- 5-prompt baseline re-run with Phase 4 ON achieves G1-Cost ≤$0.30, G1-Tools ≤120, G2-PIL 5/5, G3-Cache ≥15%, G4-Repeat 0, G5-Outcome ≥4/5
- All Phase 4 components verified by harness E2E spec (`tests/harness/scope-adherence-tui.spec.ts`)
- No regression on existing harness suite (`bunx vitest -c vitest.harness.config.ts run tests/harness/`)
- No regression on unit suite (`bunx vitest run`)

**Scope inclusions (7 components):**

1. **4P-1** — Fix `tree-sitter:typescript`/`python` → `refactor` mapping (`layer1-intent.ts:166-167`). Targets REQ-001.
2. **4P-2** — Tune LLM bridge classifier system prompt to remove refactor bias. Targets REQ-001, REQ-006.
3. **4C** — Layer 1.5 deterministic complexity-size classifier. Targets REQ-003.
4. **4B** — Per-session × per-task-type step ceiling + forced-finalize on ceiling hit. Targets REQ-004.
5. **4A** — Scope reminder injection every K steps + soft-warn at 70%. Targets REQ-005.
6. **4R** — Session-scoped bash canonical-repeat detector (lift state from per-turn closure). Targets REQ-002.
7. **4V** — Harness E2E spec `scope-adherence-tui.spec.ts` verifying all components. Targets REQ-007.

**Scope exclusions (deferred to later phases):**
- File-scope quarantine (Aider-style edit gating) — deferred to Phase 4.2 / Phase 5
- EE `IRRELEVANT` 100% noise reduction — flag for EE team, not in Phase 4
- Capability-scoped subagents per role — Phase 5+

**Implementation order:**
- Wave 1 (parallel-safe): 4P-1, 4C, 4R
- Wave 2 (depends on 4C): 4B, 4A
- Wave 3 (depends on Waves 1+2): 4P-2, 4V

**Estimated LOC:** ~415 production + ~100 test = ~515 total. Estimated wall time: 4-5 working days.

**Verification protocol:**
1. Each component lands with unit/integration tests
2. After all 7 land: run `bunx tsc --noEmit` (0 errors), `bunx vitest run` (no regressions), `bunx vitest -c vitest.harness.config.ts run tests/harness/` (all pass including new scope spec)
3. User re-runs 5 baseline prompts on real DeepSeek; agent pulls telemetry from `~/.muonroi-cli/muonroi.db` and verifies G1-G5
