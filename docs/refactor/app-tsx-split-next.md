# `src/ui/app.tsx` Split — Next Wave

> **Status:** Plan only. No code changes yet.
> **Author audit date:** 2026-05-20
> **Current size:** 6,202 LoC (single file)
> **Goal:** Continue the extraction trend started by `useAgentEditor`, `useMcpEditor`, `useModelPicker` (commits `79bf22e`, `af9ba52`, `b83ff0e`). Bring `app.tsx` under ~3,000 LoC across the next 3–5 PRs while preserving harness E2E coverage.

---

## Background

`src/ui/app.tsx` is the single React entry component for the TUI. Recent commits have begun pulling self-contained `useState`/`useCallback`/`useEffect` clusters into dedicated hooks under `src/ui/hooks/`:

- `use-model-picker.ts` — model picker state (idx, search, focus, provider chips, disabled sets, reasoning effort by model)
- `use-mcp-editor.ts` — MCP browse/editor state + setters
- `use-agent-editor.ts` — Subagent + Schedule modal state

What remains in `app.tsx` (6.2K LoC) still mixes:

1. ~120 `useState` / `useRef` declarations
2. A 1,000+ line `processMessage` callback (live-turn pipeline)
3. A 1,600+ line `handleKey` keyboard router covering 6+ overlay forms
4. A 700+ line `handleCommand` slash dispatcher
5. A 500+ line `handleSlashMenuSelect` menu router
6. A 500+ line JSX tree mixing home/messages branches with 10+ modal overlays
7. Telegram bridge wiring (stubbed but still ~200 LoC)
8. Toast/EE-event subscriber, copy/paste/clipboard handling, API-key modal lifecycle

This plan picks the next 5 highest-value extraction targets, ordered by ROI / risk ratio.

---

## Targets

### Target 1 — `useLiveTurn` hook (live-turn pipeline state + helpers)

**Lines (approx):** 666–895, 1657–1842, plus refs at 882–900

**What it owns:**
- `streamContent`, `_streamReasoning`, `isProcessing`, `liveTurnSourceLabel`, `activeToolCalls`, `activeSubagent`
- Refs: `contentAccRef`, `startTimeRef`, `activeRunIdRef`, `interruptedRunIdRef`, `activeTurnRef`, `isProcessingRef`, `coordinatorRef`
- Callbacks: `clearLiveTurnUi`, `beginLiveTurn`, `flushPendingAssistantMessage`, `applyLocalAssistantDelta`, `applyTelegramAssistantPreview`, `showLiveToolCalls`, `appendLiveToolResult`, `finishTurnProcessing`, `finalizeActiveTurn`
- Queue: `queuedMessagesRef`, `queuedMessages`, `processMessageRef`

**Rationale:** This is the single largest cohesive cluster in the file (~400 LoC including refs and helpers). It is the heart of the streaming-turn lifecycle and is referenced by `processMessage`, the council branches in `handleCommand`, all Telegram event handlers, and `interruptActiveRun`. Today these are scattered helpers; they pass `agent`, `setMessages`, `scrollToBottom` as deps to `useCallback`. A hook centralises the contract.

**Extraction shape:** Hook
```ts
// src/ui/hooks/use-live-turn.ts
export function useLiveTurn(args: {
  agent: Agent;
  setMessages: Dispatch<SetStateAction<ChatEntry[]>>;
  scrollToBottom: () => void;
  setActivePlan: Dispatch<SetStateAction<Plan | null>>;
  setPqs: Dispatch<SetStateAction<PlanQuestionsState>>;
}) {
  // returns { streamContent, isProcessing, activeToolCalls, activeSubagent,
  //   liveTurnSourceLabel, beginLiveTurn, finalizeActiveTurn,
  //   applyLocalAssistantDelta, applyTelegramAssistantPreview,
  //   showLiveToolCalls, appendLiveToolResult, flushPendingAssistantMessage,
  //   clearLiveTurnUi, queueMessage, processMessageRef, activeTurnRef,
  //   activeRunIdRef, interruptedRunIdRef, isProcessingRef }
}
```

**Risk:** Medium. Many refs cross into `processMessage` and `interruptActiveRun`; the hook must expose them as stable refs (not values). The Telegram-specific `syncTelegramTurnEntries` branch inside `finalizeActiveTurn` reaches into `telegramEntryCountsRef`, so we either pass a `syncRemoteEntries?: (turn: ActiveTurnState) => void` callback or extract Telegram first (Target 4).

---

### Target 2 — `useHarnessToast` hook (Phase 21 toast subscriber)

