# Cost Optimization — Sub-agent context leak + DeepSeek caching

**Date:** 2026-05-15
**Branch:** `feat/cost-optimization`
**Trigger:** session `b58603caceb9` — 1 user prompt → 504,737 input tokens billed (7 LLM iterations inside a `task` sub-agent, zero cache writes).

---

## 1. Verified findings (4 parallel Explore agents, file:line evidence)

### 1.1 Sub-agent loop is exempt from auto-compact

- `postTurnCompact()` is the only compaction trigger — defined `src/orchestrator/orchestrator.ts:1722`, called at `2939`, `4429`, `4497` (all inside the top-level `generateMessage()` flow).
- The sub-agent `task` loop in `runTaskRequest()` (`orchestrator.ts:1150-1403`) and its batch sibling `runTaskRequestBatch()` (`1005-1148`) never call `postTurnCompact()`.
- Sub-agent's `childMessages` array grows unbounded for the duration of the delegated task. All tool results from every iteration are replayed to the LLM each loop.
- No per-iteration token budget or max-iterations cap inside the sub-agent loop.

### 1.2 `read_file` / `grep` / `bash` / `process_logs` are uncapped

- `MAX_TOOL_OUTPUT_CHARS = 12_000` at `src/tools/registry.ts:26`. README claims 200 KB — that's stale.
- `truncateOutput()` is applied only to `write_file` (registry.ts:173) and `edit_file` (registry.ts:197).
- `read_file` (registry.ts:61) calls `formatResult(result)` directly with **no cap** → a 701-line file returns ~28k tokens raw into next prompt.
- `task`, `delegate`, `delegation_read`, `delegation_list`, `analyze_image`, `ask_vision_proxy`, `bash`, `grep`, `process_logs` also uncapped.

### 1.3 DeepSeek (and all `openai-compatible` providers) have zero cache support

- `src/providers/runtime.ts:62-70` instantiates DeepSeek / SiliconFlow / xAI via `createOpenAICompatible({ name, baseURL, apiKey })` — no `providerOptions`, no cache markers.
- Cache injection lives only in the Anthropic path at `orchestrator.ts:3776-3781` (`anthropic.cacheControl: { type: "ephemeral" }`) and OpenAI's `store: true` at `3772-3773`.
- The comment near `3770` references a "DeepSeek prefix cache" that was never implemented.
- AI SDK `@ai-sdk/openai-compatible` spec silently drops `providerOptions` it doesn't recognize → observed `cache_creation_tokens=0` across every DeepSeek event.
- **Consequence**: the 452,992 cache_read seen in one event is from a *different* provider call within the session (Anthropic-routed), not DeepSeek.

### 1.4 Persistence gaps

- `usage_events.message_seq` is hardcoded `null` at `orchestrator.ts:859` (`recordUsageEvent(..., null, pilActive, enrichmentDelta)`) — impossible to attribute token cost to a specific user prompt.
- `tool_calls` / `tool_results` tables are written ONLY at end-of-turn via `appendMessages()` (`src/storage/transcript.ts:203-220`, invoked from `orchestrator.ts:3041`). If the process is killed mid-turn, all tool_calls are lost from the structured tables (only `interaction_logs` retains them).
- `messages` row insertion has the same write-once-at-end-of-turn semantics → reproduces the `bff9986eb29e` symptom (2 user_message events in `interaction_logs`, only 1 row in `messages`).
- `interaction_logs` (real-time, fail-open) and `tool_calls` (batched, transactional) are two writers that never reconcile.

### 1.5 Side observation — leaked secret

- `FIGMA_API_KEY` stored plaintext in `~/.muonroi-cli/user-settings.json`. Out of scope for this branch but needs revocation + migration to keychain.

---

## 2. Goal

Reduce billed input tokens by ≥60% for tasks that delegate to `task` sub-agent and read multiple medium files, **without** changing the user-facing behavior of the council / PIL / EE pipeline. Restore the cost claim made in README §2 ("70% cheap, 30% quality, ~$5–8/month").

