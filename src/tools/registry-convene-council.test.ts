import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCouncilConveneForTests,
  consumeCouncilConvene,
  hasPendingCouncilConvene,
  peekCouncilConveneToolCallId,
} from "../orchestrator/council-request.js";
import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "./registry.js";

afterEach(() => __resetCouncilConveneForTests());

describe("convene_council tool registration + queueing", () => {
  it("is registered only when councilConfigured is true", () => {
    const bash = new BashTool(os.tmpdir());
    expect(createBuiltinTools(bash, "agent", { councilConfigured: true }).convene_council).toBeDefined();
    expect(createBuiltinTools(bash, "agent", { councilConfigured: false }).convene_council).toBeUndefined();
    // Omitted (default) → absent.
    expect(createBuiltinTools(bash, "agent").convene_council).toBeUndefined();
  });

  it("execute queues a convene request with the reason and toolCallId", async () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { councilConfigured: true });
    const tool = tools.convene_council as unknown as {
      execute: (input: unknown, opts?: { toolCallId?: string }) => Promise<string>;
    };
    expect(hasPendingCouncilConvene()).toBe(false);
    const out = await tool.execute({ reason: "conflicting tradeoffs" }, { toolCallId: "tc-42" });
    expect(out).toMatch(/Council convening/i);
    expect(hasPendingCouncilConvene()).toBe(true);
    expect(peekCouncilConveneToolCallId()).toBe("tc-42");
    expect(consumeCouncilConvene()).toEqual({ reason: "conflicting tradeoffs", toolCallId: "tc-42" });
  });

  it("execute tolerates a missing reason", async () => {
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { councilConfigured: true });
    const tool = tools.convene_council as unknown as {
      execute: (input: unknown, opts?: { toolCallId?: string }) => Promise<string>;
    };
    await tool.execute({}, { toolCallId: "tc-1" });
    expect(consumeCouncilConvene()).toEqual({ reason: null, toolCallId: "tc-1" });
  });
});
