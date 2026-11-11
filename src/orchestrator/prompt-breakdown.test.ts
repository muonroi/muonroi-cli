import type { ModelMessage } from "ai";
import { jsonSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isContextLimitError } from "./error-utils.js";
import { assertRequestFitsContext, createPromptMeasurer } from "./prompt-breakdown.js";
import { __forceFallbackForTests } from "./token-counter.js";

afterEach(() => __forceFallbackForTests(false));

describe("prepared request context guard", () => {
  it("attributes schema costs to native/MCP tools without retaining schema bodies", async () => {
    const measure = await createPromptMeasurer("system", {
      read_file: { description: "NATIVE_SENTINEL", inputSchema: jsonSchema({ type: "object" }) },
      mcp_docs__search: {
        description: "SCHEMA_SENTINEL",
        inputSchema: jsonSchema({ type: "object", properties: { private: { type: "string" } } }),
      },
    });
    const measured = measure([]);
    expect(measured.nativeToolsChars + measured.mcpToolsChars).toBe(measured.toolsChars);
    expect(measure.toolSchemas.map((row) => row.origin)).toEqual(["native", "mcp"]);
    expect(measure.toolSchemas.reduce((sum, row) => sum + row.totalChars, 0)).toBe(measured.toolsChars);
    expect(JSON.stringify(measure.toolSchemas)).not.toContain("SENTINEL");
    expect(measure.toolSchemas[1]!.inputSchemaChars).toBeGreaterThan(0);
  });
  it("includes system, full tool results, tool schemas and completion reserve", async () => {
    __forceFallbackForTests(true);
    const measure = await createPromptMeasurer("s".repeat(4000), {
      fixture: {
        description: "d".repeat(4000),
        inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      },
    });
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "big",
            toolName: "fixture",
            output: { type: "text", value: "x".repeat(40000) },
          },
        ],
      },
    ] as ModelMessage[];
    const breakdown = measure(messages);
    expect(breakdown.estimatedInputTokens).toBeGreaterThan(12000);
    expect(() => assertRequestFitsContext(breakdown.estimatedInputTokens, 13000, 2000)).toThrow(/context.*overflow/i);
  });

  it("rejects a preserve-context branch before the provider runs", async () => {
    const measure = await createPromptMeasurer("system", {});
    const messages = [
      { role: "assistant", content: "PRESERVE_FULL_CONTEXT" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "big",
            toolName: "history",
            output: { type: "text", value: "unbounded history ".repeat(10000) },
          },
        ],
      },
    ] as ModelMessage[];
    const provider = vi.fn();
    let error: unknown;
    try {
      assertRequestFitsContext(measure(messages).estimatedInputTokens, 12000, 2048);
      provider();
    } catch (err) {
      error = err;
    }
    expect(provider).not.toHaveBeenCalled();
    expect(isContextLimitError(error)).toBe(true);
  });

  it("allows an exact fit and leaves unknown catalog windows alone", () => {
    expect(() => assertRequestFitsContext(800, 1000, 200)).not.toThrow();
    expect(() => assertRequestFitsContext(801, 1000, 200)).toThrow();
    expect(() => assertRequestFitsContext(1000000, 0, 200)).not.toThrow();
  });
});
