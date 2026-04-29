# Phase 1: Brain & Cap Chain - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Five providers stream tool calls behind a single adapter; the 3-tier router classifies in-process at <1ms hot-path; EE PreToolUse warnings render inline with scope-correct principles; the cap chain auto-downgrades Opus → Sonnet → Haiku → halt and survives every runaway-scenario test.

**In scope:** TUI-05, PROV-01/02/04/05/06, ROUTE-01..07, EE-02..10, USAGE-02/03/04/05/07.
**Out of scope (later phases):** USAGE-08 `/cost` slash (Phase 2), `.muonroi-flow/` artifacts + `/discuss /plan /execute /compact /clear /expand` (Phase 2), CORE/OPS (Phase 3), CLOUD/BILL/WEB (Phase 4).

**Cross-phase obligations locked here (per ROADMAP):**
- `tenantId` is a required parameter on every EE call from day 1 (single-tenant local stays "default" but the field exists).
- Each principle carries `principle_uuid` + `embedding_model_version` from the moment it lands (Phase 4 migration tool depends on this schema).
- Principle scope payload is `global | ecosystem:muonroi | repo:<remote> | branch:<name>`. Set on insertion; retrofit later means re-tagging every existing principle.

</domain>

<decisions>
## Implementation Decisions

### Plan Slicing (8 plans, by domain)
Bisectable; one concern per plan; matches roadmap success criteria 1:1.
- **01-PLAN: Provider Adapter + 5 providers** — `Adapter` interface + Anthropic/OpenAI/Gemini/DeepSeek/Ollama implementations behind it (PROV-01/02/04/05/06).
- **02-PLAN: Hot-path classifier** — regex tier + tree-sitter WASM fallback; arch test forbids network in module (ROUTE-01/07).
- **03-PLAN: Warm/cold router** — EE `/api/route-model` warm tier + SiliconFlow proxy cold tier + health check loop + tier badge state (ROUTE-02/03/04).
- **04-PLAN: Reservation ledger + thresholds** — atomic `current+reservations+projected ≤ cap` ledger; 50/80/100 threshold events (USAGE-02/03).
- **05-PLAN: Downgrade chain + /route** — Opus → Sonnet → Haiku → halt with status-bar transitions; cap-vs-router precedence; `/route` slash command (USAGE-04/05, ROUTE-05/06).
- **06-PLAN: TUI status bar** — model + tier badge + token counters + session USD + month USD + tier-degraded marker (TUI-05).
- **07-PLAN: EE PreToolUse rendering + scope** — inline `⚠️ [Experience]` warnings, scope payload (`global/ecosystem/repo/branch`), tenantId everywhere, scope filter on cwd+remote, principle_uuid+embedding_model_version schema (EE-02/04/05/06/07).
- **08-PLAN: Auto-judge + PostToolUse + runaway tests + perf guard + pruning** — fire-and-forget posttool, deterministic FOLLOWED/IGNORED/IRRELEVANT classifier, runaway scenario suite (infinite loop / large file / model thrash / 10-parallel burst), p95 ≤25ms PreToolUse CI guard, 30-day decay pruning (EE-03/08/09/10, USAGE-07).

### Provider Adapter (Plan 01)
- Single `Adapter` interface in `src/providers/types.ts`: `stream(request) → AsyncIterable<StreamChunk>`, `tools` shape, normalized error type (rate_limit | auth | content_filter | server_error | unknown) per PROV-05.
- Per-provider implementations import AI SDK packages already pinned: `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible` (DeepSeek + SiliconFlow share the OpenAI-compatible shape), `ollama-ai-provider-v2`.
- Pricing table: `src/providers/pricing.ts` static map, `{provider, model} → {input_per_million_usd, output_per_million_usd}`. Phase 1 ships static; remote fetch is Phase 4 (PROV-06).
- Provider selection (PROV-02): `~/.muonroi-cli/config.json` `default.provider` + per-call slash override. First key found in keychain wins on cold start when no default set.
- Parallel tool calls (PROV-04): every provider must round-trip parallel tool_use blocks. AI SDK v6 normalizes most cases; record-replay covers the wire format.

