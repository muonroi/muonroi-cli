# Phase 12: Quality & Efficiency Improvements from DB Stats Analysis

> Source: SQLite analysis of `~/.muonroi-cli/muonroi.db` — 126 sessions, 3,676 messages, 2,048 tool calls (May 4-6, 2026)

---

## Issue 1: `edit_file` Failure Rate — 26.5% (22/83 calls)

### Root Cause (confirmed)
- **NOT** "forgot to read file" — all 22 failed edits had prior `read_file` calls
- **55% Cascade failure**: edit fails → model retries with same stale `old_string` → fails again. Session `29bddc` had 9 consecutive failures on `experience-core.js` without refreshing file content
- **30% Stale snapshot**: model reads file early, other edits change content, then old_string no longer matches
- **15% Truncated old_string**: model generates partial/truncated match strings

### Data
- deepseek-chat: **34.5%** fail rate (10/29 edits)
- deepseek-v4-flash: **22.2%** fail rate (12/54 edits)
- MCP `mcp_filesystem__edit_file`: **0% fail** (25/25 success) — same sessions, same models
- File `experience-core.js` alone: 8/22 failures (36% of all failures)

### Fix Plan
1. **Auto re-read on edit failure** — when `edit_file` returns "old_string not found", inject a system hint telling the model to re-read the file before retrying
   - File: `src/orchestrator/orchestrator.ts` (tool result handler)
   - Estimated: ~15 lines
   - Impact: eliminates cascade failures (55% of failures → ~12 fewer failures)

2. **EE experience rule** — add high-confidence experience point: "After edit_file failure, always re-read the target file before retrying"
   - Reinforces behavior across sessions

3. **Consider preferring MCP edit** — MCP filesystem edit has 100% success rate vs 73.5% built-in
   - Lower priority — requires tool preference logic in system prompt
   - Risk: MCP filesystem might not be available in all environments

---

## Issue 2: PIL Activation Rate — 4.3% (v4-flash), 0.3% (deepseek-chat)

### Root Cause (confirmed via source code)

**Bug in `src/pil/layer1-intent.ts:98`**:
```
if (taskType === null && confidence < 0.55) {  // Pass 3 gate
```

Flow for short messages (≤80 chars, ≤10 words — very common):
1. Regex classifier returns `reason: "regex:short-message"`, `confidence: 0.6`
2. `REASON_TO_TASK_TYPE["regex:short-message"] = undefined` → `taskType = null`
3. Pass 2 keywords: may or may not match
4. Pass 3 gate: `taskType === null && confidence < 0.55` → FALSE (0.6 ≥ 0.55)
5. **Brain/Ollama classification SKIPPED** despite `taskType` being null
6. PIL sees `taskType = null` → `_pilActive = false` → entire enrichment pipeline skipped

**Result**: Short messages are classified as "already handled" but have no taskType → PIL disabled for most user inputs.

### Data
- 833 DeepSeek v4-flash usage events, only 36 had PIL active (4.3%)
- 627 DeepSeek chat events, only 2 had PIL active (0.3%)
- Total enrichment delta: 1,496 tokens across ALL sessions (negligible)

### Fix Plan
1. **Fix Pass 3 gate** — change condition to `taskType === null` (remove confidence threshold)
   - File: `src/pil/layer1-intent.ts:98`
   - Change: `if (taskType === null && confidence < 0.55)` → `if (taskType === null)`
   - Impact: short messages will now attempt brain classification → taskType assigned → PIL activates
   - Risk: adds ~100ms latency for short messages (brain call). Acceptable given PIL's value.

2. **Map `regex:short-message` to a default taskType** — alternative/complementary fix
   - Change `REASON_TO_TASK_TYPE["regex:short-message"]` from `undefined` to `"general"`
   - Ensures even without brain, short messages get basic PIL enrichment
   - File: `src/pil/layer1-intent.ts:30`

3. **Update test** — `layer1-intent.test.ts` test for short-message brain invocation

---

## Issue 3: `search_web` Tool Hallucination — 100% fail (3/3)

