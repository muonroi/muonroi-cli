/**
 * Unit tests for recording.ts. Drives a MockLanguageModelV3 directly with
 * crafted prompts and asserts every helper reads the shape it claims to.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";

import { createMockModel, dumpRecordings, textOnlyStream } from "../../src/agent-harness/mock-model.js";
import {
  assertParamAbsent,
  assertParamPresent,
  cumulativePromptChars,
  getProviderOption,
  inspectAll,
  inspectByRole,
  loadDumpedRecordings,
} from "./recording.js";

// biome-ignore lint/suspicious/noExplicitAny: streamText result generic is provider-specific
async function drain(result: { fullStream: AsyncIterable<any> }): Promise<void> {
  for await (const _ of result.fullStream) {
    // discard
  }
}

describe("recording helpers", () => {
  it("inspectAll captures every call with extracted system/user/assistant text", async () => {
    const handle = createMockModel({ stream: textOnlyStream("ok") });

    const result = streamText({
      model: handle.model,
      system: "You are the top-level assistant.",
      messages: [{ role: "user", content: "ping" }],
    });
    await drain(result);

    const calls = inspectAll(handle);
    expect(calls.length).toBe(1);
    expect(calls[0]?.systemText).toContain("top-level assistant");
    expect(calls[0]?.userText).toBe("ping");
    expect(calls[0]?.role).toBe("top-level");
    expect(calls[0]?.promptChars).toBeGreaterThan(0);
  });

  it("inspectByRole detects sub-agent prompts via the 'You are the X sub-agent' marker", async () => {
    const handle = createMockModel({ stream: textOnlyStream("ok") });

    const result = streamText({
      model: handle.model,
      system: "You are the Explore sub-agent. You are read-only.",
      messages: [{ role: "user", content: "research" }],
    });
    await drain(result);

    expect(inspectByRole(handle, "sub-agent").length).toBe(1);
    expect(inspectByRole(handle, "top-level").length).toBe(0);
  });

  it("cumulativePromptChars sums across all rounds", async () => {
    const handle = createMockModel({
      stream: [textOnlyStream("a"), textOnlyStream("b")],
    });
    for (const msg of ["first", "second"]) {
      const r = streamText({ model: handle.model, system: "sys", messages: [{ role: "user", content: msg }] });
      await drain(r);
    }
    const total = cumulativePromptChars(handle);
    // sys + first + sys + second ≈ at least 20 chars
    expect(total).toBeGreaterThan(15);
  });

  it("assertParamAbsent throws when the param is set", () => {
    const call = { prompt: [] as LanguageModelV3Prompt, maxOutputTokens: 100 } as LanguageModelV3CallOptions;
    expect(() => assertParamAbsent(call, "maxOutputTokens")).toThrow(/expected maxOutputTokens to be omitted/);
  });

  it("assertParamAbsent passes when the param is undefined", () => {
    const call = { prompt: [] as LanguageModelV3Prompt } as LanguageModelV3CallOptions;
    expect(() => assertParamAbsent(call, "maxOutputTokens")).not.toThrow();
  });

  it("assertParamPresent throws when the param is undefined", () => {
    const call = { prompt: [] as LanguageModelV3Prompt } as LanguageModelV3CallOptions;
    expect(() => assertParamPresent(call, "temperature")).toThrow(/expected temperature to be present/);
  });

  it("dumpRecordings + loadDumpedRecordings round-trip matches inspectAll", async () => {
    const handle = createMockModel({ stream: textOnlyStream("done") });
    const result = streamText({
      model: handle.model,
      system: "You are the top-level assistant.",
      messages: [{ role: "user", content: "hello" }],
    });
    await drain(result);

    const dir = mkdtempSync(join(tmpdir(), "muonroi-h3-"));
    const path = join(dir, "calls.json");
    try {
      dumpRecordings(path, handle.model);
      const loaded = loadDumpedRecordings(path);
      const live = inspectAll(handle);
      expect(loaded.length).toBe(live.length);
      expect(loaded[0]?.systemText).toBe(live[0]?.systemText);
      expect(loaded[0]?.userText).toBe(live[0]?.userText);
      expect(loaded[0]?.role).toBe(live[0]?.role);
      expect(loaded[0]?.promptChars).toBe(live[0]?.promptChars);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getProviderOption extracts nested providerOptions values", () => {
    const call = {
      prompt: [] as LanguageModelV3Prompt,
      providerOptions: { openai: { promptCacheKey: "sha-abc" } },
    } as LanguageModelV3CallOptions;
    expect(getProviderOption<string>(call, "openai", "promptCacheKey")).toBe("sha-abc");
    expect(getProviderOption(call, "openai", "missing")).toBeUndefined();
  });
});