### Provider Tests (CI strategy)
- Recorded JSONL fixtures under `tests/fixtures/providers/<provider>/<scenario>.jsonl` (stream chunks + tool calls). AI SDK v6 mock streams replay them deterministically. No keys needed for the bulk of provider tests.
- One opt-in live smoke per provider (`tests/live/<provider>.live.test.ts`), gated by env-var presence. Skipped silently when key missing. Run nightly or on-demand, not every PR.
- Fixtures cover: streaming text, single tool call, parallel tool calls (provider permitting), each error class.

### Hot-Path Classifier (Plan 02)
- Regex tier first: keyword + structural patterns covering "create file", "edit", "run command", "explain", "refactor" intents. Cheap (<100µs). Catches the obvious 70-80%.
- Tree-sitter WASM tier second: when the prompt embeds code (heredoc, fenced block, backticks dense), parse with `web-tree-sitter` via tiny grammar bundle (TypeScript + Python loaded lazily) to detect symbols/diagnostics intent. Stays well under 1ms p99 on warm cache.
- Confidence threshold (ROUTE-07): configurable `route.classifier_confidence_min` (default 0.55). Below → warm path.
- Architecture test: vitest arch test scans `src/router/classifier/**` for any `import` from `node:net|node:http|fetch|axios|undici|@ee/` and fails CI on match. Belongs to plan 02.

### Warm/Cold Router (Plan 03)
- Warm path: `EE_BASE_URL/api/route-model` POST, 250ms timeout, returns `{model, tier, confidence, reason}`. Phase 1 ships the client + the EE-side endpoint contract (the EE-side handler itself is owned by EE repo; we ship the client + a stub for local-only smoke).
- Cold path: SiliconFlow proxy via EE `/api/cold-route` POST, 1s timeout. Same response shape.
- Health probe: every 30s GET `EE_BASE_URL/api/health` with 60s TTL cache. On unhealthy: status-bar tier badge flips to `degraded`. Health failure does NOT abort the prompt — falls through to cold or hot-only.
- Routing precedence: cap-driven downgrade > tier classification (per ROUTE-06).

### Reservation Ledger (Plan 04)
- File: `~/.muonroi-cli/usage.json` (already owned by Phase 0). Schema extends with `reservations: [{id, model, projected_usd, expires_at}]`.
- Atomicity: file lock via `proper-lockfile` or homemade `.lock` file with PID+ts (existing atomic-rename pattern from Phase 0 used for the writes themselves; lock prevents racing readers/writers across CLI processes).
- API: `reserve(model, est_input, est_output) → ReservationToken | CapBreachError` and `commit(token, actual_input, actual_output)` and `release(token)`.
- Estimator: pricing table × token estimator (input known precisely; output projected as `min(model.max_output, est_output_chars/4)`).
- Thresholds (USAGE-02): events fire at 50/80/100% of `current_month_usd / cap.monthly_usd`. 50% = banner notice; 80% = warning toast + status-bar yellow; 100% = halt + downgrade kicks in.

### Downgrade Chain & /route (Plan 05)
- Chain: `Opus → Sonnet → Haiku → halt`. Triggered by ledger when projected breach. Status-bar prints transition: `Capping at 80% — switching Opus → Sonnet`.
- Mid-stream policy (USAGE-05): in-flight stream finishes; next reservation refused. Acceptable single-stream overshoot ~101%.
- `/route` slash: prints next-prompt routing decision (heuristic match | EE classifier confidence | cap-driven downgrade) + reason.
- Cap-vs-router: ledger reservation is consulted before classifier; if downgrade required, target model overrides classifier output. ROUTE-06 codified as a single integration test.

### TUI Status Bar (Plan 06)
- Slot order (left→right): `[provider/model]  [tier badge]  [in/out tokens session]  [USD session]  [USD month]  [degraded? marker]`.
- Tier badge color: hot=green, warm=cyan, cold=magenta, degraded=yellow blink.
- Refresh: subscribed to ledger update events + classifier+router decisions; no polling.

