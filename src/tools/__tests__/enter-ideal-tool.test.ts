import { afterEach, describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { createBuiltinTools } from "../registry.js";

// Feature B2 — agent-callable `enter_ideal` tool. The tool records a pending
// product-loop request via the `enterIdeal` callback and returns a ToolResult;
// the top-level loop is dispatched by the orchestrator after the turn's tool phase.
describe("enter_ideal tool (Feature B2)", () => {
  const prevFlag = process.env.MUONROI_IDEAL_TOOL_ENTRY;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.MUONROI_IDEAL_TOOL_ENTRY;
    else process.env.MUONROI_IDEAL_TOOL_ENTRY = prevFlag;
  });

  it("records the pending request and returns the expected ToolResult", async () => {
    delete process.env.MUONROI_IDEAL_TOOL_ENTRY; // default ON
    let captured: string | null = null;
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent", {
      enterIdeal: (idea) => {
        captured = idea;
      },
    });
    const tool = tools.enter_ideal as unknown as { execute: (input: unknown) => Promise<string> };
    expect(tool).toBeDefined();

    const out = await tool.execute({ idea: "build a per-IP rate limiter" });
    expect(captured).toBe("build a per-IP rate limiter");
    expect(out).toBe("Entering /ideal to build: build a per-IP rate limiter");
  });

  it("rejects an empty idea without recording a request", async () => {
    delete process.env.MUONROI_IDEAL_TOOL_ENTRY;
    let called = false;
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent", {
      enterIdeal: () => {
        called = true;
      },
    });
    const tool = tools.enter_ideal as unknown as { execute: (input: unknown) => Promise<string> };
    const out = await tool.execute({ idea: "   " });
    expect(out).toContain("ERROR");
    expect(called).toBe(false);
  });

  it("is not registered when no enterIdeal callback is wired", () => {
    delete process.env.MUONROI_IDEAL_TOOL_ENTRY;
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent", {});
    expect(tools.enter_ideal).toBeUndefined();
  });

  it("is not registered when the flag is off", () => {
    process.env.MUONROI_IDEAL_TOOL_ENTRY = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent", {
      enterIdeal: () => {},
    });
    expect(tools.enter_ideal).toBeUndefined();
  });
});
