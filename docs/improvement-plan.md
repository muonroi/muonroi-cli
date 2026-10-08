# Muonroi-CLI Improvement Plan

> Generated: 2026-10-06
> Scope: Cost, reliability, developer experience

---

## High — Direct output quality impact

### 1. Metered gate audit (cost leak root cause)

- **File**: `src/providers/model-gate.ts`, `src/orchestrator/tool-engine.ts`
- **Why**: Session `526a83cf22df` logged **2.44M input tokens** on 46 LLM calls in 3 turns (82% of budget). BUG-A/BUG-C/BUG-H in `tool-engine.ts:690/1320/2015` show 10+ prior patches, cost leak keeps recurring.
- **Fix**: Re-run the 3 SQL views from `CLAUDE.md` against fresh session data. Verify `wrapToolSetWithCap` actually fires on every `doStream`/`doGenerate`. Add a hard assertion that `estInputTokens > ceiling` always triggers `throwHit=1` for throw-eligible stages.

### 2. System prompt "instruction bloat"

- **File**: `src/orchestrator/prompts.ts:245-407` (`buildSystemPrompt`)
- **Why**: ~17K system tokens per turn. Contract + native capabilities + PIL layers + GSD + delegation + token budget rules are concatenated into one oversized block. Cheap models (DeepSeek/Qwen) reliably drop rules that appear after the first ~8K tokens.
- **Fix**: Collapse duplicate rules across layers. Move rarely-fired guardrails (push-block, staging-check) out of the always-on system prompt and into pre-tool hooks only. Apply the Ponytail Rule: "code you never wrote is the best code" — delete redundant sections rather than adding more structure.

### 3. Mutation gate advisory mode for `standard` tier

- **File**: `src/gsd/mutation-gate.ts:26-49`
- **Why**: Gate is hard-block only for `heavy`. `standard` and `quick` both fail-open. A task misclassified as `standard` (should be `heavy`) runs without any plan-review guard and can make destructive edits before the assessor upgrades it.
- **Fix**: Add an advisory warning for `standard` — emit a visible log + a `GATE_DIRECTIVE` advisory (not a block) so the agent self-corrects before editing. Keep `heavy` as the hard block.

---

## Medium — Reliability and DX

### 4. Resolve `FIXME(WhoAmI-L5)` in `layer5-context`

- **File**: `src/pil/layer5-context.ts:9`
- **Why**: `work_patterns.multitasking` (sequential-deep vs task-switcher) is deferred. This signal could adjust the compaction cadence and tool-loop cap per-user-preference, but it's silently dropped today.

### 5. Shell mismatch detection hardening

- **File**: `src/orchestrator/prompts.ts:86-97` (ENVIRONMENT block)
- **Why**: Sessions `f9a4cea1bf44`, `9c63a38197f3`, `d0dc4a1f542a`, `77cd2e11c6a5`, `1bc27b79223c` all logged shell-mismatch errors despite the fix. The block may be too verbose or the model skips to the tool section without reading it.
- **Fix**: Move the shell constraint to a **pre-tool wrapper** on bash, not just a system-prompt instruction. The bash tool itself should reject PowerShell/cmd.exe syntax before execution with a clear error message.

### 6. Deprecated `PaymentSettings` cleanup

- **File**: `src/utils/settings.ts:60-79, 1934 lines total`
- **Why**: `PaymentSettings` / `PaymentApprovalSettings` marked `@deprecated Phase 4` since 2026-07. Phase 4 is not shipping. Dead code in a 1934-line file adds maintenance burden and risks accidental imports.
- **Fix**: Delete the deprecated types and the `payment` field from `UserSettings`. Shrink settings.ts by ~50 lines.

### 7. Cross-turn dedup effectiveness metric

- **File**: `src/orchestrator/tool-engine.ts:47` (C3 wrap)
- **Why**: Dedup is listed as a fix direction in `CLAUDE.md` but has no measurement. No telemetry records how many tool calls are skipped per turn.
- **Fix**: Add a counter to `wrapToolSetWithDedup` — emit `dedup.skipped_calls` per turn to `interaction_logs`. Target: ≥30% dedup rate on long sessions.

---

## Low — Incremental polish

### 8. `arg-guard.ts` `"TODO"` fallback

- **File**: `src/tools/arg-guard.ts:214`
- **Fix**: Replace `"TODO"` with `"string"` (safe default) or `null` with a logged warning.

### 9. Grep hardcoded limits

- **File**: `src/tools/grep.ts:7-8` (`MAX_MATCHES = 100`, `MAX_LINE_LENGTH = 2000`)
- **Fix**: Read limits from `UserSettings` or env vars. Allow `MUONROI_GREP_MAX_MATCHES` / `MUONROI_GREP_MAX_LINE_LENGTH`.

### 10. Tool output truncation logging

- **File**: `src/tools/registry.ts:173-175`
- **Fix**: Log `truncation.occurrences` per session to `interaction_logs`. Alert when >10% of tool outputs are truncated (indicates cap is too tight).

---

## Execution order (smallest correct change first)

| # | Item | Est. effort | Risk |
|---|------|-------------|------|
| 6 | Delete deprecated PaymentSettings | 30 min | Low |
| 9 | Grep limits via env | 30 min | Low |
| 8 | arg-guard TODO → safe default | 15 min | Low |
| 10 | Truncation logging | 45 min | Low |
| 3 | Standard-tier advisory gate | 1 h | Medium |
| 7 | Dedup effectiveness metric | 1 h | Medium |
| 4 | WhoAmI-L5 multitasking | 2 h | Medium |
| 5 | Shell mismatch pre-tool hook | 2 h | Medium |
| 1 | Metered gate audit + assertions | 3 h | High |
| 2 | System prompt bloat reduction | 4 h | High |