### EE PreToolUse Rendering + Scope (Plan 07)
- PreToolUse POST `/api/intercept` blocking, 1s timeout. Failure modes: 5xx → allow + log warning; timeout → allow + log warning; `decision: 'block'` → abort tool + render block reason inline.
- Render: `⚠️ [Experience - {confidence}] {message}\n  Why: {why}\n  Scope: {scope_label}` immediately above the tool call, before stdout streams.
- Scope payload: every principle insert/update writes `{global | ecosystem:muonroi | repo:<remote_url> | branch:<branch_name>}`. PreToolUse query filters by `cwd → git remote + git branch`. tenantId always = `local` in Phase 1; field is required.
- Schema: `principle_uuid` (uuid v4 generated client-side), `embedding_model_version` (matches the model used at insert time, e.g. `nomic-embed-text-v1.5`). Stored on every principle on first write.
- EE auth token: read from `~/.experience/config.json` once at startup; refresh on 401.

### Auto-Judge Loop (Plan 08, deterministic rules)
- Capture at PreToolUse: `warningId`, `principle_uuid`, `expectedBehavior` (string from EE response), `tool_name`, `args_hash`.
- Capture at PostToolUse: `exit_code`, `duration_ms`, `error_class` (one of: `none | exec_error | tool_error | timeout | abort`), `diff_present` (bool, for edit/write).
- Classification rules:
  - **FOLLOWED** = warning fired AND `error_class === 'none'` AND (no expected diff OR diff produced).
  - **IGNORED** = warning fired AND (`error_class !== 'none'` OR an expectedBehavior pattern explicitly matched a failure mode).
  - **IRRELEVANT** = no warning fired OR principle scope mismatched cwd at PreToolUse time.
- POST `/api/feedback` fire-and-forget (no await on hot path) with `{principle_uuid, classification, evidence}`.
- No LLM judge in Phase 1. EE-side async rerank can extend later without orchestrator changes.

### PreToolUse Latency Guard (EE-08)
- CI step: vitest perf assertion harness — synthesizes 200 PreToolUse cycles against a local EE stub, measures p95, fails if >25ms. Harness lives at `tests/perf/pretooluse.bench.ts`.

### Junk Pruning (EE-10)
- EE-side worker (we do not own the cron). Phase 1 contribution: every PreToolUse query response carries `last_matched_at`; on tool completion we POST `/api/principle/touch?id=...` if matched. The 30-day decay sweep itself is owned by EE repo; this phase verifies the touch endpoint contract works end-to-end.

### Runaway Scenarios (Plan 08, USAGE-07)
Test suite gating Phase 1 completion:
- **Infinite tool loop**: stub provider that always returns the same tool call. Reservation ledger must halt before cap exceeded.
- **Large-file recursion**: tool that writes 10MB then re-reads — verifies projected token estimate is capped per call.
- **Model thrashing**: rapid model switches. Verifies ledger reservation does not double-charge across switches.
- **10-parallel-call burst**: parallel tool_use block with 10 entries. Ledger must serialize reservations or atomically reserve-all-or-none.

### Claude's Discretion
- Specific test naming, fixture file layout, CI YAML structure for the live-smoke matrix.
- Whether to use `proper-lockfile` (ext dep) vs hand-rolled `.lock` for the ledger — pick based on Windows compat.
- Tree-sitter grammar bundle list (start with TS+Python; add more if regex misses surface).
- Whether to gate the live-smoke per provider behind separate CI workflow files vs a single matrix job.
- Slash command parser refactor scope — extend existing palette only as needed for `/route`.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets (already in repo from Phase 0)
- `src/providers/anthropic.ts` — first adapter; refactor behind `Adapter` interface in plan 01.
- `src/providers/types.ts` — exists; extend with the unified `Adapter` interface.
- `src/ee/client.ts` + `health.ts` + `intercept.ts` + `posttool.ts` + `types.ts` — EE HTTP surface from Phase 0; extend in plans 07/08, do not rewrite.
- `src/storage/usage-cap.ts` — file owner of `usage.json`; extend with reservation ledger primitives (plan 04).
- `src/storage/atomic-io.ts` — atomic-rename + tmp staging utility used everywhere; reuse for ledger writes.
- `src/utils/redactor.ts` (PROV-07) — must wrap any new error-class strings sent to EE feedback endpoint.
- OpenTUI status frame from grok-cli — slot exists; populate in plan 06.
- `web-tree-sitter@0.26.8` — already pinned; load WASM grammars lazily in plan 02.

