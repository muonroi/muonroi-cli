import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AskUserAskInfo } from "../orchestrator/ask-user.js";
import { BashTool } from "../tools/bash.js";
import { createBuiltinTools } from "./registry.js";

describe("ask_user tool registration + execute", () => {
  it("is registered only when an askUser handler is provided", () => {
    const bash = new BashTool(os.tmpdir());
    const askUser = async () => "answer";
    expect(createBuiltinTools(bash, "agent", { askUser }).ask_user).toBeDefined();
    // No handler → absent, so the model never calls a card that can't be answered.
    expect(createBuiltinTools(bash, "agent").ask_user).toBeUndefined();
    expect(createBuiltinTools(bash, "agent", {}).ask_user).toBeUndefined();
  });

  it("forwards question + agent-supplied options to the handler and returns its answer", async () => {
    const seen: AskUserAskInfo[] = [];
    const askUser = vi.fn(async (info: AskUserAskInfo) => {
      seen.push(info);
      return "proceed";
    });
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { askUser });
    const tool = tools.ask_user as unknown as { execute: (input: unknown) => Promise<string> };

    const out = await tool.execute({
      question: "Proceed with implementation?",
      options: [{ label: "Yes" }, { label: "No", description: "refine first" }],
      defaultIndex: 0,
    });

    expect(askUser).toHaveBeenCalledOnce();
    expect(seen[0].question).toBe("Proceed with implementation?");
    expect(seen[0].options?.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(out).toMatch(/proceed/i);
  });

  it("rejects an empty question without calling the handler", async () => {
    const askUser = vi.fn(async () => "x");
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { askUser });
    const tool = tools.ask_user as unknown as { execute: (input: unknown) => Promise<string> };

    const out = await tool.execute({ question: "   " });
    expect(askUser).not.toHaveBeenCalled();
    expect(out).toMatch(/requires a non-empty/i);
  });

  it("omits options when none are supplied (free-text ask)", async () => {
    let received: AskUserAskInfo | null = null;
    const askUser = async (info: AskUserAskInfo) => {
      received = info;
      return "my-ledger";
    };
    const tools = createBuiltinTools(new BashTool(os.tmpdir()), "agent", { askUser });
    const tool = tools.ask_user as unknown as { execute: (input: unknown) => Promise<string> };
    await tool.execute({ question: "Ledger name?" });
    expect(received!.options).toBeUndefined();
  });
});
