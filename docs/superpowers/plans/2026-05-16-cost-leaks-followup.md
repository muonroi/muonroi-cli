# Cost-leak follow-up plan (post-G1)

**Branch:** `feat/cost-optimization`
**Predecessor:** `2026-05-15-cost-optimization.md` (Phases A/B/C/D), `2026-05-15-cost-optimization-verify.md` (acceptance protocol). Phases A/B/C2/D + E1/F1/G1 + runtime-routing fixes landed on commits up to `9353c92`.

## Background — what we already shipped

| Phase | Fix | Status |
|---|---|---|
| A1 | 32 KB per-tool-output cap, env-overridable | ✅ |
| A3 | `lastPersistedSeq` attribution for `usage_events.message_seq` | ✅ (partial; first turn still NULL — A4) |
| B1 | `wrapToolSetWithCap` cumulative cap inside sub-agent | ✅ |
| B2 | Hard budget (120 KB default, env-overridable) | ✅ |
| C2 | sha1-12 dedup of identical tool outputs within sub-agent | ✅ |
| D2/D3 | README/CLAUDE.md cleanup + `usage forensics <prefix>` subcommand | ✅ |
| E1 | Top-level tool budget cap (400 KB default, 50%/80% tiers) | ✅ |
| F1 | Stable `providerOptions.openai.promptCacheKey = sha256(sessionId)` | ✅ |
| G1 logging | `MUONROI_DEBUG_SUBAGENT=1` stderr stream / catch dump | ✅ |
| G1 fix | Honour `unsupportedParams` (maxOutputTokens, temperature) in `runTaskRequest` | ✅ |
| Runtime | OpenAI reasoning → `.responses()` on API-key path; guard `anthropic.thinking` | ✅ |

Pre-fix worst session: **c070f6ca6768 — peak 454,881 input on a single `task` event**. Post-G1 expectation: sub-agent runs to completion and parent receives a compact summary instead of falling back to direct grep/read_file (which produced 159–196 K input in sessions 81187c / bdf696).

---

## Verification before this plan was written

Three parallel Explore sub-agents (2026-05-16) returned:

1. **G1 fix correctness — PASS / HIGH confidence.** All other `streamText` / `generateText` callsites unguarded for `maxOutputTokens` are API-key-only paths (council/research/compaction/side-question). ChatGPT Codex backend only rejects `maxOutputTokens`, not `temperature` / `topP`.
2. **Sub-agent loop accumulation — CONFIRMED.** AI SDK v6 `streamText` with `stopWhen: stepCountIs(N)` re-sends the full `messages` array each step. There is no in-code message compaction. **`prepareStep` hook exists in `ai@6.0.169`** (renamed from `experimental_prepareStep`) and accepts a mutable `messages` override.
3. **DeepSeek cache claim — REVISED.** DeepSeek prefix cache is auto / server-side. `@ai-sdk/openai-compatible` does **not** forward arbitrary `extra_body`, but DeepSeek doesn't require client opt-in. The real bug is `tool-utils.ts:getUsage()` reading `cache_creation_input_tokens` (OpenAI naming) instead of DeepSeek's actual response field. Cache may already be hitting; the metric is just under-reported.

---

## Acceptance targets

| Metric | Pre-fix baseline | Post-plan target |
|---|---|---|
| Peak single-call input (sub-agent succeeds) | 454,881 (c070f6ca) | ≤ 80,000 |
| Cumulative input per "explore OAuth wiring" prompt | 523,316 | ≤ 100,000 |
| Cache hit ratio on multi-round OpenAI turns | 13.8% (81187c) | ≥ 60% |
| `cache_creation_tokens` reported correctly for DeepSeek | always 0 | non-zero when prefix repeats |
| `message_seq` NULL count in `usage_events` | 1–3 per session | 0 |

---

## Phase order

P0 verify → P0 fix the biggest active path → P1 observability + secondary leaks → P2 efficiency. Each phase is independently shippable and reverts cleanly.

---

### Phase V — Verify G1 fix landed

**Owner action only.** Sub-agent verification gave HIGH confidence statically, but a real-end-to-end run with OAuth is the empirical proof.

