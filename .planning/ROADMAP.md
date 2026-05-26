# Roadmap — muonroi-cli

## Phase 5: Post-Phase-4 Cleanup + UX Bugs — 🟡 OPEN (2026-05-25)

**Goal:** Close 4 deferred/new items surfaced by Phase 4 closure: PIL discovery
fix (F4), EE noise reduction (F5), agent halt bug (F6, NEW — highest priority),
TUI collapse UX (F7, NEW). See `.planning/phases/05-post-phase4-cleanup-and-ux/05-CONTEXT.md`.

**Highest priority:** F6 — across all 5 Phase-4-verification sessions, agent
emits only partial intro then stops. User must type "tiếp tục" to get the
actual answer. Directly contradicts the kim chỉ nam (zero wasted tokens).

Implementation order:
- Wave 1 (parallel): F4 (~1-2h), F5 (~30min), F7 (~30min)
- Wave 2: F6 — needs root-cause investigation (stopWhen telemetry + 5-baseline
  re-run with instrumentation)

---

## Phase 4: Scope Discipline for Cheap Models — ✅ COMPLETE (2026-05-25)

**Final verification (5-prompt baseline re-run with all fixes deployed):**

| Goal | Target | Actual | Status |
|---|---|---|---|
| G1-Cost | ≤ $0.30 | $0.0800 | ✅ |
| G1-Tools | ≤ 120 | 51 | ✅ |
| G2-PIL classification | 5/5 correct | 5/5 (analyze, generate, analyze, analyze, generate) | ✅ |
| G3-Cache hit ratio | ≥ 15% | 82.7% | ✅ |
| G4-Bash repeats | 0 canonical | 0 (4R detector fired correctly) | ✅ |
| G5-Outcome quality | ≥ 4/5 senior | 4-5/5 (session 5 minor: didn't measure coverage delta) | ✅ |

Verification session IDs (telemetry in `~/.muonroi-cli/muonroi.db`):
`348b4006e74c`, `5b7935e07f37`, `f904feb2971d`, `91b134d50c77`, `9f55731759a0`

Post-Phase-4 cleanup commits (2026-05-25):
- `e2d5c6f` test(04-01): tree-sitter mapping tests aligned with Phase 4 mapping
- `a908a0b` fix(04): resolve TS errors blocking clean tsc --noEmit
- `e4e3f2e` fix(04-06): tighten bridge classifier negative examples (4P-2)
- `945d3e2` fix(04): edit_file read-first hint + sub-agent compactor string marker

Deferred to Phase 5 (see "Scope exclusions" below + new findings):
- F4: PIL discovery module-suggestion incorrect (suggests non-existent folders)
- F5: EE IRRELEVANT 100% logging noise
- G5 weakness: "improve coverage" prompts don't auto-measure coverage delta

---

## Phase 4 (original spec)

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
