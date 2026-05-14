/**
 * error-states.spec.ts
 *
 * Goal: assert that a mock-LLM error causes a role=toast level=error event
 * to appear via driver.last_event("toast").
 *
 * Investigation result: mock-llm.ts fixture format has no "error" marker —
 * the Fixture type only supports { match, text } entries. The TUI app.tsx
 * does not call agentRuntime.emitEvent({ kind: "toast" }) on provider errors
 * either; that wiring does not exist yet. The `toast` role IS in protocol.ts
 * and agent-mode.ts exposes emitEvent(), but no component in src/ui/ calls it.
 *
 * Therefore: E2E test is infeasible without:
 *   (a) adding an "error: true" marker to the mock-llm fixture schema, AND
 *   (b) wiring an error handler in app.tsx that calls agentRuntime.emitEvent()
 *       with kind="toast", level="error".
 */

import { describe, it } from "vitest";

describe.skipIf(process.platform === "win32")("error states E2E", () => {
  it.todo(
    "mock-llm fixture needs error-injection mode (not yet implemented): add { error: true } to fixture schema and wire app.tsx to call agentRuntime.emitEvent({ kind: 'toast', level: 'error' }) on provider failures",
  );

  it.todo(
    "TUI does not currently call emitEvent() on LLM errors: no code path in src/ui/app.tsx routes provider errors to the agent-harness toast event channel",
  );
});