### Established Patterns
- Bun runtime + ESM modules; vitest@4.1.5 for tests (locked Phase 0).
- Async-generator-of-StreamChunk for provider streams; preserve verbatim across all 5 providers.
- AI SDK v6 field names: `chunk.text` (text-delta), `chunk.input` (tool-call), `chunk.finishReason` (finish).
- `keytar` dynamic import (Phase 0 pattern) — keep for any new secret reads.
- Atomic-rename via `.tmp` for any file write that crosses process boundaries.

### Integration Points (Phase 1 owns)
- `src/providers/{adapter.ts,anthropic.ts,openai.ts,gemini.ts,deepseek.ts,ollama.ts,pricing.ts,errors.ts}` — adapter + 4 new provider files + pricing + error normalization.
- `src/router/{classifier/,warm.ts,cold.ts,health.ts,decide.ts,types.ts}` — currently empty; entire router lands here.
- `src/usage/{ledger.ts,thresholds.ts,downgrade.ts}` — currently empty; cap-chain runtime lives here (extending `src/storage/usage-cap.ts` for persistence only).
- `src/ee/{intercept.ts (extended), posttool.ts (extended), judge.ts (new), scope.ts (new)}` — extend Phase 0 surfaces; add scope filter + judge classifier.
- `src/ui/status-bar.tsx` (or rehome of inherited grok-cli status frame) — TUI-05 belongs here.
- `src/ui/slash/route.ts` — `/route` slash command handler.
- `tests/fixtures/providers/**` — recorded streams.
- `tests/perf/pretooluse.bench.ts` — p95 ≤25ms guard.
- `.github/workflows/{providers-live.yml, perf-guard.yml}` — opt-in live smoke + perf CI.

</code_context>

<specifics>
## Specific Ideas

- The 5 providers ship together in plan 01 — no provider split (D-006).
- DeepSeek + SiliconFlow are not separate adapter classes; they share `OpenAICompatibleAdapter` parameterized by `baseURL` + `model`. This keeps the adapter count at 4 classes covering 5 logical providers.
- Tier badge wording: `hot` / `warm` / `cold` (lowercase, monospace) per IDEA convention; status-bar component reads from a Zustand-style store seeded by router decisions.
- "Acceptable single-stream overshoot ~101%" is encoded as a unit test assertion against a synthetic stream that stops at exactly the breach point — not a fuzz target.
- Auto-judge `expectedBehavior` is whatever string EE returns in the intercept payload — orchestrator does NOT generate or interpret natural language; it only does deterministic outcome tagging.
- Tree-sitter grammar set kicks off with TypeScript + Python; expand only if regex tier confidence falls below 80% on the seed prompts in plan 02 fixtures.

</specifics>

<deferred>
## Deferred Ideas

- USAGE-08 `/cost` slash command — Phase 2 (depends on full slash framework).
- Remote pricing fetch endpoint — Phase 4 WEB-02; Phase 1 ships static table only.
- LLM-based auto-judge rerank — explicitly out of Phase 1; EE repo can add async worker later.
- The 30-day decay sweep cron itself — owned by EE repo; Phase 1 only verifies the touch endpoint contract.
- `tools/coverage` per-provider mid-stream resumability — `bun:resumable streams` not in v6 yet; revisit if AI SDK v7 adds it.

</deferred>
