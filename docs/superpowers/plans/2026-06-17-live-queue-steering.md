# Live Queue Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message typed while a turn is streaming is injected into the running turn as a `user` interjection at the next `prepareStep` boundary (Claude-Code-style steering), instead of waiting for the turn to finish.

**Architecture:** The UI already queues mid-turn submits in `queuedMessagesRef` (drained only post-turn by `finishTurnProcessing`). We expose that queue to the running turn via a new `Agent.setSteerDrain(fn)` callback wired into `MessageProcessorDeps.drainSteerMessages`. The top-level `prepareStep` (which already rewrites messages mid-run for compaction/reminders) drains the queue once per step (sn≥1), appends the drained messages to a turn-scoped `pendingSteers` accumulator, and re-appends that accumulator (deduped by content) to the messages it returns for the next step. Steers live only in `pendingSteers` (model context) for v1 — they are NOT pushed into `deps.messages`, so there is zero coupling with `appendCompletedTurn`/`discardAbortedTurn`. A new `steer-inject` LiveEvent gives the harness + TUI visibility.

**Tech Stack:** Bun, TypeScript (NodeNext ESM, `.js` import specifiers), AI SDK v6 (`ai@6.0.169` `streamText`/`prepareStep`), React 19 + OpenTUI, Vitest, the in-repo agent-harness.

**Scope:** Top-level loop only (sub-agent `stream-runner.ts` excluded — mirrors the v1.6.4 stall-reprompt scope). Feature flag `MUONROI_STEER_INJECTION` (default on).

