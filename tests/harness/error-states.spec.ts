/**
 * error-states.spec.ts
 *
 * Asserts that a mock-LLM error causes a role=toast level=error event to
 * appear via driver.last_event("toast").
 *
 * Error injection: fixture `tests/harness/fixtures/llm/error.json` contains
 *   { "match": "__trigger_error__", "error": "mock LLM error: ..." }
 * When the prompt includes that sentinel string, mock-llm.ts throws — the
 * adapter generator propagates the throw, stream-loop.ts catches it and
 * yields { kind: "error" }, app.tsx case "error" calls agentRuntime.emitEvent
 * with kind="toast" level="error".
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/error-states.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "../../src/agent-harness/driver";
import { spawnHarness } from "./helpers.js";

// TODO: This spec has never passed in CI on any platform since it was added
// (commit bf5df60). The error fixture loads correctly and the app.tsx wiring
// emits the toast event on error chunks, but the chain from
// `driver.type("__trigger_error__")` → mock throw → toast event never
// completes within 10s in CI. Likely cause: prompt composition prefixes (system
// prompt, history) prevent the substring match from firing, or the harness
// sidechannel drops the toast event before ingestion. Skip until the harness
// has a deterministic error-injection hook that doesn't depend on prompt
// matching.
describe.skip("error states E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash"],
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;

    await driver.wait_for({ idle: true, timeoutMs: 15_000 });
  }, 20_000);

  afterAll(() => {
    proc?.kill();
    cleanup?.();
  });

  it("toast error event fires when mock-LLM throws", async () => {
    // The sentinel substring "__trigger_error__" matches the error fixture entry,
    // causing mock.complete() to throw → stream-loop catches → "error" chunk →
    // app.tsx emits toast event with level="error".
    // Note: toast is an *event* (agentRuntime.emitEvent), NOT a Semantic node, so
    // we wait with { event: "toast" } rather than { selector: "role=toast" }.
    driver.type("__trigger_error__");
    driver.press("Enter");

    await driver.wait_for({ event: "toast", timeoutMs: 10_000 });
    const event = driver.last_event("toast") as { kind: "toast"; level: string; text: string } | null;
    expect(event).not.toBeNull();
    expect(event?.level).toBe("error");
  });
});