**Lines:** 522–618

**What it owns:**
- `activeToast` state + `toastIdRef` + `eeToastSeenSessionsRef` + `lastBootSessionIdRef`
- `pushToast`, `handleHarnessEvent`, `dismissToast` callbacks
- Two `useEffect`s: session-id polling (5K ms interval), `agentRuntime.emitEvent` monkey-patch with teardown

**Rationale:** Cleanest self-contained boundary in the file. ~95 LoC with a clear contract: input = `agentRuntime` + `agent`, output = `{ activeToast, pushToast, dismissToast }`. Single external use site (`Toast` component in render tree, `pushToast` from `/ee-context` slash command). No shared refs with the rest of the app.

**Extraction shape:** Hook
```ts
// src/ui/hooks/use-harness-toast.ts
export function useHarnessToast(args: {
  agent: Agent;
  agentRuntime: AgentModeRuntime | undefined;
}): {
  activeToast: { level: ToastLevel; text: string; id: number } | null;
  pushToast: (level: ToastLevel, text: string) => void;
  dismissToast: () => void;
}
```

**Risk:** Low. Pure side-effect + state; only `pushToast` is read by `handleCommand` (`/ee-context` branch). Trivial harness coverage — existing `events.spec.ts` exercises the toast event path.

---

### Target 3 — `useFormOverlayKeys` hook (overlay form key router)

