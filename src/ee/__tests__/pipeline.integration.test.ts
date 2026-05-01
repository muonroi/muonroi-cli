/**
 * End-to-end pipeline integration test (ROUTE-12).
 *
 * Verifies all 5 events fire for a single tool invocation:
 *   PreToolUse (intercept) -> PostToolUse (posttool) -> Judge -> Feedback -> Touch
 *
 * Uses real modules + stub HTTP server — no vi.mock.
 * Anti-patterns avoided:
 *   - No HTTP call ordering by array index (fire-and-forget lands non-deterministically)
 *   - resetEEClientState() in beforeEach (circuit breaker + cache contamination)
 *   - resetHookState() in beforeEach (_lastWarningResponse contamination between tests)
 *   - No vi.mock — integration test uses real modules + stub
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StubHandle, startStubEEServer } from "../../__test-stubs__/ee-server.js";
import { createEEClient, resetEEClientState } from "../client.js";
import { setDefaultEEClient } from "../intercept.js";
import { executeEventHooks, resetHookState } from "../../hooks/index.js";
import type { InterceptMatch } from "../types.js";

const sampleMatch: InterceptMatch = {
  principle_uuid: "P1",
  confidence: 0.9,
  why: "test match",
  message: "warning: test principle",
  embedding_model_version: "v1",
  scope_label: "global",
  last_matched_at: new Date().toISOString(),
};

describe("EE full pipeline integration (ROUTE-12)", () => {
  let stub: StubHandle;

  beforeEach(async () => {
    resetEEClientState();
    resetHookState();
  });

  afterEach(async () => {
    if (stub) await stub.stop();
    resetEEClientState();
    resetHookState();
  });

  it("fires all 5 events for a single tool invocation (intercept -> posttool -> judge -> feedback -> touch)", async () => {
    stub = await startStubEEServer({
      intercept: () => ({
        decision: "allow",
        matches: [sampleMatch],
      }),
    });

    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    setDefaultEEClient(client);

    // Event 1: PreToolUse — fires intercept, stores warning in _lastWarningResponse
    await executeEventHooks(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { path: "/tmp/x.ts" },
        cwd: process.cwd(),
      },
      process.cwd(),
    );

    // Event 2: PostToolUse — fires posttool + (judge -> feedback + touch via judgeCtx)
    await executeEventHooks(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { path: "/tmp/x.ts" },
        tool_output: { result: "ok" },
        cwd: process.cwd(),
      },
      process.cwd(),
    );

    // Allow fire-and-forget HTTP calls (feedback + touch) to settle
    await new Promise((r) => setTimeout(r, 150));

    // Assert all 5 pipeline stages fired
    expect(stub.calls.intercept).toHaveLength(1);   // Stage 1: PreToolUse
    expect(stub.calls.posttool).toHaveLength(1);    // Stage 2: PostToolUse
    expect(stub.calls.feedback).toHaveLength(1);    // Stage 3+4: Judge FOLLOWED -> Feedback
    expect(stub.calls.touch).toHaveLength(1);       // Stage 5: Touch (FOLLOWED path)

    // Verify feedback classification
    expect(stub.calls.feedback[0]).toMatchObject({
      principle_uuid: "P1",
      classification: "FOLLOWED",
      tool_name: "Edit",
    });
  });

  it("auto-judge classifies IRRELEVANT when no matches — feedback and touch not called", async () => {
    stub = await startStubEEServer({
      intercept: () => ({
        decision: "allow",
        matches: [], // empty matches => IRRELEVANT
      }),
    });

    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    setDefaultEEClient(client);

    await executeEventHooks(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { path: "/tmp/y.ts" },
        cwd: process.cwd(),
      },
      process.cwd(),
    );

    await executeEventHooks(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { path: "/tmp/y.ts" },
        tool_output: { result: "ok" },
        cwd: process.cwd(),
      },
      process.cwd(),
    );

    await new Promise((r) => setTimeout(r, 150));

    // intercept + posttool fire, but no feedback or touch (IRRELEVANT has no matches to report)
    expect(stub.calls.intercept).toHaveLength(1);
    expect(stub.calls.posttool).toHaveLength(1);
    expect(stub.calls.feedback).toHaveLength(0); // IRRELEVANT: judge.ts line 33 — no feedback for empty matches
    expect(stub.calls.touch).toHaveLength(0);
  });

  it("auto-judge classifies IGNORED when outcome fails — feedback called, touch not called", async () => {
    stub = await startStubEEServer({
      intercept: () => ({
        decision: "allow",
        matches: [sampleMatch],
      }),
    });

    const client = createEEClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      timeoutMs: 2000,
    });
    setDefaultEEClient(client);

    // PreToolUse to populate _lastWarningResponse with matches
    await executeEventHooks(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "exit 1" },
        cwd: process.cwd(),
      },
      process.cwd(),
    );

    // PostToolUseFailure — outcome.success=false => IGNORED classification
    await executeEventHooks(
      {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "exit 1" },
        error: "exit code 1",
        cwd: process.cwd(),
      },
      process.cwd(),
    );

    await new Promise((r) => setTimeout(r, 150));

    expect(stub.calls.intercept).toHaveLength(1);
    expect(stub.calls.posttool).toHaveLength(1);
    expect(stub.calls.feedback).toHaveLength(1); // IGNORED: feedback fires
    expect(stub.calls.touch).toHaveLength(0);    // IGNORED: touch does NOT fire

    expect(stub.calls.feedback[0]).toMatchObject({
      principle_uuid: "P1",
      classification: "IGNORED",
    });
  });
});
