/**
 * Unit tests for the mock-model helper. Verifies the recording surface and
 * sequential stream semantics that downstream cost-leak specs depend on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APICallError, type LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { generateObject, stepCountIs, streamText, tool } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { humanizeApiError } from "../../orchestrator/error-utils.js";
import { createMockModel, loadMockModelFromDir, textOnlyStream, toolCallStream } from "../mock-model.js";

// biome-ignore lint/suspicious/noExplicitAny: streamText result generic is provider-specific
async function drainStream(result: { fullStream: AsyncIterable<any> }): Promise<void> {
  for await (const _ of result.fullStream) {
    // discard — we only care about the model's recorded calls
  }
}

describe("createMockModel", () => {
  it("records every doStream call with full options", async () => {
    const handle = createMockModel({ stream: textOnlyStream("hello") });

    const result = streamText({
      model: handle.model,
      prompt: "say hi",
      maxOutputTokens: 50,
      temperature: 0.7,
    });
    await drainStream(result);

    expect(handle.calls.length).toBe(1);
    expect(handle.calls[0]?.maxOutputTokens).toBe(50);
    expect(handle.calls[0]?.temperature).toBe(0.7);
  });

  it("preserves providerOptions in recorded calls", async () => {
    const handle = createMockModel({ stream: textOnlyStream("hello") });

    const result = streamText({
      model: handle.model,
      prompt: "say hi",
      providerOptions: { openai: { promptCacheKey: "abc123" } },
    });
    await drainStream(result);

    expect(handle.calls[0]?.providerOptions).toEqual({
      openai: { promptCacheKey: "abc123" },
    });
  });

  it("advances the stream sequence across multiple rounds", async () => {
    const handle = createMockModel({
      stream: [toolCallStream({ toolCallId: "1", toolName: "echo", input: { msg: "hi" } }), textOnlyStream("done")],
    });

    const echoTool = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async ({ msg }: { msg: string }) => `echoed: ${msg}`,
    });

    const result = streamText({
      model: handle.model,
      prompt: "use echo",
      tools: { echo: echoTool },
      stopWhen: stepCountIs(3),
    });
    await drainStream(result);

    expect(handle.calls.length).toBe(2);
    // Round 1 sees only the user message; round 2 sees the tool result too.
    expect(handle.calls[1]?.prompt.length).toBeGreaterThan(handle.calls[0]?.prompt.length ?? 0);
  });

  it("repeats the last stream entry when sequence is exhausted", async () => {
    const handle = createMockModel({ stream: [textOnlyStream("once")] });
    // Drive two calls — second should silently reuse the last entry.
    for (let i = 0; i < 2; i++) {
      const r = streamText({ model: handle.model, prompt: `q${i}` });
      await drainStream(r);
    }
    expect(handle.calls.length).toBe(2);
  });

  it("reset() clears doStreamCalls and rewinds the sequence index", async () => {
    const handle = createMockModel({
      stream: [textOnlyStream("first"), textOnlyStream("second")],
    });
    const r1 = streamText({ model: handle.model, prompt: "q1" });
    await drainStream(r1);
    expect(handle.calls.length).toBe(1);

    handle.reset();
    expect(handle.calls.length).toBe(0);

    // After reset, the sequence index is back at 0 → next call gets "first" again.
    const r2 = streamText({ model: handle.model, prompt: "q2" });
    await drainStream(r2);
    expect(handle.calls.length).toBe(1);
  });

  it("doGenerate backs generateObject with the configured JSON (council debate-planner path)", async () => {
    const handle = createMockModel({
      stream: textOnlyStream("unused"),
      generate: JSON.stringify({ name: "counter", count: 3 }),
    });
    const { object } = await generateObject({
      model: handle.model,
      schema: z.object({ name: z.string(), count: z.number() }),
      prompt: "plan the build",
    });
    expect(object).toEqual({ name: "counter", count: 3 });
  });

  it("doGenerate sequences across calls and repeats the last entry when exhausted", async () => {
    const handle = createMockModel({
      stream: textOnlyStream("unused"),
      generate: [JSON.stringify({ n: 1 }), JSON.stringify({ n: 2 })],
    });
    const schema = z.object({ n: z.number() });
    const a = await generateObject({ model: handle.model, schema, prompt: "1" });
    const b = await generateObject({ model: handle.model, schema, prompt: "2" });
    const c = await generateObject({ model: handle.model, schema, prompt: "3" });
    expect(a.object.n).toBe(1);
    expect(b.object.n).toBe(2);
    expect(c.object.n).toBe(2); // exhausted → last entry repeats
  });

  it("doGenerate defaults to {} when no generate fixture is supplied (caller retry/fallback runs)", async () => {
    const handle = createMockModel({ stream: textOnlyStream("unused") });
    // An empty object fails a required-field schema → generateObject rejects,
    // which is exactly what lets debate-planner fall through to its retry path.
    await expect(
      generateObject({ model: handle.model, schema: z.object({ required: z.string() }), prompt: "x" }),
    ).rejects.toBeTruthy();
  });

  it("textOnlyStream emits a well-formed finish chunk", () => {
    const chunks = textOnlyStream("hi");
    const finish = chunks.find((c): c is Extract<LanguageModelV3StreamPart, { type: "finish" }> => c.type === "finish");
    expect(finish?.finishReason.unified).toBe("stop");
    expect(finish?.usage.outputTokens.total).toBeGreaterThan(0);
  });

  it("toolCallStream emits a tool-calls finish reason", () => {
    const chunks = toolCallStream({ toolCallId: "x", toolName: "t", input: {} });
    const finish = chunks.find((c): c is Extract<LanguageModelV3StreamPart, { type: "finish" }> => c.type === "finish");
    expect(finish?.finishReason.unified).toBe("tool-calls");
  });
});

describe("loadMockModelFromDir", () => {
  // Hermetic temp dirs so tests don't depend on tests/harness/fixtures layout.
  const tmpDirs: string[] = [];
  function mkFixtureDir(model: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "mock-model-fx-"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ model }), "utf8");
    tmpDirs.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore — best-effort cleanup
      }
    }
  });

  it("propagates unsupportedParams from the fixture file", async () => {
    const dir = mkFixtureDir({
      provider: "mock",
      modelId: "mock-gpt",
      stream: textOnlyStream("hello"),
      unsupportedParams: ["maxOutputTokens"],
    });
    const handle = await loadMockModelFromDir(dir);
    expect(handle).not.toBeNull();
    expect(handle?.unsupportedParams).toEqual(["maxOutputTokens"]);
    // Sanity: the model itself is usable downstream.
    const r = streamText({ model: handle!.model, prompt: "hi" });
    await drainStream(r);
    expect(handle?.calls.length).toBe(1);
  });

  it("propagates defaultProviderOptions from the fixture file", async () => {
    const dir = mkFixtureDir({
      provider: "mock",
      modelId: "mock-gpt",
      stream: textOnlyStream("hello"),
      defaultProviderOptions: { openai: { store: false } },
    });
    const handle = await loadMockModelFromDir(dir);
    expect(handle).not.toBeNull();
    expect(handle?.defaultProviderOptions).toEqual({ openai: { store: false } });
  });

  it("propagates generate (doGenerate JSON) from the fixture file for generateObject", async () => {
    const dir = mkFixtureDir({
      provider: "mock",
      modelId: "mock-gpt",
      stream: textOnlyStream("unused"),
      generate: JSON.stringify({ ok: true, label: "built" }),
    });
    const handle = await loadMockModelFromDir(dir);
    expect(handle).not.toBeNull();
    const { object } = await generateObject({
      model: handle!.model,
      schema: z.object({ ok: z.boolean(), label: z.string() }),
      prompt: "go",
    });
    expect(object).toEqual({ ok: true, label: "built" });
  });

  it("constructs an APICallError from a structured error fixture (drives the humanizeApiError 5xx branch)", async () => {
    // A pure-JSON fixture cannot otherwise build an APICallError (it arrives as
    // a plain string). buildFixtureError() in mock-model.ts upgrades a structured
    // `error` object carrying a statusCode into a real APICallError so harness/
    // unit specs can exercise the orchestrator's status-aware 5xx path.
    const dir = mkFixtureDir({
      provider: "mock",
      modelId: "mock-gpt",
      stream: [
        [
          { type: "stream-start", warnings: [] },
          {
            type: "error",
            error: {
              apiCallError: true,
              statusCode: 500,
              message: "AI_APICallError: Request failed",
              responseBody: JSON.stringify({ code: 60000, message: "Request failed: Unknown error." }),
              url: "https://api.siliconflow.cn/v1/chat/completions",
              isRetryable: true,
            },
          },
          {
            type: "finish",
            finishReason: { unified: "error", raw: null },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: null, cacheWrite: null },
              outputTokens: { total: 0, text: 0, reasoning: null },
            },
          },
        ],
      ] as unknown as LanguageModelV3StreamPart[][],
    });
    const handle = await loadMockModelFromDir(dir);
    expect(handle).not.toBeNull();

    const r = streamText({ model: handle!.model, prompt: "hi" });
    let errPart: { error?: unknown } | null = null;
    for await (const part of r.fullStream) {
      if ((part as { type?: string }).type === "error") errPart = part as { error?: unknown };
    }
    expect(errPart).not.toBeNull();
    expect(APICallError.isInstance(errPart?.error)).toBe(true);
    expect((errPart?.error as APICallError).statusCode).toBe(500);

    // The 5xx branch must surface the canned actionable text + (HTTP 500) and
    // SUPPRESS the opaque provider body (the SiliconFlow "Unknown error" mask).
    const msg = humanizeApiError(errPart?.error);
    expect(msg).toContain("HTTP 500");
    expect(msg.toLowerCase()).toContain("try again later");
    expect(msg).not.toContain("Unknown error");
    expect(msg).not.toContain("Request failed");
  });

  it("supports multi-round stream arrays from the fixture file", async () => {
    const dir = mkFixtureDir({
      provider: "mock",
      modelId: "mock-gpt",
      // Nested array → one entry consumed per doStream call.
      stream: [toolCallStream({ toolCallId: "1", toolName: "echo", input: { msg: "hi" } }), textOnlyStream("done")],
    });
    const handle = await loadMockModelFromDir(dir);
    expect(handle).not.toBeNull();

    const echoTool = tool({
      description: "echo",
      inputSchema: z.object({ msg: z.string() }),
      execute: async ({ msg }: { msg: string }) => `echoed: ${msg}`,
    });

    const r = streamText({
      model: handle!.model,
      prompt: "use echo",
      tools: { echo: echoTool },
      stopWhen: stepCountIs(3),
    });
    await drainStream(r);

    expect(handle?.calls.length).toBe(2);
    expect(handle?.calls[1]?.prompt.length).toBeGreaterThan(handle?.calls[0]?.prompt.length ?? 0);
  });
});
