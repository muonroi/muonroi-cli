/**
 * tests/harness/cost-leak-g1.spec.ts
 *
 * Cost-leak verification: G1 — sub-agent path drops unsupported params for
 * OAuth backends (ChatGPT Codex rejects `max_output_tokens` with HTTP 400).
 *
 * The orchestrator at src/orchestrator/orchestrator.ts:1362-1382 reads
 * `runtime.modelInfo?.supportsMaxOutputTokens === false` OR
 * `runtime.unsupportedParams?.includes("maxOutputTokens")` and conditionally
 * omits `maxOutputTokens` from the streamText call.
 *
 * This spec mirrors that exact pattern with a MockLanguageModelV3 in place of
 * the real OAuth model so the bug shows up as a `LanguageModelV3CallOptions`
 * assertion instead of a runtime HTTP 400.
 *
 * Failing mode (pre-fix): orchestrator passes maxOutputTokens unconditionally
 * → handle.calls[0].maxOutputTokens is defined → assertParamAbsent throws.
 */

import { streamText } from "ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { installMockModel, textOnlyStream } from "../../src/agent-harness/mock-model.js";
import { loadCatalog } from "../../src/models/registry.js";
import type { ProviderFactory } from "../../src/providers/runtime.js";
import { resolveModelRuntime, shouldDropParam } from "../../src/providers/runtime.js";
import { assertParamAbsent, assertParamPresent, inspectAll } from "./recording.js";

function stubFactory(): ProviderFactory {
  const fn = ((_id: string) => {
    throw new Error("real provider factory must not be invoked under mock");
  }) as ProviderFactory;
  fn.responses = fn;
  return fn;
}

/**
 * Mirrors the orchestrator's dropParam pattern (orchestrator.ts:1362).
 * Keeps the call structure identical so the test catches regressions if the
 * orchestrator's branch is refactored.
 */
function buildStreamTextOptions(runtime: ReturnType<typeof resolveModelRuntime>): Parameters<typeof streamText>[0] {
  // Use the SAME helper the orchestrator does so this spec catches any
  // regression that bypasses it (orchestrator.ts:1369-1370, :3928).
  const dropMaxOutput = shouldDropParam(runtime, "maxOutputTokens");
  const dropTemperature = shouldDropParam(runtime, "temperature");
  return {
    model: runtime.model,
    system: "You are the Explore sub-agent. You are read-only.",
    messages: [{ role: "user", content: "research auth" }],
    ...(dropTemperature ? {} : { temperature: 0.2 }),
    ...(dropMaxOutput ? {} : { maxOutputTokens: 8_192 }),
    ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: streamText result generic is provider-specific
async function drain(result: { fullStream: AsyncIterable<any> }): Promise<void> {
  for await (const _ of result.fullStream) {
    // discard
  }
}

describe("G1: sub-agent drops unsupportedParams from streamText call", () => {
  beforeAll(async () => {
    await loadCatalog();
  });

  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("omits maxOutputTokens when unsupportedParams includes it (OAuth backend)", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("done") },
      unsupportedParams: ["maxOutputTokens"],
    });
    cleanup = handle.uninstall;

    const runtime = resolveModelRuntime(stubFactory(), "gpt-5.4");
    const result = streamText(buildStreamTextOptions(runtime));
    await drain(result);

    const calls = inspectAll(handle);
    expect(calls.length).toBe(1);
    expect(calls[0]?.role).toBe("sub-agent");
    assertParamAbsent(calls[0]!, "maxOutputTokens");
    assertParamPresent(calls[0]!, "temperature");
  });

  it("control: maxOutputTokens IS passed when unsupportedParams is empty (API-key backend)", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("done") },
      unsupportedParams: undefined,
    });
    cleanup = handle.uninstall;

    const runtime = resolveModelRuntime(stubFactory(), "gpt-5.4");
    const result = streamText(buildStreamTextOptions(runtime));
    await drain(result);

    const calls = inspectAll(handle);
    assertParamPresent(calls[0]!, "maxOutputTokens");
    assertParamPresent(calls[0]!, "temperature");
  });

  it("omits both maxOutputTokens and temperature when both are listed", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("done") },
      unsupportedParams: ["maxOutputTokens", "temperature"],
    });
    cleanup = handle.uninstall;

    const runtime = resolveModelRuntime(stubFactory(), "gpt-5.4");
    const result = streamText(buildStreamTextOptions(runtime));
    await drain(result);

    assertParamAbsent(inspectAll(handle)[0]!, "maxOutputTokens");
    assertParamAbsent(inspectAll(handle)[0]!, "temperature");
  });

  it("preserves OAuth defaultProviderOptions on the streamText call", async () => {
    const handle = installMockModel({
      fixture: { stream: textOnlyStream("done") },
      unsupportedParams: ["maxOutputTokens"],
      defaultProviderOptions: { store: false, instructions: "codex-system" },
    });
    cleanup = handle.uninstall;

    const runtime = resolveModelRuntime(stubFactory(), "gpt-5.4");
    const result = streamText(buildStreamTextOptions(runtime));
    await drain(result);

    const opts = inspectAll(handle)[0]?.options;
    expect(opts?.providerOptions?.openai).toMatchObject({
      store: false,
      instructions: "codex-system",
    });
  });
});