Concrete acceptance target: a prompt equivalent to the `b58603caceb9` workload ("explore OAuth wiring across keys.ts + runtime.ts + orchestrator.ts") must end with ≤ 80,000 billed input tokens.

---

## 3. Plan (4 phases, atomic commits per task)

### Phase A — Stop the bleeding (no behavior change)

| # | Change | File:line | Test |
|---|---|---|---|
| A1 | Apply `truncateOutput()` to `read_file`, `grep`, `bash`, `process_logs` results before returning to LLM. Default cap raised to 32_000 chars (≈8k tokens) and made configurable via `MUONROI_MAX_TOOL_OUTPUT_CHARS`. | `src/tools/registry.ts:26,61` + each tool wrapper | unit: assert read of 1000-line file returns ≤ cap with head/tail marker |
| A2 | Add `MAX_TOOL_OUTPUT_CHARS` constant export, document head/tail truncation marker shape. Update README §Architecture to match real number (delete the 200KB claim). | `registry.ts:26`, `README.md:254` | grep README for "200KB" returns nothing |
| A3 | Hardcode-fix: pass actual `message_seq` to `recordUsageEvent()` (currently `null`). Use `this.messageSeqs[this.messageSeqs.length-1]`. | `orchestrator.ts:859` | integration: run a 2-prompt session, assert all `usage_events.message_seq IS NOT NULL` |
| A4 | Persist messages **before** the LLM call returns (write-ahead), not at end-of-turn. Same for `tool_calls` row creation at tool dispatch time (status=`pending`), update row at completion. | `orchestrator.ts:3041`, `transcript.ts:203-220` | integration: kill process between LLM call and turn-end, assert `messages` + `tool_calls` partial rows survive |

### Phase B — Cap the sub-agent

| # | Change | File:line | Test |
|---|---|---|---|
| B1 | Inside `runTaskRequest()` and `runTaskRequestBatch()`, call `postTurnCompact()` on `childMessages` after every N tool-call iterations (default N=3) OR when context exceeds `subAgentCompactThresholdPct` (default 0.40). | `orchestrator.ts:1150-1403` (extract helper), reuse compaction logic in `src/orchestrator/compaction.ts` | harness E2E: a sub-agent doing 8 reads ends with ≤ 40k token context at final iteration |
| B2 | Add a hard sub-agent budget: `subAgentMaxInputTokens` (default 120_000 cumulative across all iterations). When exceeded, the sub-agent must summarize its work-so-far and return early. | new field in settings, new check in sub-agent loop | unit: feed 200k of mock tool results, assert early-return with summary |
| B3 | Sub-agent tool result that exceeds 8k tokens runs through a "compress to relevant excerpt" pass: ask `MUONROI_SUB_AGENT_COMPRESS_MODEL` (default same as `research` role) to extract the section relevant to the sub-agent's task description, store full text in transcript, replace in-context with excerpt + `[full result archived seq=N]` pointer. | new helper in `src/tools/compress-tool-result.ts`, called from sub-agent loop | integration: read 701-line keys.ts inside sub-agent, assert context delta ≤ 4k |

### Phase C — Fix DeepSeek caching (or kill the illusion)

| # | Change | File:line | Test |
|---|---|---|---|
| C1 | Investigate whether `@ai-sdk/openai-compatible` v6 forwards arbitrary `extra_body` for OpenAI-spec-extension `cache_control`. If yes, wire DeepSeek prefix cache via `providerOptions.openaiCompatible.extraBody = { cache_control: ... }`. | `src/providers/runtime.ts:62-70` + provider doc check | integration: 2-call session, assert `cache_read_tokens > 0` on call 2 |
| C2 | If C1 not supported by DeepSeek API, implement local content-hash dedup: hash each `tool_result` body, on subsequent inclusion in messages[] for the same session replace with `[CACHED:<short-hash>] see seq=N` and store body once. Save bytes both on persistence and on LLM submission. | new `src/orchestrator/tool-result-cache.ts` + integration in message builder | unit: same file read twice produces second call with `[CACHED:...]` reference |
| C3 | Add cache hit/miss counter to `usage_events` (already has `cache_read_tokens`, add `local_cache_hit_count`). Surface in `muonroi-cli doctor` and `status` slash command so cost regressions are visible. | schema migration, `transcript.ts`, `src/storage/migrations.ts` | doctor reports hit rate per session |

