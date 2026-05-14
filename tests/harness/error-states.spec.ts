/**
 * error-states.spec.ts
 *
 * Goal: assert that a mock-LLM error causes a role=toast level=error event
 * to appear via driver.last_event("toast").
 *
 * Current status (Phase 7):
 *   - app.tsx now calls agentRuntime.emitEvent({ kind: "toast", level: "error" })
 *     in both the `case "error"` chunk handler and the top-level catch block.
 *   - mock-llm.ts fixture format has no error-injection marker — the Fixture type
 *     only supports { match, text } entries. To write the E2E test, add
 *     { match, error: string } support to mock-llm.ts and yield a "error" chunk.
 */

import { describe, it } from "vitest";

describe.skipIf(process.platform === "win32")("error states E2E", () => {
  it.todo(
    "mock-llm error-injection mode not yet implemented: add { match, error: string } to fixture schema and yield kind='error' chunk from the adapter",
  );
});
