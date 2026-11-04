import { afterEach, describe, expect, it, vi } from "vitest";
import { BashTool } from "./bash.js";
import { createBuiltinTools } from "./registry.js";

const originalTuiActive = (globalThis as Record<string, unknown>).__muonroiTuiActive;
afterEach(() => {
  (globalThis as Record<string, unknown>).__muonroiTuiActive = originalTuiActive;
});

describe("task executor compatibility", () => {
  it.each([
    "general",
    "explore",
  ])("owning TUI honors explicit foreground %s and does not take the async research branch", async (agent) => {
    (globalThis as Record<string, unknown>).__muonroiTuiActive = true;
    let settle!: () => void;
    const runTask = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { success: true, output: "terminal worker result" };
    });
    const runDelegation = vi.fn(async () => ({ success: true, output: "async receipt" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { executionRole: "orchestrator", runTask, runDelegation });
      let returned = false;
      const result = Promise.resolve(
        tools.task!.execute!(
          { agent, description: "bounded", prompt: "work", modelId: "fixture-model", background: false },
          {} as never,
        ),
      ).then((value) => {
        returned = true;
        return value;
      });
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ agent, background: false }));
      expect(runDelegation).not.toHaveBeenCalled();
      settle();
      expect(await result).toBe("terminal worker result");
    } finally {
      await bash.cleanup();
    }
  });

  it.each([undefined, true])("owning TUI default/true %s stays asynchronous", async (background) => {
    (globalThis as Record<string, unknown>).__muonroiTuiActive = true;
    const runTask = vi.fn(async () => ({ success: true, output: "async receipt" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { executionRole: "orchestrator", runTask });
      expect(
        await tools.task!.execute!(
          {
            agent: "general",
            description: "bounded",
            prompt: "work",
            modelId: "fixture-model",
            ...(background === undefined ? {} : { background }),
          },
          {} as never,
        ),
      ).toBe("async receipt");
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ background: true }));
      expect(Object.keys(tools).some((name) => /approv.*decis|respondToWorkerApproval/i.test(name))).toBe(false);
    } finally {
      await bash.cleanup();
    }
  });
  it("passes an explicit execution workspace through the native task boundary", async () => {
    const runTask = vi.fn(async () => ({ success: true, output: "started" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { runTask });
      await tools.task.execute!(
        { agent: "verify", description: "CLI tests", prompt: "Run assigned tests", cwd: "/explicit/workspace" },
        {} as never,
      );
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/explicit/workspace" }));
    } finally {
      await bash.cleanup();
    }
  });

  it("forwards an explicit handled-result acknowledgement without changing its version", async () => {
    const acknowledgeDelegation = vi.fn(async () => ({ success: true, output: "acknowledged" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { acknowledgeDelegation });
      expect(
        await tools.delegation_ack.execute!(
          { jobId: "owned-worker", resultVersion: "version-from-result" },
          {} as never,
        ),
      ).toBe("acknowledged");
      expect(acknowledgeDelegation).toHaveBeenCalledWith("owned-worker", "version-from-result");
    } finally {
      await bash.cleanup();
    }
  });

  it("requests background execution for native tasks in the interactive TUI", async () => {
    (globalThis as Record<string, unknown>).__muonroiTuiActive = true;
    const runTask = vi.fn(async () => ({ success: true, output: "started" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { runTask });
      await tools.task.execute!({ agent: "general", description: "worker", prompt: "work" }, {} as never);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ agent: "general", background: true }));
    } finally {
      await bash.cleanup();
    }
  });

  it("honors an explicit foreground task in the TUI", async () => {
    (globalThis as Record<string, unknown>).__muonroiTuiActive = true;
    const runTask = vi.fn(async () => ({ success: true, output: "completed" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { runTask });
      await tools.task.execute!(
        { agent: "general", description: "worker", prompt: "work", background: false },
        {} as never,
      );
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ background: false }));
    } finally {
      await bash.cleanup();
    }
  });

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
