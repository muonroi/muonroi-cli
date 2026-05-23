# Retrospective — muonroi-cli

## Phase 4: Scope Discipline for Cheap Models (closed 2026-05-23)

### 5-baseline DeepSeek V4 Flash re-run telemetry

> **TBD by user.** Plan 04-07 closed the harness E2E guard; the user-driven 5-prompt baseline re-run is the final gate before the phase is declared "done in production". Run protocol:
>
> ```bash
> # Re-run each of the 5 baseline prompts on DeepSeek V4 Flash with Phase 4 ON.
> # Sessions tracked in ~/.muonroi-cli/muonroi.db. Query:
> sqlite3 ~/.muonroi-cli/muonroi.db "
>   SELECT session_id, COUNT(*) AS tool_calls,
>          SUM(input_tokens) AS in_tok,
>          SUM(output_tokens) AS out_tok,
>          SUM(cost_usd) AS cost
>   FROM tool_calls
>   GROUP BY session_id
>   ORDER BY MAX(created_at) DESC LIMIT 5;
> "
> ```
>
> Targets (G1-G5):
> - G1-Cost ≤ $0.30 per session
> - G1-Tools ≤ 120 calls per session
> - G2-PIL 5/5 correct task_type classifications
> - G3-Cache ≥ 15% prompt_cache_hit_tokens / total_input_tokens
> - G4-Repeat 0 identical-canonical bash repeats per session
> - G5-Outcome ≥ 4/5 sessions land a usable answer

### Plans landed cleanly (no iteration)

- **Plan 01 (4P-1 tree-sitter fix)** — single-file change, regex-narrow scope. Landed first attempt.
- **Plan 02 (4C complexity-size)** — pure regex/heuristic Layer 1.5. Locked thresholds verbatim from CONTEXT; no surprises.
- **Plan 03 (4R session-bash-repeat)** — closure-state-to-globalThis migration. Mirror of existing C3 cross-turn dedup pattern; landed clean.
- **Plan 04 (4B ceiling + forced-finalize)** — two TS narrow-generic adjustments captured as deviations (Rule 3). Both auto-fixed during the same task.
- **Plan 06 (4P-2 bridge classifier)** — prompt-only edit; pass 3 parser widened to accept `general` alongside `none`. Landed clean.

### Plans needing iteration

- **Plan 05 (4A scope reminder)** — locked reminder format (header + snippet + tail) + 100-char snippet + 200-char cap were mathematically incompatible with the verbatim spec tail. Tail trimmed from `"if no → emit final answer; if yes → continue."` (61 chars) to `"still on scope? if no, finalize."` (32 chars). 4V harness still matches because it only greps the `[scope-check step N/` header and the `still on scope?` marker, both preserved. Plan iterated once during Task 1 GREEN.
- **Plan 07 (4V harness E2E)** — initial fixture used a PIL classifier absorber as round 0 expecting the unified-brain to consume it. Empirically, unified-brain default OFF + EE bridge `/api/classify` means PIL does NOT emit a streamText round captured by the mock model. The agent consumed the absorber as a text+stop reply and ended on round 0, never calling bash. Fix: drop the absorber, make round 0 the first bash tool-call. Spec passes 5/5 after this change.

### Patterns to carry into Phase 5

1. **Hybrid spec strategy (unit imports + live spawn)** — Plan 07 demonstrates that driving 7+ live rounds through a spawned TUI is brittle; pairing a single live-spawn assertion with direct module imports for deterministic behaviors (cadence math, toast strings, override grammar) is strictly stronger AND faster. Plan acceptance criteria explicitly permit this split (the `EITHER stderr OR fall back to inline import-and-call` clause). Adopt as the default harness pattern for orchestrator-level behavioral guards.
2. **globalThis-backed session state mirrors a single pattern** — Plans 03/04/05 all use the same `globalThis.__muonroi*` Map for session-scoped state (bash repeat detector, scope-ceiling counter, soft-warn one-shot guard). Cross-turn-dedup G3 was the original. This is now a five-instance pattern; consider extracting a shared `createSessionScopedMap<K, V>(name)` utility in Phase 5 if a sixth use case lands.
3. **`--flag N` parsed BEFORE PIL** — Plan 04's `parseBudgetOverride` runs on the raw user message before any PIL layer fires. Any future user-facing CLI override flag (e.g. `--no-cache`, `--max-tool-rounds N` if revived as user-facing) should follow this pattern: parse → strip → cleanedPrompt → PIL.
4. **Pre-existing TS errors in `src/ee/transcript-emit.ts`, `src/orchestrator/orchestrator.ts`, `src/product-loop/*`** — unchanged since baseline. NOT touched by Phase 4. Phase 5 should open a dedicated chore-typecheck plan to close them before they accumulate further.
5. **Harness suite flakiness (b3/b4/f1 TUI specs, bb-aware-ideal, events)** — intermittent failures predate Phase 4. Phase 5 should triage these (dump-file race conditions + mock-server cold-start timing) before adding new TUI specs that share the same harness path.

### Scope kept honest

Phase 4 deliberately excluded:
- File-scope quarantine (Aider-style edit gating) — deferred to Phase 4.2 / Phase 5
- EE `IRRELEVANT` 100% noise reduction — flag for EE team
- Capability-scoped subagents per role — Phase 5+

None of these crept in during execution; CONTEXT discipline held.