```powershell
$env:MUONROI_DEBUG_SUBAGENT = "1"
bun run src/index.ts -m gpt-5.4 2> subagent-debug.log
# In TUI: "check cho tôi tôi muốn dùng chức năng oauth của openAI trong cli muonroi này thì làm sao nhé, tôi đã làm rồi"
# /exit, then:
bun run src/index.ts usage forensics <new-session-id>
```

**Pass criteria**:
- No `[subagent] catch: name=AI_NoOutputGeneratedError`
- Peak single-call input ≤ 80,000
- Cumulative input ≤ 100,000

**If FAIL**: log will show the actual residual error (likely a different `unsupportedParams` entry to add, or the sub-agent picking a model the Codex backend rejects — e.g. `o3` instead of a `gpt-5.x-codex`).

**Effort: 5 min owner.** Block on this before starting B3.

---

### Phase B3 — Sub-agent mid-loop message compaction

**Problem:** The verified P0 leak. AI SDK re-sends the full message array per step. After 6 tool rounds inside a `general` sub-agent, the prompt history (system + 6 tool_result blocks ≥ 32 KB each → 200 KB+ context) is re-sent each round, multiplying billed input ~5×.

**Approach (single-path, no flag):**

Implement `prepareStep` hook on the sub-agent `streamText` call at `src/orchestrator/orchestrator.ts:1373`:

```ts
const result = streamText({
  model: childRuntime.model,
  system: childSystem,
  messages: childMessages,
  tools,
  stopWhen: stepCountIs(...),
  prepareStep: async ({ messages, stepNumber }) => {
    if (stepNumber < 2) return {};                   // first 2 steps: pass through
    return { messages: compactSubagentMessages(messages, {
      keepLatestN: 2,                                // keep last 2 turns full
      replaceOlderToolResultsWith: (i, len) =>       // older = stub
        `[result ${i} elided, ${len} chars, content available on request]`,
    })};
  },
  ...
});
```

**Compaction policy** (`src/orchestrator/subagent-compactor.ts` — new file):
- Always preserve: `system`, the original user prompt, every assistant message (text + tool calls).
- For tool-result blocks older than `keepLatestN` rounds: replace with a 100-char stub carrying its sha1-12 + char count. The hash lets a later round say "re-read call #N if needed" but discourages it.
- Never compact the latest round (LLM needs fresh tool outputs to reason on).

**Plumb the same cumulative state**:
- The B1 wrap state already tracks `seenHashes` per-invocation. Reuse it so the compactor can short-circuit "I've stubbed this before".

**Tests** (`subagent-compactor.test.ts`):
1. Step 0/1: pass-through (no compaction).
2. Step ≥ 2: messages older than `keepLatestN` have tool_result replaced; system + user untouched.
3. Idempotence: running compactor twice produces same output.
4. Hash carry-through: replacement stub references the same hash B1 produced.

**Env knob:** `MUONROI_SUB_AGENT_COMPACT=0` to disable for A/B comparison.

**Acceptance**: re-run c070f6ca repro prompt. Peak `task` source event ≤ 80 K. Sub-agent still produces a coherent summary (read the chat-export — the report structure should be intact).

**Effort:** ~3 h. Risk: medium — compaction policy can starve the LLM of context. Mitigate by starting with `keepLatestN: 3`.

---

### Phase B4 — Top-level mid-loop compaction (mirror of B3)

**Problem:** Same accumulation pattern when the top-level orchestrator falls back to direct tools (post-fail) OR when a turn legitimately spans many rounds. Pre-G1 this was the 159–196 K leak. Even with G1 fixed, any future failure mode that knocks out the sub-agent path re-exposes this.

**Approach:** Same `prepareStep` hook applied at `orchestrator.ts:3988` top-level `streamText`. Use a looser policy:
- `keepLatestN: 4` (top-level user expects fuller history)
- Apply only when cumulative `messages` chars exceed a threshold (e.g. 60% of `topLevelToolBudgetChars`).

Reuse `topLevelCap.state.cumulative` to gate when compaction kicks in.