**Lines:** 3859 → ~5481 (the bulk of `handleKey`'s 1,600 LoC body). Specifically the per-overlay sub-routers:

- `pointToExistingForm` keys: 3862–3936
- `initNewForm` keys (multiple steps: name → fe-stack → designing → design-preview → bb-template → ...): 3938–~4500
- `activeHaltCard` keys
- Wallet/sandbox/connect/telegram pair/token modal keys
- Plan questions panel keys

**Rationale:** `handleKey` is the second-largest blob and the riskiest to touch — it owns ALL keyboard precedence for the TUI. Splitting it by overlay (each overlay = independent sub-router function returning `boolean` for "handled") is the long-tail reduction that drops `app.tsx` by ~1,500 LoC.

**Extraction shape:** Multiple small functions or a single hook with a router array.

```ts
// src/ui/hooks/use-form-overlay-keys.ts
// returns a handler that runs each sub-router in priority order and returns
// true on first handled key. Sub-routers are PURE functions over (key, state, setState).
export function useFormOverlayKeys(args: { ... }): (key: KeyEvent) => boolean
```

Or, lower-risk first pass: extract just the `pointToExistingForm` and `initNewForm` sub-routers into `src/ui/forms/` as pure `handleXxxFormKey(key, form, setForm): boolean` functions and call them from the existing `handleKey`.

**Risk:** High. Keyboard precedence is subtle (ref-mirrors, escape handling, "burst" timing). Best done after `useLiveTurn` and `useHarnessToast` reduce the surface area. Extract one form at a time (init-new first, since it's the largest and has the cleanest state-machine boundary via `initNewForm.step`).

---

### Target 4 — `useTelegramBridge` hook (Telegram wiring)

**Lines:** 205–219 (stubs at top of file), 1782–2002, 2207–2302

**What it owns:**
- `telegramAgentsRef`, `telegramEntryCountsRef`, `telegramSubagentUnsubsRef`, `bridgeRef`
- `showConnectModal`, `showTelegramTokenModal`, `showTelegramPairModal`, `telegramTokenError`, `telegramPairError`, `connectModalIndex` state
- Callbacks: `wireTelegramAgentUi`, `getTelegramAgent`, `appendTelegramUserMessage`, `upsertTelegramAssistantMessage`, `showTelegramToolCalls`, `appendTelegramToolResult`, `startTelegramBridge`, `syncTelegramTurnEntries`, `submitTelegramToken`, `submitTelegramPair`, `beginTelegramFromConnect`
- Two `useEffect`s for bridge auto-start and cleanup
- Three ref-mirroring `useEffect`s for the modal visibility refs

**Rationale:** Telegram is currently entirely stubbed (top of file: `createTelegramBridge` returns `null`, `approvePairingCode` always errors). Despite being disabled it accounts for ~300 LoC of state + callbacks. Extracting it both shrinks `app.tsx` and isolates the feature for easier reactivation or full removal.

**Extraction shape:** Hook
```ts
// src/ui/hooks/use-telegram-bridge.ts
export function useTelegramBridge(args: {
  agent: Agent;
  startupConfig: AppStartupConfig;
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
  hasApiKey: boolean;
  liveTurn: ReturnType<typeof useLiveTurn>;
  setMessages: Dispatch<SetStateAction<ChatEntry[]>>;
  scrollToBottom: () => void;
  openApiKeyModal: () => void;
}): {
  modals: { showConnectModal, showTelegramTokenModal, showTelegramPairModal, ... };
  actions: { beginTelegramFromConnect, submitTelegramToken, submitTelegramPair, dismissConnect, ... };
  refs: { telegramTokenInputRef, telegramPairInputRef };
}
```

**Risk:** Low–Medium. Telegram is stubbed end-to-end today, so harness coverage is zero. The only correctness concern is that `processMessage`/`interruptActiveRun` still need to operate on `activeTurnRef.kind === "telegram"` turns — these reads stay in `useLiveTurn`. Order this AFTER Target 1 so the bridge consumes `liveTurn.beginLiveTurn` etc.

---

### Target 5 — Extract message log render block as `<MessageLog>` component

**Lines:** 5690–5894 (the scrollbox + all council/halt/plan rendering inside the `hasMessages` branch)

**What it renders:**
- `messages.map(...)` → wrapped `MessageView` items
- `liveTurnSourceLabel` banner
- `activeToolCalls.map(...)` (SubagentTaskLine / DelegationTaskLine / InlineTool)
- `activeSubagent` activity
- `councilPhases`, `councilStatuses`, `councilInfoCards`, `councilMessages`, `councilPlaceholders`
- `pendingCouncilQuestion`/`pendingCouncilPreflight` cards
- `streamContent` markdown
- "Planning next moves" shimmer
- `showPlanPanel`, `pendingPaymentApproval`
- `activeHaltCard`, `initNewForm`, `pointToExistingForm`, `councilProgress`

**Rationale:** Pure render block, ~205 LoC. Reads from a stable set of state values; emits no setState. Lifting it into `src/ui/components/message-log.tsx` reduces the `App()` body and creates a natural seam for the `<SemanticProvider>` boundary (the entire `id="log"` Semantic subtree moves out).

**Extraction shape:** Component
```tsx
// src/ui/components/message-log.tsx
export function MessageLog(props: {
  t: Theme; messages: ChatEntry[]; modeInfo: Mode; expandedMessages: Set<number>;
  scrollRef: RefObject<ScrollBoxRenderable>;
  liveTurnSourceLabel: string | null;
  activeToolCalls: ToolCall[]; activeSubagent: SubagentStatus | null;
  streamContent: string; isProcessing: boolean;
  councilPhases, councilStatuses, councilInfoCards, councilMessages, councilPlaceholders;
  pendingCouncilQuestion, councilCardState, pendingCouncilPreflight, preflightCardState;
  showPlanPanel: boolean; planQuestions: PlanQuestion[]; pqs: PlanQuestionsState;
  pendingPaymentApproval; activeHaltCard; haltSelectedIndex; initNewForm; pointToExistingForm; councilProgress;
  productStatus; width: number;
  resolveStyle: ReturnType<typeof useRolePalette>;
  getSide: ReturnType<typeof usePairSideMap>;
  getPartnerLast: ReturnType<typeof usePairQuoteBuffer>["getPartnerLast"];
}): JSX.Element
```

**Risk:** Low (mechanical), but **prop list is large** (~25 props). Should land AFTER Targets 1+4 so several of those props collapse into hook-returned objects (e.g. `liveTurn.streamContent`, `telegram.modals`).

---

## Extraction order

| # | Target | Est. LoC out | Risk | Why this order |
|---|---|---|---|---|
| 1 | `useHarnessToast` | ~95 | Low | Smallest, cleanest, no cross-cutting refs. Builds confidence + tooling pattern. |
| 2 | `useLiveTurn` | ~400 | Medium | Unblocks Targets 3, 4, 5 by collapsing their dep lists. Largest single ROI. |
| 3 | `useTelegramBridge` | ~300 | Low–Medium | Depends on Target 2. Pure isolation of a stubbed feature. |
| 4 | `<MessageLog>` component | ~205 | Low | Props list shrinks substantially once 2 + 3 land. Mechanical lift. |
| 5 | `useFormOverlayKeys` (init-new first, then others) | ~1,500 across multiple PRs | High | Last because it requires the strongest harness coverage and most careful key-precedence preservation. |

**Total file reduction after all five:** ~2,500 LoC → `app.tsx` lands near ~3,700 LoC, mostly orchestration + remaining `handleCommand` + `handleSlashMenuSelect` (those are next-next-wave candidates).

---

## Risks

### Cross-cutting risks
- **Ref identity**: hooks must return refs (not values) when the consumer needs synchronous reads — pattern already established by `setShowSlashMenuSync`, `setCouncilCardStateSync`. Document in each hook header.
- **Harness regressions**: `<Semantic>` wrappers in the render tree (`id="log"`, `id="composer"`, `id="msg-{i}"`, `id="council-phases"`, `id="askcard"`, `id="ideal-halt-card"`, `id="init-new-card"`) must remain at the same DOM positions. Target 4 is the only one that touches them — leave the Semantic IDs intact, only the JSX file location changes.
- **biome-ignore comments**: the existing useExhaustiveDependencies suppressions assume "stable useState setters from hook X". When code moves into a new hook, those comments must move with the consumer or be re-justified.

### Per-target risks
- **Target 2 (useLiveTurn)**: `coordinatorRef` is created at module-init via `createTurnCoordinator()` which is currently a stub (`reset/handleEvent/run` no-ops). Verify no real implementation is pending in `agent/turn-coordinator.ts` before committing to the hook signature.
- **Target 3 (useTelegramBridge)**: `useEffect` ordering — bridge auto-start (line 2005) depends on `hasApiKey` AND the bridge stop cleanup must run AFTER the live-turn cleanup. Hook return order must preserve this.
- **Target 5 (useFormOverlayKeys)**: never extract `handleKey` wholesale — break it down per overlay. The composer typeahead branch (typeaheadRef) must stay in `app.tsx` because it depends on the same `inputRef` as `handleSubmit`/`handlePaste`.

---

## Verification

For every PR in this series:

### Mandatory
1. `bunx tsc --noEmit` — 0 errors.
2. `bunx vitest run src/ui/` — all UI unit tests pass.
3. `bunx vitest -c vitest.harness.config.ts run tests/harness/` — full harness E2E pass on Windows (named pipes).
4. `bun run lint:semantic` — confirms no new unwrapped `<Semantic>` roots; allowlist not extended without justification.
5. `bun run lint:harness-skips` — does not exceed allow-threshold.

### Per-target spot checks
- **Target 1 (useHarnessToast)**: `tests/harness/events.spec.ts` — verify `toast` event still surfaces. Add a unit test for `pushToast` deduplication on `ee-timeout`.
- **Target 2 (useLiveTurn)**: `tests/harness/composer.spec.ts`, `tests/harness/ideal.spec.ts` — full live-turn lifecycle still drives correctly. Manually exercise Esc-interrupt twice (stage 1 queue clear, stage 2 abort).
- **Target 3 (useTelegramBridge)**: no harness coverage exists (Telegram stubbed). Run `bun run src/index.ts --smoke-boot-only` and confirm no startup regression. Open `/remote-control` and walk through the modal sequence.
- **Target 4 (MessageLog component)**: `tests/harness/composer.spec.ts` (Semantic id=log present), `tests/harness/scroll.spec.ts` if/when it stops being `it.todo`. Manual smoke: send a message, watch council, trigger halt card.
- **Target 5 (form overlay keys)**: requires DEDICATED harness specs before extraction. Pre-extraction PR should add:
  - `tests/harness/init-new-form.spec.ts` — name → fe-stack → designing happy path + escape backtrack
  - `tests/harness/point-to-existing.spec.ts` — input → loading → error and input → done flows
  - `tests/harness/halt-card.spec.ts` (extends existing `events.spec.ts` patterns)

### Rollback criteria
- Any harness spec regression → revert the offending PR (do not patch forward).
- Any `processMessage` chunk-handling regression → revert (this is the live-turn pipeline; correctness > size).
- Visual regression in the message log layout → revert (the scrollbox sticky-bottom semantics are subtle).

---

## Out of scope (parked for next-next wave)

- `handleCommand` slash dispatcher (~700 LoC) — needs to move to a registry pattern that subsumes the inline switch + the existing `dispatchSlash`. Larger architectural change.
- `handleSlashMenuSelect` (~500 LoC) — overlap with `handleCommand`; address together.
- `processMessage` chunk router — the giant switch over `chunk.type` (lines 2434–2660) is structurally identical to the three other chunk-handling sites in `handleCommand` (`/ideal`, `/council`, fallback). Worth a unified `useChunkRouter` hook in a later wave.
- Move `_formatStructuredResponse` and `getPasteBlockToken` / `getFileMentionToken` helpers to `./utils/`.
- Type aliases at top of file (`TelegramBridgeHandle`, `parseCustomSubagentSlashCommand`, etc.) → `./telegram-stub.ts`.
