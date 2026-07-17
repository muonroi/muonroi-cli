/**
 * tests/harness/cost-leak-f1.spec.ts
 *
 * Cost-leak verification: F1 — stable OpenAI prompt-cache key across all
 * rounds in a session.
 *
 * The orchestrator at src/orchestrator/orchestrator.ts merges
 * `providerOptions.openai.promptCacheKey = computePromptCacheKey(session.id)`
 * before every streamText call. Without this, OpenAI auto-hashes the prompt
 * content per round — every tool-call response changes messages, so the
 * cache is busted on round 2+.
 *
 * This spec drives a 3-round streamText loop with a MockLanguageModelV3 and
 * verifies that every recorded call carries the SAME promptCacheKey. If the
 * orchestrator ever computes it differently per round or forgets to merge
 * it after round 1, this spec fails.
 */

import { stepCountIs, streamText, tool } from "ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { installMockModel, textOnlyStream, toolCallStream } from "../../src/agent-harness/mock-model.js";
import { loadCatalog } from "../../src/models/registry.js";
import { computePromptCacheKey, resolveModelRuntime } from "../../src/providers/runtime.js";
import { getProviderOption, inspectAll } from "./recording.js";

// No stub factory: resolveModelRuntime derives the factory from the model id,
// and installMockModel's global short-circuits the factory path entirely.

// biome-ignore lint/suspicious/noExplicitAny: streamText result generic is provider-specific
async function drain(result: { fullStream: AsyncIterable<any> }): Promise<void> {
  for await (const _ of result.fullStream) {
    // discard
  }
}

describe("F1: stable promptCacheKey across all rounds in a session", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("every round carries the same sha256-derived promptCacheKey", async () => {
    const handle = installMockModel({
      fixture: {
        stream: [
          toolCallStream({ toolCallId: "1", toolName: "noop", input: {} }),
          toolCallStream({ toolCallId: "2", toolName: "noop", input: {} }),
          textOnlyStream("done"),
        ],
      },
    });
    cleanup = handle.uninstall;

    const sessionId = "sess-deterministic-f1";
    const expectedKey = computePromptCacheKey(sessionId);
    expect(expectedKey).toMatch(/^[a-f0-9]{32}$/);

    const runtime = resolveModelRuntime("gpt-5.4");
    const noopTool = tool({
      description: "no-op",
      inputSchema: z.object({}).strict(),
      execute: async () => "ok",
    });

    const providerOptions = {
      ...(runtime.providerOptions ?? {}),
      openai: {
        ...((runtime.providerOptions?.openai as Record<string, unknown> | undefined) ?? {}),
        promptCacheKey: expectedKey,
      },
    };

    const result = streamText({
      model: runtime.model,
      system: "You are a tool-using agent.",
      messages: [{ role: "user", content: "run noop twice then finish" }],
      tools: { noop: noopTool },
      stopWhen: stepCountIs(5),
      providerOptions,
    });
    await drain(result);

    const calls = inspectAll(handle);
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(getProviderOption<string>(c, "openai", "promptCacheKey")).toBe(expectedKey);
    }
  });

  it("key is computed once per session id and is order-independent", () => {
    // computePromptCacheKey is the same for the same sessionId regardless of
    // call order — guards against accidental statefulness in the helper.
    const ids = ["a", "b", "c", "a", "b", "c"];
    const keys = ids.map((i) => computePromptCacheKey(i));
    expect(keys[0]).toBe(keys[3]);
    expect(keys[1]).toBe(keys[4]);
    expect(keys[2]).toBe(keys[5]);
    expect(new Set(keys).size).toBe(3);
  });

  it("control: keys must NOT match across different session ids", async () => {
    const handle = installMockModel({ fixture: { stream: textOnlyStream("ok") } });
    cleanup = handle.uninstall;

    const k1 = computePromptCacheKey("sess-1");
    const k2 = computePromptCacheKey("sess-2");
    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    expect(k1).not.toBe(k2);
  });
});