**Acceptance**: re-run 81187c repro WITHOUT the G1 fix (revert temporarily) — confirm peak now ≤ 60 K instead of 38 K with cumulative ~50 K instead of 196 K. Then re-enable G1 fix.

**Effort:** ~1 h (most code reused from B3). Risk: low.

---

### Phase C1 — DeepSeek cache field correction (revised scope)

**Problem:** Cost-forensics anomaly `deepseek route has zero cache_creation_tokens` fires on every DeepSeek session, but the cache is auto / server-side. The metric is being read from the wrong response field.

**Verify first** (~30 min):
- Run a 2-turn DeepSeek session: send same prompt twice. Capture raw response JSON for both turns (add temporary `process.stderr.write(JSON.stringify(rawResponse))` in `recordUsage`).
- Confirm DeepSeek's field names: candidates are `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `cache_hit_tokens`, `cached_tokens`.

**Fix** in `src/orchestrator/tool-utils.ts:getUsage()` (and parallel sites in `orchestrator.ts:1361`):
```ts
const cacheReadTokens =
  asNumber(tu.cachedInputTokens) ??
  asNumber(details?.cacheReadTokens) ??
  asNumber(raw?.prompt_cache_hit_tokens) ??  // DeepSeek
  asNumber(raw?.cached_tokens) ??             // OpenAI-newer
  0;
const cacheCreationTokens =
  asNumber(details?.cacheWriteTokens) ??
  asNumber(raw?.cache_creation_input_tokens) ?? // OpenAI
  asNumber(raw?.cache_miss_tokens) ??           // DeepSeek (likely)
  0;
```

**Fix in cost-forensics**: anomaly should check `totalCacheRead === 0` on `model.startsWith("deepseek")`, not `cache_creation_tokens === 0`. Auto-cache means "creation" is not a client-visible event.

**Tests:** add unit tests over a hand-crafted DeepSeek response shape (fixture in `__tests__/deepseek-usage.fixture.json`).

**Acceptance:** `usage forensics <deepseek-session>` no longer prints the C1 anomaly when cache is working; prints a new anomaly only if `cacheReadTokens === 0` across > 1 turn of identical prefix.

**Effort:** ~2 h.

---

### Phase A4 — Write-ahead persistence

**Problem:** Assistant message + tool_calls are persisted only AFTER the streamText call returns. If the process crashes mid-stream (network error, OOM, Ctrl-C), the user-visible turn appears to vanish AND `usage_events` recorded during the stream attribute to `message_seq=null` because `lastPersistedSeq` reads stale state.

**Approach:**
1. Before the `streamText` call (orchestrator.ts:3988), insert a placeholder `assistant` message into the DB with `is_partial=1` and capture its `seq`.
2. Pass that seq into `recordUsage` so events attribute correctly even before the stream finishes.
3. On stream complete: update the placeholder with the actual content + `is_partial=0`.
4. On stream error / abort: keep the placeholder but mark `error=1` so post-mortem queries can see it.

**Schema change:** `messages.is_partial INT DEFAULT 0`, `messages.error INT DEFAULT 0` (additive — backwards compatible).

**Tests:** `orchestrator/write-ahead.test.ts` — simulate a stream that throws after 2 tool calls; assert placeholder exists, tool_calls are present, usage_events all have non-null message_seq.

**Acceptance:** `usage forensics` no longer reports `Phase A3 fix not active` anomaly; every event has a `seq`.

**Effort:** ~2 h. Risk: low (additive schema).

---

### Phase M1 — MCP lazy schema loading

**Problem:** 7 MCP servers × 8–15 tools × ~150 token schemas = **8–15 K tokens** burnt every agent-mode turn whether or not the LLM uses any MCP tool. The existing smart filter (`orchestrator.ts:3729`) only skips browser/vision MCP — code-only turns still pay the rest.

