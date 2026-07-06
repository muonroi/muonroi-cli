# Project State — muonroi-cli

**Last updated:** 2026-05-25 (Phase 5 SHIPPED — all 5 fixes deployed, awaiting user verify)

**Phase 5 status: 🟢 SHIPPED.** All 5 fixes landed:

**Phase 06 (planning):** 4 upgrades (Security, Performance, Reporting, UI) — PLAN created at `.planning/phases/06-4-upgrades-security-perf-report-ui/PLAN.md`. Wave 0 foundations pending. See that PLAN for objectives, evidence-based gaps, verification gates.
- F4 (commit `f5640c4`): scope module-suggestions ranked by mtime, not alpha
- F5 (commit `f5640c4`): EE judge writes gated behind hadWarnings — ~95% noise cut
- F6 (commit `8b186a6`): auto-forcedFinalize when stream ends without text — "tiếp tục" bug eliminated
- F7 (commit `f5640c4`): final assistant message no longer auto-collapses
- F8 (commit `f5640c4`): askcard pickBestOutcomeIndex — context-aware Recommended badge

Tests green: tsc 0 errors, pil/hooks 398/398, orchestrator 132/132.

Awaiting user re-run of 5-baseline to confirm: G1-G5 still pass + no "tiếp
tục" needed + askcard recommends best option + ee_judge noise dropped.

**Phase 4 status: ✅ COMPLETE.** Final 5-baseline re-run (sessions `348b4006e74c`, `5b7935e07f37`, `f904feb2971d`, `91b134d50c77`, `9f55731759a0`):
- G1-Cost $0.0800 ≤ $0.30 ✅
- G1-Tools 51 ≤ 120 ✅
- G2-PIL 5/5 ✅ (sessions 2 & 5 now `generate` — was `refactor` pre-fix)
- G3-Cache 82.7% ≥ 15% ✅
- G4-Bash repeat detector fired correctly ✅
- G5-Outcome 4-5/5 senior ✅

Post-Phase-4 cleanup wave (commits `e2d5c6f`, `a908a0b`, `e4e3f2e`, `945d3e2`):
- F1: 3 PIL unit tests aligned with new tree-sitter mapping
- F2: TS errors fixed (transcript-emit, HaltChunk, budgetTokens)
- F3a: bridge classifier tightened with negative examples
- F3b: sub-agent compactor uses string marker (no more `{_elided:true}` hallucination)
- F3c: edit_file description has explicit read-first MANDATORY hint

Deferred to Phase 5:
- F4: PIL discovery module-suggestion (suggests non-existent folders)
- F5: EE 100% IRRELEVANT logging noise
- G5 minor: "improve coverage" prompts don't auto-measure coverage delta

**Last completed plan:** Phase 4, Plan 07 (4V harness E2E) — commits `6d16695` (fixture), `342f576` (spec). New `tests/harness/scope-adherence-tui.spec.ts` covers all 5 REQ-007 assertion categories: reminder injection cadence (live spawn), soft-warn at floor(ceiling × 0.7), hard halt + forced-finalize toast, `--budget-rounds 20` override, and `complexitySize` observability. 5/5 tests green via `bunx vitest -c vitest.harness.config.ts run tests/harness/scope-adherence-tui.spec.ts`. REQ-007 satisfied.

