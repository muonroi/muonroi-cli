import { describe, expect, it } from "vitest";
import type { DelegationRun } from "../../types/index.js";
import {
  authFanoutRefusal,
  classifyFailureTerminal,
  failureRecoveryGuidance,
  workerFailureRecovery,
} from "../worker-failure-recovery.js";

describe("typed worker failure observations", () => {
  it.each([
    ["Task failed: HTTP 401: Invalid API key provided", "auth-failure"],
    ["Task failed: HTTP 403: Forbidden", "auth-failure"],
    ["API key required. Set MUONROI_API_KEY, use --api-key", "auth-failure"],
    ["Task failed: HTTP 429: Too Many Requests", "rate-limit"],
    [
      "Rate-limited by the provider account (HTTP 429) — this background agent could not get a request through. Provider said: Task failed: HTTP 429: slow down",
      "rate-limit",
    ],
    ["Task failed: Input ceiling exceeded on 'subagent' call: est 120000 tokens > ceiling 100000.", "context-overflow"],
    ["Task failed: HTTP 400: This model's maximum context length is 131072 tokens", "context-overflow"],
    ["Task failed: HTTP 400: Invalid schema for function 'read_file': schema is invalid", "provider-schema-refusal"],
    ["worker_incomplete: final answer reached the output limit; configuredOutputTokens=16384", "output-limit"],
    ["Task failed: Invalid prompt: The messages do not match the ModelMessage[] schema", "model-message-schema"],
    ["Task failed: HTTP 503: The engine is currently overloaded", "unclassified"],
  ])("%s → %s", (error, symptom) => {
    expect(classifyFailureTerminal(error)).toBe(symptom);
  });

  it("reads only the terminal marker, never the partial narration before it", () => {
    expect(classifyFailureTerminal("I saw HTTP 401 in the log.\n\nTask failed: HTTP 503: overloaded")).toBe(
      "unclassified",
    );
    expect(
      classifyFailureTerminal("worker_incomplete: no final answer was produced\nthe docs mention 401 unauthorized"),
    ).toBe("missing-final-answer");
    // A schema word in a 503 body is not a schema refusal; a context-length 400 is overflow, not schema.
    expect(classifyFailureTerminal("Task failed: HTTP 503: invalid schema cache")).toBe("unclassified");
  });

  it("puts the typed action first in the guidance the orchestrator reads", () => {
    const recovery = workerFailureRecovery({ error: "Task failed: HTTP 401: invalid api key" });
    expect(recovery.action).toContain("credentials");
    expect(failureRecoveryGuidance(recovery).split("\n")[0]).toMatch(/^Host failure type: auth-failure\./);
    expect(workerFailureRecovery({ error: "Task failed: HTTP 503: x" }).action).toBeUndefined();
  });
});

describe("auth fan-out refusal", () => {
  const authFailed: DelegationRun = {
    id: "dull-grey-mole",
    agent: "general",
    description: "x",
    summary: "failed",
    status: "error",
    failureRecovery: {
      symptom: "auth-failure",
      provider: "deepseek",
      rootCause: "not-established",
      capturedToolCalls: 0,
      mutationToolCalls: 0,
      commandToolCalls: 0,
      inspect: [],
    },
  };

  it("refuses further workers on a provider that failed auth this session, naming the job", () => {
    const refusal = authFanoutRefusal([authFailed], "deepseek");
    expect(refusal).toMatch(/^worker_provider_auth_refused:/);
    expect(refusal).toContain("dull-grey-mole");
  });

  it("allows other providers, other symptoms and unknown providers", () => {
    expect(authFanoutRefusal([authFailed], "openai")).toBeNull();
    expect(authFanoutRefusal([authFailed], undefined)).toBeNull();
    const rateLimited = {
      ...authFailed,
      failureRecovery: { ...authFailed.failureRecovery!, symptom: "rate-limit" as const },
    };
    expect(authFanoutRefusal([rateLimited], "deepseek")).toBeNull();
    expect(authFanoutRefusal([{ ...authFailed, status: "complete" }], "deepseek")).toBeNull();
  });
});