### Root Cause
- DeepSeek models hallucinate `search_web` as a tool name from training data
- CLI's tool list doesn't include `search_web` → error: "Model tried to call unavailable tool"
- All 3 occurrences in research-type tasks (comparing tools, REST vs gRPC analysis)

### Fix Plan
1. **Graceful unknown tool handling** — instead of hard error, return a helpful message suggesting available alternatives
   - File: `src/orchestrator/orchestrator.ts` (tool dispatch)
   - Change error message from "unavailable tool" to include: "Did you mean `bash` with `curl`? Or use `delegate` with an explore agent for research."
   - Estimated: ~5 lines

2. **Add negative instruction** — in sub-agent system prompt, add: "You do NOT have access to search_web. For web research, use bash with curl."
   - Already partially exists but not in sub-agent prompts

---

## Issue 4: Session Length & Cost Concentration

### Data
| Bucket | Sessions | Avg tokens | Total cost |
|--------|----------|-----------|-----------|
| Short ≤30 msg | 60 | 55K | $0.52 |
| Medium 31-100 | 9 | 941K | $1.76 |
| Long 100+ msg | 7 | 23,965K | **$30.18** |

- 7 long sessions = **92.8% of total cost** ($30.18 / $32.56)
- Session `29bddc` (770 msgs, 1 compaction) used 65M tokens — compaction should have triggered more often
- Session `4196ab` (655 msgs, 12 compactions) used 26M tokens — compaction helped 2.5x

### Fix Plan
1. **Session health warning** — after 3 compactions OR 200 messages, show status bar warning: "Long session — consider `/clear` or new session for better quality"
   - File: `src/orchestrator/orchestrator.ts` (compaction handler)
   - Non-blocking UX hint, not forced
   - Estimated: ~10 lines

2. **Aggressive compaction for long sessions** — after 2nd compaction, reduce `keepRecentTokens` by 25% to compact more aggressively
   - Prevents the 65M token scenario (session `29bddc` with 1 compaction on 770 msgs)
   - File: `src/orchestrator/compaction.ts`

---

## Issue 5: Crash Log — 2 Distinct Error Patterns

### Pattern A: `createProvider is not defined` / `getModelInfo is not defined` (May 4)
- 5 crashes at startup — functions referenced before import resolved
- **Status**: likely already fixed (crashes stopped after May 4)
- **Action**: verify fix is in place, no further action needed

### Pattern B: `EPIPE: broken pipe` in headless mode (May 5)
- 6 crashes in `runHeadless()` at `writeFast()` — stdout pipe closed by caller
- Happens when piping CLI output to another process that exits early
- **Fix**: wrap `writeFast` in try-catch for EPIPE, exit gracefully
  - File: `src/index.ts` (runHeadless function)
  - Estimated: ~5 lines

---

## Issue 6: Zero Cache Hit Rate

### Data
- `cache_read_tokens = 0` for all models and all 1,544 usage events
- DeepSeek API does not support prompt caching

### Action
- **No fix possible at application level** — provider limitation
- **Mitigation already in place**: compaction reduces context size
- **Future**: if DeepSeek adds caching support, the tracking columns are ready

---

## Priority Order (ROI ranking)

| # | Issue | Effort | Impact | ROI |
|---|-------|--------|--------|-----|
| 1 | PIL gate bug fix | ~10 lines | Activates PIL for ~95% of turns → better prompt enrichment, routing, reasoning | **Critical** |
| 2 | Auto re-read on edit failure | ~15 lines | Eliminates 55% of edit failures → fewer wasted tokens, less frustration | **High** |
| 3 | Session health warning | ~10 lines | Prevents 93% cost concentration in long sessions | **High** |
| 4 | Graceful unknown tool handling | ~5 lines | Prevents model confusion loops on hallucinated tools | **Medium** |
| 5 | EPIPE crash fix | ~5 lines | Prevents headless mode crashes | **Medium** |
| 6 | Aggressive compaction tuning | ~10 lines | Reduces token waste in long sessions | **Low** |