**Previously completed:**
- Plan 06 (4P-2 bridge classifier) — commits `d1fafad`, `0fa4550`. Legacy bridge classifier system prompt rewritten with neutral category order (analyze first), explicit refactor restriction, prefer-general-when-ambiguous rule, and feature-add clarification. REQ-006 satisfied; REQ-001 fully closed.
- Plan 05 (4A scope reminder) — commits `563ab24`, `68b4113`, `a57b2e4` (+ message-processor wiring landed via `3178239`). Reminder cadence K=3/5/8 + soft-warn at floor(ceiling × 0.7). REQ-005 satisfied.
- Plan 04 (4B ceiling + forced-finalize) — commits `4e7ad66`, `96cfd46`, `3178239`. Per-session step ceiling matrix + `--budget-rounds N` parse. REQ-004 satisfied.
- Plan 02 (4C complexity-size) — commits `f37f45f`, `ec4e4a0`. Deterministic Layer 1.5 classifier wired into PIL pipeline; `ctx.complexitySize` populated for downstream 4B/4A consumption. REQ-003 satisfied.
- Plan 03 (4R session-bash-repeat) — commit `b04ef51`. Session-scoped bash canonical-repeat detector. REQ-002 satisfied.
- Plan 01 (4P-1 tree-sitter fix) — commit `bc07709`. Tree-sitter:* reasons no longer bias taskType=refactor. REQ-001 partially satisfied (closed by Plan 06).

## What this repo is

muonroi-cli: an interactive agentic CLI built around the Experience Engine (EE) as a native shell. Targets "rough gemstone → senior output" — drive cheap LLMs (DeepSeek V4 Flash) to senior-quality output via structural CLI steering, not by upgrading models.

## Active focus

**Phase 4: Scope Discipline for Cheap Models** — kim chỉ nam: zero wasted tokens on scope wandering. Quality per emitted token must stay ≥ current.

## Recent context (pre-Phase 4)

- **Phase 1-3 DONE (commits up to 139c074)**: tier-aware cheap-model playbook injected at top of system prompt (Bước 3-2), always-on `bash_run_id` footer (Bước 3-1), inline canonical-repeat reminder for bash (Bước 3-3). PIL all 6 layers implemented. Rebrand complete (zero GROK_).
- **Baseline measured 2026-05-23**: 5 prompts run on DeepSeek V4 Flash with playbook ON. Sessions: `33c09e970d30`, `a4c4bddc5ad9`, `bf1afff343a9`, `77cd2e11c6a5`, `3485a0934def`. Findings: PIL refactor bias (4/5 misclassified), wandered sessions 4 & 5 hit 371 and 259 tool calls, cache adoption 0.4-3.8%, bash repeat detector failed on 9× identical command.
- **Root causes identified** (RC1-RC4) — see Phase 4 RESEARCH.

## Decisions locked

- **No vendor lock-in**: `/ideal` must not push .NET/BB defaults. Greenfield = neutral, existing repo = explore first.
- **CLI architecture vision**: built AROUND EE as native shell, not addon.
- **Zero hardcode rule**: model/provider IDs derived from `catalog.json` + user settings + runtime detection; never string literals in production code.
- **Bulk ops via Colab not agent**: prefer sandboxed LLM emitting reviewable JSONL over agent-tool writes for >50 record ops.

## Out of scope for Phase 4

- P3 monetization (cloud billing, multi-tenant, Stripe)
- EE seeding (done in `experience-engine` repo, batch `2026-05-11-bb-full`)
- BB-aware /ideal (already done — `src/ee/bb-retrieval.ts`, `src/scaffold/bb-*`)

## Key files

| Area | File |
|---|---|
| PIL Layer 1 (intent) | `src/pil/layer1-intent.ts` |
| Cheap model playbook | `src/pil/cheap-model-playbook.ts` |
| Tool registry (bash repeat detector) | `src/tools/registry.ts` |
| Canonical hash | `src/orchestrator/tool-args-hash.ts` |
| Top-level streamText loop | `src/orchestrator/message-processor.ts` |
| Sub-agent loop | `src/orchestrator/stream-runner.ts` |
| Compactor (B3/B4) | `src/orchestrator/subagent-compactor.ts` |
| Cross-turn dedup | `src/orchestrator/cross-turn-dedup.ts` |
| Harness E2E template | `tests/harness/bash-output-get-tui.spec.ts` |
| Depth | quick |
| Workflow Kind | product |
| Ideal Run | mr4zuk7h6d34 |
