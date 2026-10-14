/**
 * P0-5b — provider-boundary guard against native tool-call markup leaking into
 * a user-visible answer (see src/providers/tool-markup-guard.ts).
 *
 * Two properties are pinned here and they pull in opposite directions:
 *   - a MEASURED leak (the whole content is one well-formed block, on a request
 *     with no tool schemas) must never reach the caller as text;
 *   - legitimate prose that QUOTES the same markup must survive byte-for-byte,
 *     including when it is delivered split across stream chunks.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../models/registry.js";
import { getProviderCapabilities } from "./capabilities.js";
import { resolveModelRuntime } from "./runtime.js";
import {
  couldStillBeWholeMarkup,
  guardStream,
  isWholeContentToolCallMarkup,
  ToolCallMarkupLeakError,
  wrapModelWithToolMarkupGuard,
} from "./tool-markup-guard.js";

/** The verbatim 101-char leak captured against api.stepfun.ai on 2026-09-04. */
const MEASURED_LEAK = `<tool_call>
<function=read_file>
<parameter=path>
src/config.js
</parameter>
</function>
</tool_call>`;

function streamOf(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/** Build the text-part sequence a provider emits for `chunks`. */
function textParts(chunks: string[]): unknown[] {
  return [
    { type: "text-start", id: "0" },
    ...chunks.map((delta) => ({ type: "text-delta", id: "0", delta })),
    { type: "text-end", id: "0" },
  ];
}

function textOf(parts: unknown[]): string {
  return parts
    .filter((p) => (p as { type?: string })?.type === "text-delta")
    .map((p) => (p as { delta: string }).delta)
    .join("");
}

describe("isWholeContentToolCallMarkup — leak signature", () => {
  it("recognises the measured StepFun leak verbatim", () => {
    expect(isWholeContentToolCallMarkup(MEASURED_LEAK)).toBe(true);
  });

  it("recognises it with surrounding whitespace", () => {
    expect(isWholeContentToolCallMarkup(`\n\n  ${MEASURED_LEAK}\n `)).toBe(true);
  });

  it("recognises two back-to-back blocks", () => {
    expect(isWholeContentToolCallMarkup(`${MEASURED_LEAK}\n${MEASURED_LEAK}`)).toBe(true);
  });

  it("rejects empty and whitespace-only content", () => {
    expect(isWholeContentToolCallMarkup("")).toBe(false);
    expect(isWholeContentToolCallMarkup("   \n ")).toBe(false);
  });

  it("rejects an unterminated block (not well-formed)", () => {
    expect(isWholeContentToolCallMarkup("<tool_call>\n<function=read_file>")).toBe(false);
  });
});

describe("isWholeContentToolCallMarkup — false positives must not fire", () => {
  it("leaves prose that mentions the markup inline", () => {
    expect(isWholeContentToolCallMarkup(`The model emits ${MEASURED_LEAK} instead of prose.`)).toBe(false);
  });

  it("leaves a fenced quotation of the markup", () => {
    const FENCE = "```";
    expect(isWholeContentToolCallMarkup(`${FENCE}\n${MEASURED_LEAK}\n${FENCE}`)).toBe(false);
  });

  it("leaves an answer that introduces the block then ends", () => {
    expect(isWholeContentToolCallMarkup(`Here is what StepFun returns:\n${MEASURED_LEAK}`)).toBe(false);
  });

  it("leaves ordinary prose with no markup at all", () => {
    expect(isWholeContentToolCallMarkup("I read src/config.js and it exports the default port.")).toBe(false);
  });
});

describe("couldStillBeWholeMarkup — hold-back decision", () => {
  it("keeps holding on nothing, a partial opening tag, or an open block", () => {
    expect(couldStillBeWholeMarkup("")).toBe(true);
    expect(couldStillBeWholeMarkup("\n ")).toBe(true);
    expect(couldStillBeWholeMarkup("<tool_c")).toBe(true);
    expect(couldStillBeWholeMarkup("<tool_call>\n<function=read")).toBe(true);
    expect(couldStillBeWholeMarkup(MEASURED_LEAK)).toBe(true);
  });

  it("stops holding the moment real prose appears", () => {
    expect(couldStillBeWholeMarkup("H")).toBe(false);
    expect(couldStillBeWholeMarkup("Here is")).toBe(false);
    expect(couldStillBeWholeMarkup(`${MEASURED_LEAK} and that is why.`)).toBe(false);
  });
});

describe("guardStream", () => {
  const ctx = { modelId: "test-model" };

  it("suppresses a whole-content leak split across chunks and raises a typed error", async () => {
    const chunks = [MEASURED_LEAK.slice(0, 5), MEASURED_LEAK.slice(5, 40), MEASURED_LEAK.slice(40)];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await collect(
      guardStream(
        streamOf([
          { type: "stream-start", warnings: [] },
          ...textParts(chunks),
          { type: "finish", finishReason: "stop", usage: {} },
        ]),
        ctx,
      ),
    );
    warn.mockRestore();

    expect(out.filter((p) => (p as { type?: string }).type === "text-delta")).toHaveLength(0);
    expect(out.filter((p) => (p as { type?: string }).type === "text-start")).toHaveLength(0);
    const err = out.find((p) => (p as { type?: string }).type === "error") as { error: unknown } | undefined;
    expect(err?.error).toBeInstanceOf(ToolCallMarkupLeakError);
    expect((err?.error as ToolCallMarkupLeakError).suppressed).toBe(MEASURED_LEAK);
    // the finish part is still forwarded so the SDK closes the call normally
    expect(out.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("suppresses a leak even when the stream ends without a finish part", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await collect(guardStream(streamOf(textParts([MEASURED_LEAK])), ctx));
    warn.mockRestore();
    expect(textOf(out)).toBe("");
    expect(out.some((p) => (p as { type?: string }).type === "error")).toBe(true);
  });

  it("passes legitimate prose quoting the markup through byte-for-byte", async () => {
    const answer = `StepFun answers with:\n${MEASURED_LEAK}\nwhich we strip.`;
    // deliberately split INSIDE the markup so the hold-back path is exercised
    const chunks = [answer.slice(0, 30), answer.slice(30, 90), answer.slice(90)];
    const out = await collect(
      guardStream(streamOf([...textParts(chunks), { type: "finish", finishReason: "stop", usage: {} }]), ctx),
    );
    expect(textOf(out)).toBe(answer);
    expect(out.some((p) => (p as { type?: string }).type === "error")).toBe(false);
    expect(out.filter((p) => (p as { type?: string }).type === "text-start")).toHaveLength(1);
  });

  it("passes an answer that OPENS with the markup and then continues", async () => {
    const answer = `${MEASURED_LEAK}\n\nThat block is what leaks.`;
    const out = await collect(
      guardStream(streamOf([...textParts([answer]), { type: "finish", finishReason: "stop", usage: {} }]), ctx),
    );
    expect(textOf(out)).toBe(answer);
    expect(out.some((p) => (p as { type?: string }).type === "error")).toBe(false);
  });

  it("passes ordinary prose through unchanged and in order", async () => {
    const parts = [
      { type: "stream-start", warnings: [] },
      ...textParts(["Hello ", "world"]),
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const out = await collect(guardStream(streamOf(parts), ctx));
    expect(out).toEqual(parts);
  });

  it("stops inspecting as soon as a real tool call arrives", async () => {
    const parts = [
      ...textParts([MEASURED_LEAK]),
      { type: "tool-call", toolCallId: "1", toolName: "read_file", input: "{}" },
      { type: "finish", finishReason: "tool-calls", usage: {} },
    ];
    const out = await collect(guardStream(streamOf(parts), ctx));
    expect(textOf(out)).toBe(MEASURED_LEAK);
    expect(out.some((p) => (p as { type?: string }).type === "error")).toBe(false);
  });
});

/** Minimal LanguageModelV3-shaped stub; only the fields the guard reads matter. */
function stubModel(over: Record<string, unknown>) {
  return {
    specificationVersion: "v3" as const,
    provider: "stub",
    modelId: "stub-model",
    supportedUrls: {},
    doGenerate: async () => ({ content: [], finishReason: "stop", usage: {}, warnings: [] }),
    doStream: async () => ({ stream: streamOf([]) }),
    ...over,
  };
}

describe("wrapModelWithToolMarkupGuard", () => {
  it("returns the model untouched when the capability is off", () => {
    const model = stubModel({});
    // biome-ignore lint/suspicious/noExplicitAny: minimal model stub
    expect(wrapModelWithToolMarkupGuard(model as any, { enabled: false, modelId: "m" })).toBe(model);
  });

  it("throws a typed error on doGenerate when the whole answer is markup and no tools were sent", async () => {
    const model = stubModel({
      doGenerate: async () => ({
        content: [{ type: "text", text: MEASURED_LEAK }],
        finishReason: "stop",
        usage: {},
        warnings: [],
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: minimal model stub
    const wrapped = wrapModelWithToolMarkupGuard(model as any, { enabled: true, modelId: "step-3.7-flash" });
    await expect(wrapped.doGenerate({ prompt: [] })).rejects.toBeInstanceOf(ToolCallMarkupLeakError);
    warn.mockRestore();
  });

  it("does NOT engage when the request carried real tool schemas (measured case e)", async () => {
    const model = stubModel({
      doGenerate: async () => ({
        content: [{ type: "text", text: MEASURED_LEAK }],
        finishReason: "stop",
        usage: {},
        warnings: [],
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal model stub
    const wrapped = wrapModelWithToolMarkupGuard(model as any, { enabled: true, modelId: "step-3.7-flash" });
    const res = await wrapped.doGenerate({
      prompt: [],
      tools: [{ type: "function", name: "read_file", inputSchema: {} }],
    });
    expect(res.content[0].text).toBe(MEASURED_LEAK);
  });

  it("leaves a doGenerate answer that merely quotes the markup", async () => {
    const answer = `The provider returns ${MEASURED_LEAK} verbatim.`;
    const model = stubModel({
      doGenerate: async () => ({
        content: [{ type: "text", text: answer }],
        finishReason: "stop",
        usage: {},
        warnings: [],
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal model stub
    const wrapped = wrapModelWithToolMarkupGuard(model as any, { enabled: true, modelId: "step-3.7-flash" });
    const res = await wrapped.doGenerate({ prompt: [] });
    expect(res.content[0].text).toBe(answer);
  });
});

describe("capability wiring — no provider id is compared at a call site", () => {
  it("arms StepFun by default", () => {
    expect(getProviderCapabilities("stepfun").emitsNativeToolCallMarkup(undefined)).toBe(true);
  });

  it("leaves every other provider disarmed by default", () => {
    for (const id of ["anthropic", "openai", "deepseek", "xai", "zai", "ollama", "opencode-go", "unknown-provider"]) {
      expect(getProviderCapabilities(id).emitsNativeToolCallMarkup(undefined)).toBe(false);
    }
  });

  it("lets catalog.json opt any model in, and opt a StepFun model out", () => {
    // biome-ignore lint/suspicious/noExplicitAny: partial ModelInfo is enough here
    const on = { emitsNativeToolCallMarkup: true } as any;
    // biome-ignore lint/suspicious/noExplicitAny: partial ModelInfo is enough here
    const off = { emitsNativeToolCallMarkup: false } as any;
    expect(getProviderCapabilities("deepseek").emitsNativeToolCallMarkup(on)).toBe(true);
    expect(getProviderCapabilities("stepfun").emitsNativeToolCallMarkup(off)).toBe(false);
  });
});

/**
 * The wiring itself. Without this, deleting the `wrapModelWithToolMarkupGuard`
 * call in `resolveModelRuntime` would leave every other spec in this file green
 * while the CLI leaked markup again.
 */
describe("resolveModelRuntime arms the guard from the capability layer", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the mock-model hook is an untyped global
  const g = globalThis as any;
  const prev = g.__muonroiMockModel;

  beforeAll(async () => {
    await loadCatalog();
  });
  afterEach(() => {
    g.__muonroiMockModel = prev;
  });

  function installLeakingMock() {
    g.__muonroiMockModel = stubModel({
      doGenerate: async () => ({
        content: [{ type: "text", text: MEASURED_LEAK }],
        finishReason: "stop",
        usage: {},
        warnings: [],
      }),
    });
  }

  it("guards a StepFun model resolved through the real factory", async () => {
    installLeakingMock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = resolveModelRuntime("step-3.7-flash");
    await expect(runtime.model.doGenerate({ prompt: [] })).rejects.toBeInstanceOf(ToolCallMarkupLeakError);
    warn.mockRestore();
  });

  it("leaves a model from a provider without the quirk untouched", async () => {
    installLeakingMock();
    const runtime = resolveModelRuntime("deepseek-v4-pro");
    const res = await runtime.model.doGenerate({ prompt: [] });
    expect(res.content[0].text).toBe(MEASURED_LEAK);
  });
});
