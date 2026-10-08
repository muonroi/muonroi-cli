import { describe, expect, it, vi } from "vitest";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

describe("task executor compatibility", () => {
  it.each(["general", "verify"])("keeps long %s work on the foreground executor", async (agent) => {
    const runTask = vi.fn(async () => ({ success: true, output: "foreground" }));
    const runDelegation = vi.fn(async () => ({ success: false, output: "read-only" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { runTask, runDelegation });
      const result = await tools.task.execute!(
        { agent, description: "bounded work", prompt: "work", maxToolRounds: 26 },
        {} as never,
      );
      expect(result).toBe("foreground");
      expect(runTask).toHaveBeenCalledOnce();
      expect(runDelegation).not.toHaveBeenCalled();
    } finally {
      await bash.cleanup();
    }
  });

  it("keeps explore as a background helper", async () => {
    const runTask = vi.fn();
    const runDelegation = vi.fn(async () => ({ success: true, output: "background" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { runTask, runDelegation });
      await tools.task.execute!(
        { agent: "explore", description: "inspect", prompt: "inspect", maxToolRounds: 60 },
        {} as never,
      );
      expect(runDelegation).toHaveBeenCalledOnce();
      expect(runTask).not.toHaveBeenCalled();
    } finally {
      await bash.cleanup();
    }
  });
});
