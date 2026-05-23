# Project State — muonroi-cli

**Last updated:** 2026-05-23 (Plan 04-04 4B complete)

**Last completed plan:** Phase 4, Plan 04 (4B ceiling + forced-finalize) — commits `4e7ad66` (RED test), `96cfd46` (GREEN scope-ceiling module), `3178239` (top-level + sub-agent wiring). Per-session step ceiling resolved from locked `(task_type × complexity_size)` matrix; hard halt triggers forcedFinalize LLM call with `toolChoice:"none"`. `--budget-rounds N` parsed before PIL. REQ-004 satisfied.

**Previously completed:**
- Plan 02 (4C complexity-size) — commits `f37f45f`, `ec4e4a0`. Deterministic Layer 1.5 classifier wired into PIL pipeline; `ctx.complexitySize` populated for downstream 4B/4A consumption. REQ-003 satisfied.
- Plan 03 (4R session-bash-repeat) — commit `b04ef51`. Session-scoped bash canonical-repeat detector. REQ-002 satisfied.
- Plan 01 (4P-1 tree-sitter fix) — commit `bc07709`. Tree-sitter:* reasons no longer bias taskType=refactor. REQ-001 partially satisfied (bridge classifier tuning remains for 4P-2).

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