**Known v1 limitation (intentional):** The literal steer text is not persisted into turn history — its *effect* is captured in the assistant response, which IS persisted via `appendCompletedTurn`. Full steer persistence (own message rows) is a follow-up.

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/utils/settings.ts` | `getSteerInjectionEnabled()` env knob | Modify |
| `src/utils/settings.test.ts` | knob tests | Modify |
| `src/orchestrator/steer-inbox.ts` | `planSteerInjection` pure helper + `SteerInjectionState` | Create |
| `src/orchestrator/steer-inbox.test.ts` | pure-helper unit tests | Create |
| `packages/agent-harness-core/src/protocol.ts` | `steer-inject` LiveEvent union arm | Modify |
| `packages/agent-harness-core/src/event-filter.ts` | add `steer-inject` to `LIFECYCLE_PRESET` | Modify |
| `packages/agent-harness-core/src/event-redact.ts` | add `steer-inject` to `ALLOWED_FIELDS` | Modify |
| `packages/agent-harness-core/__tests__/event-redact.spec.ts` | redaction survives test | Modify |
| `src/orchestrator/message-processor.ts` | `drainSteerMessages?` on deps; `pendingSteers`+`steerEnabled`; `withSteers` in prepareStep | Modify |
| `src/orchestrator/orchestrator.ts` | `Agent.steerDrain` field + `setSteerDrain()` + deps wiring | Modify |
| `src/ui/app.tsx` | register `agent.setSteerDrain`; `steer-inject` toast branch | Modify |
| `tests/harness/steer-inject.spec.ts` | E2E: mid-turn injection fires `steer-inject` | Create |
| `docs/agent-harness/PROTOCOL.md` | document the new event | Modify |
| `CLAUDE.md` | env-knob table row | Modify |

---

## Task 1: `getSteerInjectionEnabled()` env knob

**Files:**
- Modify: `src/utils/settings.ts` (add after `getProviderStallRetries`, currently ends ~line 1040)
- Test: `src/utils/settings.test.ts` (add a new `describe` after the `getProviderStallRetries` block, ~line 214)

- [ ] **Step 1: Write the failing test**

Add to `src/utils/settings.test.ts` after the `describe("getProviderStallRetries", ...)` block:

```ts
describe("getSteerInjectionEnabled", () => {
  it("defaults to true when the env var is unset or blank", async () => {
    vi.unstubAllEnvs();
    const { getSteerInjectionEnabled } = await import("./settings");
    expect(getSteerInjectionEnabled()).toBe(true);
    vi.stubEnv("MUONROI_STEER_INJECTION", "");
    expect(getSteerInjectionEnabled()).toBe(true);
  });

  it("returns false only for an explicit '0'", async () => {
    const { getSteerInjectionEnabled } = await import("./settings");
    vi.stubEnv("MUONROI_STEER_INJECTION", "0");
    expect(getSteerInjectionEnabled()).toBe(false);
  });

  it("returns true for '1' and any other non-'0' value", async () => {
    const { getSteerInjectionEnabled } = await import("./settings");
    for (const v of ["1", "true", "yes", "on", "xyz"]) {
      vi.stubEnv("MUONROI_STEER_INJECTION", v);
      expect(getSteerInjectionEnabled()).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/utils/settings.test.ts -t "getSteerInjectionEnabled"`
Expected: FAIL — `getSteerInjectionEnabled is not a function` (export does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Add to `src/utils/settings.ts` immediately after the closing `}` of `getProviderStallRetries` (keeps the provider/turn knobs grouped):

```ts
/**
 * Live-queue steering: when true, a message typed while a turn is streaming is
 * injected into the running turn at the next prepareStep boundary (as a `user`
 * interjection) instead of waiting for the turn to finish and running as a new
 * turn. When false, the legacy deferred-queue behaviour is preserved (the
 * message runs only after the current turn completes). House convention for a
 * default-true boolean knob: only an explicit "0" disables; unset/blank/any
 * other value = enabled. Env override: MUONROI_STEER_INJECTION.
 */
export function getSteerInjectionEnabled(): boolean {
  return process.env.MUONROI_STEER_INJECTION !== "0";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/utils/settings.test.ts -t "getSteerInjectionEnabled"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/settings.ts src/utils/settings.test.ts
git commit -m "feat(settings): MUONROI_STEER_INJECTION knob (default on)"
```

---

## Task 2: `planSteerInjection` pure helper

**Files:**
- Create: `src/orchestrator/steer-inbox.ts`
- Test: `src/orchestrator/steer-inbox.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/steer-inbox.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planSteerInjection, type SteerInjectionState } from "./steer-inbox.js";

describe("planSteerInjection", () => {
  // A valid baseline: feature enabled, not cancelled, one queued message.
  const base = (over: Partial<SteerInjectionState> = {}): SteerInjectionState => ({
    drained: [{ text: "also add tests" }],
    aborted: false,
    enabled: true,
    ...over,
  });

  it("maps drained text into a single user ModelMessage", () => {
    const out = planSteerInjection(base());
    expect(out).toEqual([{ role: "user", content: "also add tests" }]);
  });

  it("preserves FIFO order across multiple drained messages", () => {
    const out = planSteerInjection(base({ drained: [{ text: "a" }, { text: "b" }] }));
    expect(out.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("returns [] when the feature is disabled", () => {
    expect(planSteerInjection(base({ enabled: false }))).toEqual([]);
  });

  it("returns [] over a genuine user cancel (never steer an aborted turn)", () => {
    expect(planSteerInjection(base({ aborted: true }))).toEqual([]);
  });

  it("returns [] when nothing was drained", () => {
    expect(planSteerInjection(base({ drained: [] }))).toEqual([]);
  });

  it("skips empty / whitespace-only messages and trims the rest", () => {
    const out = planSteerInjection(base({ drained: [{ text: "  " }, { text: "  keep me  " }, { text: "" }] }));
    expect(out).toEqual([{ role: "user", content: "keep me" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/orchestrator/steer-inbox.test.ts`
Expected: FAIL — cannot resolve `./steer-inbox.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/orchestrator/steer-inbox.ts`:

```ts
/**
 * src/orchestrator/steer-inbox.ts
 *
 * Live-queue steering — pure decision helper.
 *
 * When the user types a message while a turn is streaming, the UI queue is
 * drained at the next prepareStep boundary and the messages are injected into
 * the running turn as `user` interjections (Claude-Code-style steering). This
 * module holds the PURE mapping/gating decision so it is unit-testable in
 * isolation from the orchestrator loop. The orchestrator owns the side effects
 * (draining the queue, the pendingSteers accumulator, emitting telemetry).
 */
import type { ModelMessage } from "ai";

/** Inputs to the steer-injection decision — see {@link planSteerInjection}. */
export interface SteerInjectionState {
  /** Raw messages drained from the UI steer queue this step. */
  drained: { text: string }[];
  /** True on a genuine user cancel — never steer an aborted turn. */
  aborted: boolean;
  /** Feature flag (getSteerInjectionEnabled). */
  enabled: boolean;
}

/**
 * Decide which (if any) drained messages to inject into the running turn.
 *
 * Returns user-role ModelMessages in FIFO order, trimmed, with empty/whitespace
 * entries dropped. Returns `[]` when the feature is disabled or the turn was
 * cancelled. Pure (no side effects).
 */
export function planSteerInjection(s: SteerInjectionState): ModelMessage[] {
  if (!s.enabled || s.aborted) return [];
  const out: ModelMessage[] = [];
  for (const m of s.drained) {
    const text = m.text?.trim();
    if (!text) continue;
    out.push({ role: "user", content: text });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/orchestrator/steer-inbox.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/steer-inbox.ts src/orchestrator/steer-inbox.test.ts
git commit -m "feat(orchestrator): planSteerInjection pure helper for live-queue steering"
```

---

## Task 3: `steer-inject` LiveEvent (protocol + filter + redact)

**Files:**
- Modify: `packages/agent-harness-core/src/protocol.ts:234` (add union arm before `| { t: "idle" }`)
- Modify: `packages/agent-harness-core/src/event-filter.ts:25-38` (add to `LIFECYCLE_PRESET`)
- Modify: `packages/agent-harness-core/src/event-redact.ts:100` (add to `ALLOWED_FIELDS`)
- Test: `packages/agent-harness-core/__tests__/event-redact.spec.ts` (mirror the `route-decision` redaction test)

> Why all three: `EventKind` is auto-derived from the union, so adding the arm makes both the filter Set and the redact Record *accept* `"steer-inject"` — but neither *requires* it. Omitting the filter entry silently drops the event by default; omitting the redact entry emits the event with `count`/`atStep`/`runId` stripped (fail-safe drop-all). Both are required for the event to reach the wire intact.

- [ ] **Step 1: Write the failing test**

Add to `packages/agent-harness-core/__tests__/event-redact.spec.ts` (mirror the existing `route-decision` redaction test — locate it ~line 231 and add a sibling `it`):

```ts
  it("keeps steer-inject count/atStep/runId and strips unknown fields", () => {
    const out = redactEvent({
      t: "event",
      kind: "steer-inject",
      count: 2,
      atStep: 3,
      runId: "run-xyz",
      // biome-ignore lint/suspicious/noExplicitAny: testing extra-field stripping
      extra: "dropme" as any,
    } as never);
    expect(out).toEqual({ t: "event", kind: "steer-inject", count: 2, atStep: 3, runId: "run-xyz" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/agent-harness-core/__tests__/event-redact.spec.ts -t "steer-inject"`
Expected: FAIL — `redactEvent` drops the unknown kind to `{ t, kind }`, so `count/atStep/runId` are missing (`toEqual` mismatch). (Also a tsc error on the union — fixed in Step 3.)

- [ ] **Step 3: Write minimal implementation**

(3a) In `packages/agent-harness-core/src/protocol.ts`, add this arm immediately BEFORE the final `| { t: "idle" };` (line 234):

```ts
  | {
      t: "event";
      kind: "steer-inject";
      /** How many queued messages were injected at this boundary. */
      count: number;
      /** The prepareStep step number at which injection occurred (>= 1). */
      atStep: number;
      runId: string;
    }
```

(3b) In `packages/agent-harness-core/src/event-filter.ts`, add `"steer-inject",` to the `LIFECYCLE_PRESET` Set (after `"route-decision",`):

```ts
  "route-decision",
  "steer-inject",
  "usage",
```

(3c) In `packages/agent-harness-core/src/event-redact.ts`, add this entry to `ALLOWED_FIELDS` (after the `"route-decision": { ... },` block, ~line 105):

```ts
  "steer-inject": {
    count: "pass",
    atStep: "pass",
    runId: "pass",
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/agent-harness-core/__tests__/event-redact.spec.ts -t "steer-inject"`
Expected: PASS.
Then: `bunx tsc --noEmit` → 0 errors (confirms the union arm type-checks against the Set/Record key types).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-harness-core/src/protocol.ts packages/agent-harness-core/src/event-filter.ts packages/agent-harness-core/src/event-redact.ts packages/agent-harness-core/__tests__/event-redact.spec.ts
git commit -m "feat(protocol): steer-inject LiveEvent (union + lifecycle preset + redact allowlist)"
```

---

## Task 4: Agent `setSteerDrain` + deps wiring

**Files:**
- Modify: `src/orchestrator/message-processor.ts:261-365` (add optional field to `MessageProcessorDeps`)
- Modify: `src/orchestrator/orchestrator.ts` (Agent field ~near `abortController`; public method near `getModel()`; deps literal at the main block ~line 2519-2594)

> The field is OPTIONAL on `MessageProcessorDeps`, so `TurnRunnerDepsBase` and the batch/council deps literal (orchestrator.ts:2374) do NOT need touching.

- [ ] **Step 1: Add the optional deps field**

In `src/orchestrator/message-processor.ts`, inside `interface MessageProcessorDeps`, add this line immediately before `askToolLoopContinue?: ToolLoopCapAsk;` (groups the two optional UI-provided callbacks):

```ts
  /**
   * Live-queue steering drain (UI-provided). Returns and CLEARS any messages
   * the user typed while this turn is streaming, so prepareStep can inject them
   * mid-turn. Undefined / returns [] → no steering (legacy deferred queue).
   */
  drainSteerMessages?: () => { text: string }[];
```

- [ ] **Step 2: Add the Agent field + setter**

In `src/orchestrator/orchestrator.ts`, inside `class Agent` (line 255):

(2a) Add a private field next to the other mutable turn fields (e.g. directly after the `abortController` field declaration):

```ts
  /** UI-registered live-queue steer drain; see Agent.setSteerDrain. */
  private steerDrain: (() => { text: string }[]) | null = null;
```

(2b) Add a public method next to the other public accessors (e.g. after `getModel()` / `getCwd()`):

```ts
  /**
   * Register (or clear with null) the UI callback that drains messages typed
   * while a turn is streaming, for mid-turn steering injection. Called from the
   * TUI when MUONROI_STEER_INJECTION is enabled.
   */
  setSteerDrain(fn: (() => { text: string }[]) | null): void {
    this.steerDrain = fn;
  }
```

- [ ] **Step 3: Wire the deps literal**

In `src/orchestrator/orchestrator.ts`, in the MAIN deps literal (the block containing `getAbortController: () => self.abortController` at line 2519 and `appendCompletedTurn` at line 2594), add this line immediately before `appendCompletedTurn: (user, asst) =>` (line 2594):

```ts
      drainSteerMessages: () => self.steerDrain?.() ?? [],
```

- [ ] **Step 4: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (Feature is inert — `drainSteerMessages` is defined but not yet consumed, and no UI registers `steerDrain` yet.)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/message-processor.ts src/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): Agent.setSteerDrain + drainSteerMessages deps wiring"
```

---

## Task 5: Inject pending steers in `prepareStep`

**Files:**
- Modify: `src/orchestrator/message-processor.ts` — import (line ~53 area / settings import), turn-state (after line 1106), prepareStep body (lines 1856-2048)

- [ ] **Step 1: Add imports**

(1a) Add `planSteerInjection` import near the top of `src/orchestrator/message-processor.ts` (alongside other `./`-relative orchestrator imports):

```ts
import { planSteerInjection } from "./steer-inbox.js";
```

(1b) Add `getSteerInjectionEnabled` to the EXISTING import from `../utils/settings.js` (the same import statement that already brings in `getProviderStallRetries`). Example result:

```ts
import { /* …existing… */ getProviderStallRetries, getSteerInjectionEnabled } from "../utils/settings.js";
```

- [ ] **Step 2: Declare loop-persistent steer state**

In `src/orchestrator/message-processor.ts`, immediately AFTER line 1106 (`const maxStallRetries = getProviderStallRetries();`) and BEFORE `streamAttempt: while (true)` (line 1229), add:

```ts
    // Live-queue steering: messages the user typed mid-turn are drained at a
    // prepareStep boundary and accumulated here, then re-appended (deduped) to
    // the messages returned for each subsequent step. Loop-persistent so they
    // survive a stall-reprompt restart of streamText. NOT pushed into
    // deps.messages in v1 — model-context only; the assistant response captures
    // the steering effect and is persisted via appendCompletedTurn.
    const pendingSteers: ModelMessage[] = [];
    const steerEnabled = getSteerInjectionEnabled();
```

- [ ] **Step 3: Add `withSteers` helper + wrap the prepareStep returns**

In the `prepareStep` callback (line 1856), add the helper immediately AFTER the first line `if (sn < 1) return {};` (line 1857):

```ts
              // --- Live-queue steering injection ---------------------------
              // Drain the UI steer queue ONCE per prepareStep call (sn >= 1),
              // accumulate into pendingSteers, and graft pendingSteers onto the
              // messages this step returns. Dedup-by-content makes re-appending
              // idempotent even if a stall-reprompt restart re-reads history.
              const withSteers = (r: { messages?: typeof stepMessages }): { messages?: typeof stepMessages } => {
                const _drained = steerEnabled ? (deps.drainSteerMessages?.() ?? []) : [];
                const _newSteers = planSteerInjection({
                  drained: _drained,
                  aborted: signal.aborted,
                  enabled: steerEnabled,
                });
                if (_newSteers.length > 0) {
                  pendingSteers.push(..._newSteers);
                  try {
                    const _ar = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
                      | { emitEvent: (e: unknown) => void }
                      | undefined;
                    _ar?.emitEvent({
                      t: "event",
                      kind: "steer-inject",
                      count: _newSteers.length,
                      atStep: sn,
                      runId: deps.getActiveRunId() ?? "",
                    });
                  } catch (emitErr) {
                    console.error(
                      `[message-processor] steer-inject telemetry failed: ${(emitErr as Error)?.message}`,
                    );
                  }
                }
                if (pendingSteers.length === 0) return r;
                const _base = r.messages ?? stepMessages;
                const _steerContents = new Set(
                  pendingSteers.map((s) => (typeof s.content === "string" ? s.content : JSON.stringify(s.content))),
                );
                const _deduped = _base.filter(
                  (m) =>
                    !(
                      m.role === "user" &&
                      _steerContents.has(typeof m.content === "string" ? m.content : JSON.stringify(m.content))
                    ),
                );
                return { ...r, messages: [..._deduped, ...pendingSteers] as typeof stepMessages };
              };
```

Then wrap each of the SIX message-yielding / no-op returns in the callback with `withSteers(...)` (the `if (sn < 1) return {}` on line 1857 is left UNwrapped — no steering before the first step):

| Original (verbatim) | Replace with |
|---|---|
| `return { messages: stripped };` (PRESERVE veto, ~1885) | `return withSteers({ messages: stripped });` |
| `return { messages: attachReminderToMessages(stripped, _pre) };` (~1961) | `return withSteers({ messages: attachReminderToMessages(stripped, _pre) });` |
| `return { messages: withReminder };` (~2024) | `return withSteers({ messages: withReminder });` |
| `if (compacted === stripped && stripped === stepMessages) return {};` (~2026) | `if (compacted === stripped && stripped === stepMessages) return withSteers({});` |
| `return { messages: attachReminderToMessages(compacted, _compactNote) };` (~2045) | `return withSteers({ messages: attachReminderToMessages(compacted, _compactNote) });` |
| `return { messages: compacted };` (~2047) | `return withSteers({ messages: compacted });` |

- [ ] **Step 4: Verify it compiles + existing tests pass**

Run: `bunx tsc --noEmit`
Expected: 0 errors.
Run: `bunx vitest run src/orchestrator/`
Expected: PASS (no regressions; the existing prepareStep/compaction tests still pass because `withSteers` is a pass-through when `pendingSteers` is empty and no drain is registered).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/message-processor.ts
git commit -m "feat(orchestrator): inject mid-turn steer messages at prepareStep boundary"
```

---

## Task 6: UI wiring — register drain + surface marker

**Files:**
- Modify: `src/ui/app.tsx` — import (top), `setSteerDrain` registration `useEffect` (after the agentRuntime tap effect ~line 701), `handleHarnessEvent` branch (~line 641)

> This is a **watched surface** (`src/ui/**`) — Step 5 runs Tier-1 self-verify.

- [ ] **Step 1: Add the settings import**

In `src/ui/app.tsx`, add `getSteerInjectionEnabled` to the existing `../utils/settings.js` import (or add a new import if none exists):

```ts
import { getSteerInjectionEnabled } from "../utils/settings.js";
```

- [ ] **Step 2: Register the steer drain**

In `src/ui/app.tsx`, add this `useEffect` after the existing agentRuntime emitEvent-tap effect (which ends ~line 701). It pops ALL currently-queued messages and clears the visual queue box; the running turn's `prepareStep` pulls them via `agent.setSteerDrain`:

```ts
  // Live-queue steering: expose the mid-turn queue to the running turn so
  // prepareStep can inject typed-while-busy messages at the next step boundary
  // instead of deferring them to a new turn. Disabled → callback not wired, so
  // finishTurnProcessing drains the queue post-turn exactly as before.
  useEffect(() => {
    if (!getSteerInjectionEnabled()) return;
    agent.setSteerDrain(() => {
      if (queuedMessagesRef.current.length === 0) return [];
      const drained = queuedMessagesRef.current.map((m) => ({ text: m.text }));
      queuedMessagesRef.current = [];
      setQueuedMessages([]);
      return drained;
    });
    return () => agent.setSteerDrain(null);
  }, [agent]);
```

- [ ] **Step 3: Surface a subtle marker on injection**

In `src/ui/app.tsx`, inside `handleHarnessEvent` (~line 630), add this branch after the existing `if (e.kind === "toast") { ... }` block:

```ts
      if (e.kind === "steer-inject") {
        const count = typeof e.count === "number" ? e.count : 1;
        pushToast("info", `↳ steering applied (${count} message${count === 1 ? "" : "s"})`);
        return;
      }
```

- [ ] **Step 4: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Self-verify (watched surface) + commit**

Run: `bun run src/index.ts self-verify --since HEAD~1 --max 4`
Expected: no scenario regressions (textbox/queue scenarios still pass).

```bash
git add src/ui/app.tsx
git commit -m "feat(ui): wire live-queue steer drain + injection toast"
```

---

## Task 7: Harness E2E — mid-turn injection fires `steer-inject`

**Files:**
- Create: `tests/harness/steer-inject.spec.ts`

> Driving approach: `spawnCostLeakHarness` (writes an isolated temp fixture and sets `MUONROI_PIL_DISCOVERY=0` + `MUONROI_LLM_FIRST_CLASSIFY=0`, both required so the scripted doStream rounds aren't consumed by discovery/classify). The fixture has 4 doStream rounds — 3 `bash` tool-call rounds (each creates a `prepareStep` sn≥1 boundary with real async tool-exec latency) then a final text round — giving multiple injection opportunities so the queued steer is reliably drained before the turn ends.

- [ ] **Step 1: Write the E2E spec**

Create `tests/harness/steer-inject.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnCostLeakHarness, type CostLeakHarness } from "./cost-leak-tui-helpers.js";

// A usage block in the AI-SDK doStream "stream" shape (mirrors fixtures/llm/scope-adherence.json).
const usage = (inp: number, out: number) => ({
  inputTokens: { total: inp, noCache: inp, cacheRead: null, cacheWrite: null },
  outputTokens: { total: out, text: out, reasoning: null },
});

const bashRound = (id: string, cmd: string) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName: "bash", input: JSON.stringify({ command: cmd }) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: null }, usage: usage(60, 12) },
];

const finalRound = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "f" },
  { type: "text-delta", id: "f", delta: "done" },
  { type: "text-end", id: "f" },
  { type: "finish", finishReason: { unified: "stop", raw: null }, usage: usage(120, 4) },
];

const FIXTURE = {
  provider: "mock",
  modelId: "mock-deepseek-v4-flash",
  // 4 rounds: 3 bash tool-calls (each → a prepareStep boundary) then a final text stop.
  stream: [bashRound("b0", "echo s0"), bashRound("b1", "echo s1"), bashRound("b2", "echo s2"), finalRound],
};

describe("live-queue steering — mid-turn injection", () => {
  let h: CostLeakHarness;

  beforeAll(async () => {
    h = await spawnCostLeakHarness(FIXTURE, { modelId: "deepseek-ai/DeepSeek-V4-Flash" });
  }, 120_000);

  afterAll(() => {
    h?.cleanup();
  });

  it("injects a message typed while the turn is streaming (steer-inject fires before idle)", async () => {
    // Start a multi-step turn.
    h.driver.type("run the steps");
    h.driver.press("Enter");

    // Queue a follow-up WHILE the turn is in flight (isProcessing === true).
    // The bash tool-exec latency between rounds guarantees this lands before a
    // later prepareStep boundary drains it.
    h.driver.type("also summarize what you did");
    h.driver.press("Enter");

    // Assert the injection actually happened mid-turn.
    await h.driver.wait_for({
      event: "steer-inject",
      match: (e) => e.t === "event" && e.kind === "steer-inject" && e.count >= 1 && e.atStep >= 1,
      timeoutMs: 30_000,
    });

    const injected = h.driver.last_event("steer-inject");
    expect(injected?.count).toBeGreaterThanOrEqual(1);
    expect(injected?.atStep).toBeGreaterThanOrEqual(1);

    // Turn still settles cleanly.
    await h.driver.wait_for({ idle: true, timeoutMs: 30_000 });
  }, 90_000);
});
```

- [ ] **Step 2: Run the spec to verify it passes**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/steer-inject.spec.ts`
Expected: PASS. The `steer-inject` event fires at `atStep >= 1` with `count >= 1`.

If it FAILS with a `wait_for` timeout: confirm (a) Task 5's `withSteers` is wrapping the returns, (b) Task 6's `setSteerDrain` is registered, (c) `MUONROI_STEER_INJECTION` is not set to `0` in the test env. Re-run isolated (the harness config sets `fileParallelism:false`).

- [ ] **Step 3: Commit**

```bash
git add tests/harness/steer-inject.spec.ts
git commit -m "test(harness): E2E for mid-turn live-queue steering injection"
```

---

## Task 8: Docs + full verification gate

**Files:**
- Modify: `docs/agent-harness/PROTOCOL.md` (event table)
- Modify: `CLAUDE.md` (env-knob table)

- [ ] **Step 1: Document the event**

In `docs/agent-harness/PROTOCOL.md`, add a row to the LiveEvent kinds table:

```markdown
| `steer-inject` | A queued mid-turn message is injected into the running turn at a prepareStep boundary | `count`, `atStep`, `runId` |
```

- [ ] **Step 2: Document the env knob**

In `CLAUDE.md`, add a row to the optional-env-overrides table:

```markdown
| `MUONROI_STEER_INJECTION` | `0` / `1` | `1` | Live-queue steering — inject a message typed mid-turn into the running turn at the next prepareStep boundary (vs the legacy "run after the turn finishes" queue). `0` restores the deferred queue. |
```

- [ ] **Step 3: Run the FULL pre-push gate**

```bash
bunx tsc --noEmit
bunx vitest run
bunx vitest -c vitest.harness.config.ts run tests/harness/
```
Expected: tsc 0 errors; full unit suite 0 failed; harness suite 0 failed. (Per the Pre-Push Test Gate: do NOT push on any red.)

- [ ] **Step 4: Commit**

```bash
git add docs/agent-harness/PROTOCOL.md CLAUDE.md
git commit -m "docs(steering): document steer-inject event + MUONROI_STEER_INJECTION knob"
```

---

## Self-Review (author checklist — run after the plan is written, before execution)

**Spec coverage** — every approved-spec section maps to a task:
- Behaviour (auto-inject at next boundary, tail fallback) → Task 5 (`withSteers`, sn≥1 gate) + Task 6 (drain leaves tail in queue for `finishTurnProcessing`). ✓
- Strategy 1 (prepareStep override) → Task 5. ✓
- Steer inbox transport (`drainSteerMessages`) → Task 4 + Task 6. ✓
- Carry-forward/dedup crux → Task 5 (`_deduped` by content; accumulator re-append). ✓
- Persistence → REFINED: v1 keeps steers in `pendingSteers` only (model-context), not `deps.messages`; documented as a limitation in the header. ✓
- Observability (`steer-inject` event) → Task 3 + Task 5 (emit) + Task 6 (toast). ✓
- Pure helper isolation → Task 2. ✓
- Config knob → Task 1. ✓
- Scope top-level only → no sub-agent (`stream-runner.ts`) task. ✓
- Tests (unit + harness E2E + self-verify + full gate) → Tasks 1,2,3,7 + Task 6 Step 5 + Task 8 Step 3. ✓

**Placeholder scan:** no TBD/TODO; every code step has complete code. ✓
**Type consistency:** `SteerInjectionState`/`planSteerInjection` (Task 2) match their use in Task 5; `drainSteerMessages?: () => { text: string }[]` identical in Tasks 4 (interface), 4 (Agent setter signature `(() => { text: string }[]) | null`), 6 (UI returns `{ text }[]`); `steer-inject` payload `{ count, atStep, runId }` identical across Tasks 3 (union + redact), 5 (emit), 6 (toast read), 7 (assert). ✓
