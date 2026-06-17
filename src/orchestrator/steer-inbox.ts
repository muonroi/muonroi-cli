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
