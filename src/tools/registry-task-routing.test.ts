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

  it("exposes no model-called delegation_ack: the host acknowledges processed results", async () => {
    const fn = vi.fn(async () => ({ success: true, output: "" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { readDelegation: fn, executionRole: "orchestrator" });
      expect(tools.delegation_ack).toBeUndefined();
      expect(tools.delegation_read).toBeDefined();
    } finally {
      await bash.cleanup();
    }
  });

  it("assembles the structured brief into the worker prompt and keeps a plain prompt working", async () => {
    const runTask = vi.fn(async () => ({ success: true, output: "done" }));
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { runTask });
      const brief = {
        role: "implementer",
        scope: "src/a.ts",
        input: "issue #1",
        question: "fix the parser",
        exclusions: "no refactors",
        budget: "10 steps",
        evidence: "file:line of the change",
      };
      await tools.task.execute!(
        { agent: "general", description: "fix", brief, prompt: "keep tabs", writeScope: ["src/a.ts"] },
        {} as never,
      );
      const prompt = (runTask.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
      expect(prompt).toContain(
        "Role: implementer\nScope/workspace: src/a.ts\nInput: issue #1\nQuestion: fix the parser",
      );
      expect(prompt).toContain("Return evidence: file:line of the change\n\nAdditional instructions:\nkeep tabs");

      await tools.task.execute!({ agent: "verify", description: "t", prompt: "plain prompt" }, {} as never);
      expect((runTask.mock.calls[1] as unknown as [{ prompt: string }])[0].prompt).toBe("plain prompt");

      const incomplete = await tools.task.execute!(
        { agent: "general", description: "t", brief: { ...brief, budget: " " } },
        {} as never,
      );
      expect(String(incomplete)).toMatch(/^worker_brief_incomplete: brief is missing budget/);
      expect(runTask).toHaveBeenCalledTimes(2);
    } finally {
      await bash.cleanup();
    }
  });

  it("builds task/delegate modelId as an enum of the supplied live worker inventory", async () => {
    const fn = vi.fn(async () => ({ success: true, output: "" }));
    const bash = new BashTool(process.cwd());
    try {
      const schemaOf = (tool: unknown) =>
        (tool as { inputSchema: { jsonSchema: { properties: Record<string, Record<string, unknown>> } } }).inputSchema
          .jsonSchema.properties;
      const withIds = createBuiltinTools(bash, "agent", {
        runTask: fn,
        runDelegation: fn,
        executionRole: "orchestrator",
        workerModelIds: ["inventory-a", "inventory-b"],
      });
      expect(schemaOf(withIds.task).modelId!.enum).toEqual(["inventory-a", "inventory-b"]);
      expect(schemaOf(withIds.delegate).modelId!.enum).toEqual(["inventory-a", "inventory-b"]);
      const withoutIds = createBuiltinTools(bash, "agent", { runTask: fn, executionRole: "orchestrator" });
      expect(schemaOf(withoutIds.task).modelId!.enum).toBeUndefined();
    } finally {
      await bash.cleanup();
    }
  });

  it("routes a jobId or resultVersion passed to retrieve_tool_result to delegation_read", async () => {
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", {});
      const job = String(await tools.retrieve_tool_result.execute!({ tool_call_id: "steady-teal-otter" }, {} as never));
      expect(job).toMatch(/^ERROR id_kind_mismatch: "steady-teal-otter" is a delegation jobId/);
      expect(job).toContain('delegation_read({id:"steady-teal-otter"})');
      const version = String(await tools.retrieve_tool_result.execute!({ tool_call_id: "a".repeat(64) }, {} as never));
      expect(version).toMatch(/is a resultVersion\/digest \(sha256\), not a tool_call_id/);
    } finally {
      await bash.cleanup();
    }
  });

  it("refuses ask_user questions that expose internal coordination IDs", async () => {
    const askUser = vi.fn(async () => "yes");
    const bash = new BashTool(process.cwd());
    try {
      const tools = createBuiltinTools(bash, "agent", { askUser });
      const refused = String(
        await tools.ask_user.execute!({ question: "Should I re-run jobId calm-blue-fox?" }, {} as never),
      );
      expect(refused).toMatch(
        /^ERROR: ask_user_refused: the question contains the internal identifier "calm-blue-fox"/,
      );
      const refusedField = String(
        await tools.ask_user.execute!(
          { question: "Which one?", options: [{ label: "the resultVersion of the review" }] },
          {} as never,
        ),
      );
      expect(refusedField).toContain('internal identifier "resultVersion"');
      expect(askUser).not.toHaveBeenCalled();
      expect(String(await tools.ask_user.execute!({ question: "Proceed with the parser fix?" }, {} as never))).toBe(
        "yes",
      );
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
