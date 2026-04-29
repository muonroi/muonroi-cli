---
phase: "00"
plan: "02"
subsystem: fork-skeleton
tags: [deletion, refactor, fork, grok-cli, cleanup]
dependency_graph:
  requires: [00-01]
  provides: [clean-src-tree, tsc-clean-baseline]
  affects: [00-03, 00-04, 00-05]
tech_stack:
  added: []
  patterns: [fork-02-stub-pattern, inline-not-implemented-error]
key_files:
  created: []
  modified:
    - src/agent/agent.ts
    - src/agent/compaction.ts
    - src/index.ts
    - src/storage/usage.ts
    - src/ui/agents-modal.tsx
    - src/ui/app.tsx
    - src/utils/settings.ts
    - src/utils/side-question.ts
  deleted:
    - src/telegram/ (16 files)
    - src/audio/ (3 files)
    - src/wallet/ (2 files)
    - src/payments/ (5 files)
    - src/grok/ (10 files + tests)
    - src/agent/vision-input.ts
    - src/agent/vision-input.test.ts
    - src/agent/batch-mode.test.ts
    - src/ui/telegram-turn-ui.ts
    - src/ui/telegram-turn-ui.test.ts
decisions:
  - "agent.ts grok-client call sites stubbed with NotImplementedError (not deleted) so tsc graph stays intact — Anthropic adapter wires in plan 00-05"
  - "payments/brin dynamic import in agent.ts replaced with undefined stub (payment pre-check block removed)"
  - "batch-mode.test.ts deleted per Pitfall 18 — test of deleted grok/batch has no value"
  - "settings.ts and app.tsx retain Telegram type exports (they compile clean; UI wiring removal is plan 00-05/00-06)"
metrics:
  duration: "45 minutes"
  completed_date: "2026-04-29"
  tasks: 2
  files_changed: 52
---

# Phase 00 Plan 02: Strip grok-cli out-of-scope surface Summary

**One-liner:** Deleted ~5,523 LOC of grok-cli-specific code (telegram bot, STT audio, Coinbase wallet/payments, vendor-locked xAI grok client, vision-input, UI helpers) in a single combined commit; patched 8 consumer files with FORK-02 stubs; `bunx tsc --noEmit` exits 0.

## Objective Achieved

Per FORK-02 and Pitfall 18, the following directories and files were removed from `src/`:

| Surface | Files Removed | LOC |
|---------|--------------|-----|
| `src/telegram/` | 16 files (bridge, headless-bridge, audio-input, pairing, limits, etc.) | ~1,200 |
| `src/audio/` | 3 files (stt engine, grok-stt) | ~300 |
| `src/wallet/` | 2 files (manager, types) | ~115 |
| `src/payments/` | 5 files (service, history, brin, agentkit-loader, types) | ~435 |
| `src/grok/` | 10 files + 9 test files (batch, client, models, tools, media, tool-schemas, lsp-tools) | ~2,870 |
| `src/agent/vision-input.{ts,test.ts}` | 2 files | ~157 |
| `src/agent/batch-mode.test.ts` | 1 file (test of deleted grok/batch) | ~130 |
| `src/ui/telegram-turn-ui.{ts,test.ts}` | 2 files | ~159 |
| **Total** | **44 files deleted** | **~5,366 LOC removed** |

**Net change:** 52 files changed, 298 insertions(+), 5821 deletions(−) — commit `aedfeb1`.

## Consumer Files Patched

8 files had imports of deleted modules removed and replaced with FORK-02 stubs:

| File | Deleted Import | Stub Strategy |
|------|---------------|---------------|
| `src/agent/agent.ts` | `../grok/batch`, `../grok/client`, `../grok/models`, `../grok/tool-schemas`, `../grok/tools`, `./vision-input` | Inline stub types + functions; all throw `NotImplementedError` mentioning FORK-02/plan 00-05 |
| `src/agent/compaction.ts` | `../grok/client` | Imports stubs from `./agent`; local `resolveModelRuntime` stub throws |
| `src/index.ts` | `./grok/models`, `./telegram/headless-bridge` | Pass-through stubs; telegram-bridge command + wallet commands removed |
| `src/storage/usage.ts` | `../grok/models` | Local `getModelInfo()` stub returns `undefined` (cost estimates 0) |
| `src/ui/agents-modal.tsx` | `../grok/models` | Empty `MODELS` array constant |
| `src/ui/app.tsx` | `../grok/models`, `../telegram/bridge`, `../telegram/pairing`, `../telegram/turn-coordinator`, `./telegram-turn-ui` | Full stub block after imports; wallet dynamic import replaced with no-op |
| `src/utils/settings.ts` | `../grok/models` | Pass-through stubs for `normalizeModelId`, `getModelIds`, `getEffectiveReasoningEffort` |
| `src/utils/side-question.ts` | `../grok/client` | Imports stubs from `../agent/agent`; local `resolveModelRuntime` stub throws |

## Stubbed Call Sites in agent.ts (Plan 00-05 Wire Points)

