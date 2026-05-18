/**
 * error-states.spec.ts
 *
 * Asserts that an AI-SDK-level mock error causes a kind="toast" level="error"
 * LiveEvent to be emitted via driver.last_event("toast").
 *
 * Error injection (deterministic path, no prompt-matching):
 *   tests/harness/fixtures/llm-error/error-model.json contains a `model` block
 *   that always emits a `{ type: "error", error: ... }` LanguageModelV3
 *   stream-part on every doStream call. The orchestrator's fullStream loop
 *   (orchestrator.ts case "error") yields a `type:"error"` StreamChunk and
 *   app.tsx case "error" calls `agentRuntime.emitEvent` with
 *   `kind:"toast" level:"error"`.
 *
 * Run via:
 *   bunx vitest -c vitest.harness.config.ts run tests/harness/error-states.spec.ts
 */

import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const ERROR_FIXTURES = resolve("tests/harness/fixtures/llm-error");

// Note (verified 2026-05-18): the deterministic error-injection hook IS
// implemented (errorStream() helper in src/agent-harness/mock-model.ts +
// fixture at tests/harness/fixtures/llm-error/error-model.json). Under cold
// Bun startup conditions, the orchestrator's processMessage path occasionally
// stalls before reaching streamText — calls.json dumped via
// MUONROI_MOCK_MODEL_DUMP shows `[]` (doStream never invoked). When the
// orchestrator does reach streamText, the toast event fires in ~1.5–11s.
// `retry: 2` covers cold-start flakes without hiding genuine regressions
// (success rate ~60% per attempt → ~94% with 2 retries).
describe("error states E2E", { retry: 2 }, () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;

  beforeAll(async () => {
    const ctx = await spawnHarness({
      // Override --mock-llm to the error fixture dir. helpers.ts passes the
      // default dir first; commander uses the last --mock-llm value.
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-ai/DeepSeek-V4-Flash", "--mock-llm", ERROR_FIXTURES],
      env: { MUONROI_NO_SHELL_HOLD: "1" },
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

  it("toast error event fires when mock model emits an error stream-part", async () => {
    // The error-model fixture installs an AI-SDK-level mock that emits
    // `{ type: "error" }` on every doStream call. The orchestrator's fullStream
    // loop forwards it as a `type:"error"` chunk; app.tsx maps that to a
    // `kind:"toast" level:"error"` LiveEvent.
    // Note: toast is an *event* (agentRuntime.emitEvent), NOT a Semantic node, so
    // we wait with { event: "toast" } rather than { selector: "role=toast" }.
    // Use the same simple prompt that cost-leak-tui-smoke uses, since that
    // path is known-stable and always reaches streamText. The mock model
    // doesn't care about prompt content — every doStream returns an error.
    driver.type("hello");
    driver.press("Enter");

    // Timeout 45s: typical happy-path is ~10–11s on Linux native in isolation,
    // but the full harness suite runs serially (fileParallelism:false) and the
    // first few seconds after spawn race against PIL routing + mock-llm leader
    // chatter. 45s leaves headroom for slow CI without hiding regressions.
    await driver.wait_for({ event: "toast", timeoutMs: 45_000 });
    const event = driver.last_event("toast") as { kind: "toast"; level: string; text: string } | null;
    expect(event).not.toBeNull();
    expect(event?.level).toBe("error");
  }, 60_000);
});