**Approach (most conservative):**
1. Boot MCP servers as today (so they're warm).
2. Build **schema stubs** (name + 1-line description, no `parameters` JSON Schema) for first-pass injection. ~50 tokens/tool instead of 150.
3. Detect tool invocation in `fullStream` → on first attempt, load full schema for the named tool and retry (single retry, cached for the rest of the turn).

**Risk:** AI SDK may reject calls if the schema lacks `parameters`. Validate first with a spike — if rejected, fallback to **eager-load on first MCP tool use only** (server-by-server, not tool-by-tool).

**Acceptance:** First round of an MCP-using turn has ≥ 5 K fewer input tokens than baseline.

**Effort:** 4–6 h. Risk: medium-high. **Defer until B3/B4 land** — those have higher ROI and less risk.

---

### Phase C3 — Cross-turn tool-result dedup

**Problem:** C2 dedup is in-memory per-sub-agent. If the user sends two prompts both reading `orchestrator.ts`, each pays full 32 KB. Cross-turn dedup would index hashes in DB and have `read_file` return `[see message #N for identical content]` on a repeat hit.

**Approach:**
1. New table `tool_output_hashes (session_id, message_seq, tool_call_id, sha1_12, char_count)`.
2. Insert on every recorded tool_result.
3. Before sending a fresh tool_result into messages, lookup hash — if exists in this session, replace with a stub pointing at the prior message seq.

**Risk:** The LLM may not understand the back-reference reliably. Add a 1-sentence system-prompt hint.

**Acceptance:** A 2-prompt session that reads the same 4 files twice shows the second turn's tool_result blocks ≥ 80% smaller.

**Effort:** ~3 h. Risk: low-medium. **Defer until B3 lands** — B3 reduces the intra-turn growth that makes cross-turn dedup most valuable.

---

### Phase O1 — Observability: log providerOptions key+size

**Problem:** Forensics shows `cache_hit_ratio = 13.8%` on session 81187c but can't tell us why (was promptCacheKey set? was cacheControl marker present? did the prefix change between rounds?). Without this signal, every cache investigation is blind.

**Approach:**
1. In `recordUsage`, also log `providerOptions` shape (key names + JSON.stringify size) into the existing `usage_events.notes` JSON column (add column if not present).
2. `usage forensics` reports `Σ providerOptions chars per event` and surfaces "promptCacheKey absent on event #N" anomalies.

**Effort:** ~1.5 h.

---

## Roll-up effort + sequencing

```
V  (verify G1)        5 min   owner action — blocks everything
B3 (sub-agent compact)  3 h   biggest active leak path
B4 (top-level compact)  1 h   safety net
C1 (DeepSeek fields)    2 h   fixes forensics false-positive, may surface real cache wins
A4 (write-ahead)        2 h   forensics integrity
O1 (providerOptions)  1.5 h   future-proofing diagnoses
─────────────────────────────
                       9.5 h  P0 + P1 land in 1 working day

M1 (MCP lazy)         4-6 h   P2 — only after B3 ships
C3 (cross-turn dedup)   3 h   P2 — only after B3 ships
─────────────────────────────
                       7-9 h  P2 batch
```

## Risk register

| Risk | Mitigation |
|---|---|
| B3 over-compacts → LLM loses context, sub-agent quality drops | `keepLatestN` env knob; ship with `keepLatestN=3`; A/B against c070f6ca prompt; verify summary structure intact |
| B4 prepareStep + E1 cap double-trim same output | Disable E1 trim path when prepareStep is active (mutually exclusive) — read `topLevelCap.state.cumulative` to decide which fires |
| C1 wrong DeepSeek field guess | Empirical capture (Phase C1 starts with raw-response logging) before code change |
| A4 placeholder rows pollute DB on crashes | Cleanup job in `Agent.boot()` — drop is_partial rows older than 24h |
| M1 schema stub rejected by AI SDK | Spike first; fallback to per-server lazy load |

## Out of scope

- Multi-model batching (not a leak; a concurrency feature).
- Replacing AI SDK with manual provider HTTP calls (huge refactor; revisit only if `prepareStep` proves insufficient).
- Anthropic billing optimization (already well-cached via `cacheControl`).

## Where the verification evidence lives

- 2026-05-16 Explore agent reports — see conversation transcript in `~/.muonroi-cli/muonroi.db` session `<this-session-id>`, or chat-export-bdf696ea66b9.txt for the original repro.
- Pre-fix baseline data: chat-export-{81187c571ad9,bdf696ea66b9,c070f6ca6768}.txt + `usage forensics <prefix>`.