The following call sites in `src/agent/agent.ts` are now stubs that throw `NotImplementedError` mentioning plan 00-05:

| Location (approx line) | Former grok-client function | Stub behavior |
|------------------------|----------------------------|---------------|
| `setApiKey()` → `createProvider()` | `createProvider(apiKey, baseURL)` | Throws — no provider until plan 00-05 |
| `generateTitle()` → `genTitle()` | `generateTitle(provider, msg)` | Throws — returns "New session" fallback |
| `resolveModelRuntime()` (batch mode) | `resolveModelRuntime(provider, modelId)` | Throws — batch mode disabled |
| `createTools()` | `createTools(bash, provider, mode, opts)` | Throws — all tool creation disabled |
| `buildVisionUserMessages()` | `buildVisionUserMessages(prompt, cwd)` | Throws — vision mode disabled |
| `payments/brin` (dynamic import) | `scanUrl(url)` | Removed entirely; `paymentPrecheck = undefined` |

The class `Agent` holds `provider: XaiProvider | null = null` where `XaiProvider = any` (FORK-02 stub). Until plan 00-05 calls `setApiKey()` with a real Anthropic provider, all provider-dependent methods are non-functional but compilable.

## Orphan Dependencies (Flagged for Plan 00-04)

These packages remain in `package.json` but serve no remaining code:

| Package | Was used by |
|---------|-------------|
| `@ai-sdk/xai` | `src/grok/client.ts` |
| `@coinbase/agentkit` | `src/payments/agentkit-loader.ts` |
| `grammy` | `src/telegram/bridge.ts` |
| `agent-desktop` | `src/grok/tools.ts` (computer tools) |

Formal removal of these deps is plan 00-04 (deps-swap commit).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `src/agent/agent.ts` had dynamic import of `../payments/brin`**
- **Found during:** Task 2 consumer scan
- **Issue:** `agent.ts` had a dynamic `import("../payments/brin")` inside a `tool-approval-request` handler — not caught by the static grep because it was a dynamic import. File was deleted with `src/payments/`.
- **Fix:** Replaced entire `if (approvalPart.toolCall?.toolName === "paid_request")` block with `paymentPrecheck = undefined` and a FORK-02 comment.
- **Files modified:** `src/agent/agent.ts` (line ~2100-2142)
- **Commit:** `aedfeb1`

**2. [Rule 3 - Blocking] `bun install` needed before `bunx tsc --noEmit`**
- **Found during:** Task 2 typecheck
- **Issue:** `node_modules/` was absent — dependencies had never been installed in the repo.
- **Fix:** Ran `bun install` (618 packages installed).
- **Impact:** None on plan output; this was a missing prerequisite.

**3. [Rule 1 - Bug] `XaiProvider = any` stub needed for tsc to compile agent.ts**
- **Found during:** Task 2 typecheck
- **Issue:** Initial stub `XaiProvider` had callable members typed as `never`, causing cascade errors throughout agent.ts (`model: never` in `ResolvedModelRuntime` broke `streamText()` calls, etc.).
- **Fix:** Widened `XaiProvider = any` and `ResolvedModelRuntime.model: any` with `eslint-disable` comments. Model info fields use `ModelInfoStub` interface with optional properties.
- **Justification:** FORK-02 intent is "tsc compiles, runtime throws" — not type-safety of deleted code paths.

## Known Stubs

The following stubs flow into UI rendering but are intentionally empty for this plan:

| File | Stub | Reason |
|------|------|--------|
| `src/ui/app.tsx` | `MODELS = []` | Real model list ships in plan 00-05 (PROV-03) |
| `src/ui/app.tsx` | `createTelegramBridge` returns null | Telegram deleted; no replacement until muonroi-cli Phase 2+ |
| `src/ui/app.tsx` | `buildAssistantEntry`, `buildUserEntry`, etc. | Telegram turn UI deleted; UI uses these for local turns too — plan 00-05/06 rewires |
| `src/index.ts` | `MODELS = []` for `models` command output | Same — plan 00-05 |
| `src/storage/usage.ts` | `getModelInfo` returns `undefined` → cost = 0 | Cost estimation disabled until plan 00-05 |

These stubs do NOT prevent plan 00-02's goal (clean src tree + tsc passes). The UI is intentionally non-functional between this plan and 00-05. Plan 00-07 (TUI boot smoke) validates TUI functionality after 00-05 and 00-06 land.

## Self-Check: PASSED

Verified:
- `bunx tsc --noEmit` exits 0 (no output = no errors)
- Commit `aedfeb1` exists: `git log --oneline | head -1` = `aedfeb1 refactor(fork): strip telegram/audio/wallet/payments/grok/vision-input`
- `src/telegram/`, `src/grok/`, `src/audio/`, `src/wallet/`, `src/payments/` absent from working tree
- `src/agent/vision-input.ts` absent
- Zero real `import ... from ".../(telegram|audio|wallet|payments|grok|agent/vision-input|ui/telegram-turn-ui)"` lines in `src/`
- `git show --stat HEAD` includes all 5 directory deletions and standalone file deletions