### Phase D — Settings, defaults, docs

| # | Change | File:line | Test |
|---|---|---|---|
| D1 | New settings keys: `subAgentMaxInputTokens`, `subAgentCompactEveryN`, `subAgentCompactThresholdPct`, `subAgentToolResultCompressThreshold`, `localToolResultCacheEnabled`. Defaults in `src/utils/settings.ts:836+`. | `settings.ts`, `user-settings.schema.json` if exists | settings smoke test |
| D2 | Document behavior in `README.md` §Architecture + `CLAUDE.md`. Replace stale "200KB" claim and "~6–7K flat regardless of session length" claim with real numbers and per-mode breakdown (top-level vs sub-agent). | `README.md`, `CLAUDE.md` | grep for stale claims returns nothing |
| D3 | Add a `--cost-report` flag to TUI status that prints per-prompt input/output + cache hit ratio after each turn. | `src/ui/StatusBar` + new util | manual: visible in TUI |
| D4 | (Out of scope but tracked) revoke leaked Figma key + migrate to keychain. | user action + `src/cli/keys.ts` flow | manual |

---

## 4. Rollout order

1. **Commit existing OAuth changes first on a separate branch** (currently parked on `feat/cost-optimization` working tree) — they are unrelated. Plan: branch them to `feat/oauth-openai-fixes`, leave this branch clean.
2. Phase A (4 commits) — low-risk caps + persistence fixes. Run full harness suite after each commit.
3. Phase B (3 commits) — behavioral change in sub-agent. Add a feature flag `experimentalSubAgentCompact` defaulting `false` initially, flip to `true` after manual verification with a `b58603caceb9`-class workload.
4. Phase C (3 commits) — investigate first (C1), fall back to local hash (C2), then telemetry (C3).
5. Phase D (4 commits) — doc + UX surface.

Each commit message follows the convention seen in `git log` (`fix(scope): …` / `feat(scope): …` / `docs(scope): …`). No `--no-verify`.

---

## 5. Verification protocol

Before merging:

1. `bunx tsc --noEmit` — 0 errors.
2. `bunx vitest run` — full suite. Note pre-existing PIL flakes (4) are baseline.
3. `bunx vitest -c vitest.harness.config.ts run tests/harness/` — E2E green.
4. **Repro the leak**: spin up `bun run src/index.ts -p "explore OAuth wiring" -m deepseek-v4-flash -k $KEY` with `LOG_USAGE=1`. Confirm:
   - Final billed input ≤ 80,000 tokens for this single prompt.
   - At least one `cache_read_tokens > 0` event if C1 succeeds, or `local_cache_hit_count > 0` if C2 path is active.
   - All `usage_events.message_seq` populated.
   - All `messages` and `tool_calls` rows present even if the process is `Ctrl-C`'d mid-turn.
5. Post-merge: run on a small sample of real user prompts for 24h, compare avg cost per turn vs pre-merge baseline (from `usage.json`).

---

## 6. Out of scope (parking lot)

- Council debate token cost (already parallelized; revisit if Phase A-C don't deliver enough).
- Vision proxy redundant image caching (separate concern).
- Migration of all secrets in `user-settings.json` to keychain (touch in a security-pass PR).
- Restructuring `interaction_logs` vs `tool_calls` into a single source of truth (post-1.0).
