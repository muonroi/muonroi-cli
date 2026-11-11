import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactSubAgentMessages } from "../subagent-compactor.js";
import { projectTaskContext, TaskContext } from "../task-context.js";

describe("per-task context projection", () => {
  it("projects main guidance without changing selected stage, receipt, handoff or worker guidance", () => {
    const context = new TaskContext("owner", "/fixture");
    const receipt = context.select({ stage: "research", handoff: "Retain actual toolCallId=evidence" });
    const messages: ModelMessage[] = [{ role: "user", content: "Same task" }];
    const root = projectTaskContext(messages, context, "orchestrator");
    expect(JSON.stringify(root)).toContain("stage=research");
    expect(JSON.stringify(root)).toMatch(/runtime-only/i);
    expect(JSON.stringify(root)).not.toContain("read_file ranges/max_chars");
    expect(JSON.stringify(root)).toContain("native read_file and grep");
    expect(JSON.stringify(root)).toContain("toolCallId=evidence");
    expect(context.snapshot()).toEqual(receipt);
    expect(context.measurements(root, "orchestrator").taskContextChars).toBe(context.block("orchestrator").length);
    expect(JSON.stringify(projectTaskContext(root, context, "worker"))).toContain("read_file ranges/max_chars");
    expect(JSON.stringify(projectTaskContext(root, context, "worker"))).not.toContain("Runtime-only audits");
    expect(context.snapshot()).toEqual(receipt);
    expect(messages[0]!.content).toBe("Same task");
  });
  it("observes successful current-turn tools without treating failures, bash or history as stage authority", () => {
    const context = new TaskContext("main", "/fixture");
    const result = (name: string, value: unknown, id = name): ModelMessage => ({
      role: "tool",
      content: [
        { type: "tool-result", toolName: name, toolCallId: id, output: { type: "json", value: value as never } },
      ],
    });
    const user: ModelMessage = { role: "user", content: "current task" };
    context.observe([result("edit_file", { success: true }), user]);
    expect(context.snapshot().stage).toBe("orient");
    context.observe([user, result("read_file", "[fixture: lines 1-3 of 3]\n1 | evidence")]);
    expect(context.snapshot().stage).toBe("research");
    context.observe([user, result("edit_file", { success: false, output: "BLOCKED" }, "blocked")]);
    expect(context.snapshot().stage).toBe("research");
    context.observe([user, result("bash", { success: true, output: "tests passed" })]);
    expect(context.snapshot().stage).toBe("research");
    context.observe([user, result("edit_file", { success: true }, "written")]);
    expect(context.snapshot().stage).toBe("implement");
    context.observe([user, result("verification_run", JSON.stringify({ success: true, output: "exit=0" }))]);
    expect(context.snapshot().stage).toBe("verify");
    const revision = context.snapshot().revision;
    context.observe([user, result("verification_run", JSON.stringify({ success: true }))]);
    expect(context.snapshot().revision).toBe(revision);
    context.select({ stage: "plan", handoff: "toolCallId=written; investigate next" });
    context.observe([user, result("edit_file", { success: true }, "after-explicit")]);
    expect(context.snapshot().stage).toBe("plan");
    expect(context.selectionSource).toBe("explicit");
    context.alignCwd("/other");
    context.observe([user, result("edit_file", { success: true }, "after-explicit")]);
    expect(context.snapshot().stage).toBe("orient");
    context.observe([user, result("edit_file", { success: true }, "other-edit")]);
    expect(context.snapshot().stage).toBe("implement");
    expect(new TaskContext("child", "/fixture").snapshot().stage).toBe("orient");
  });
  it("replaces only host-owned projections and preserves canonical user/media input", () => {
    const context = new TaskContext("session", "/fixture");
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "USER [task context] literal text" },
          { type: "image", image: "https://fixture.invalid/image.png" },
        ],
      },
    ];
    const original = JSON.stringify(messages);
    const orient = projectTaskContext(messages, context);
    expect(JSON.stringify(orient)).toContain("stage=orient");
    context.select({ stage: "verify", expected_revision: 0, handoff: "Retain command failure; toolCallId=proof" });
    const verify = projectTaskContext(orient, context);
    expect(JSON.stringify(verify)).toContain("stage=verify");
    expect(JSON.stringify(verify)).not.toContain("stage=orient");
    expect(JSON.stringify(verify)).toContain("toolCallId=proof");
    expect(JSON.stringify(verify)).toContain("USER [task context] literal text");
    expect(JSON.stringify(messages)).toBe(original);
    expect((verify[0]!.content as unknown[]).length).toBe(3);
    expect(context.measurements(verify).taskContextChars).toBeGreaterThan(0);
    expect(context.measurements([]).taskContextChars).toBe(0);
  });

  it("keeps state local, rejects stale/invalid transitions and permits backwards/skipped stages", () => {
    const main = new TaskContext("main", "/a");
    const child = new TaskContext("child", "/a");
    main.select({ stage: "verify", expected_revision: 0 });
    expect(main.select({ stage: "implement", expected_revision: 0 }).error).toContain("revision");
    expect(main.select({ stage: "invalid" }).error).toBeDefined();
    expect(main.select({ stage: "implement", expected_revision: 1 }).stage).toBe("implement");
    expect(child.snapshot().stage).toBe("orient");
    expect(main.select({ stage: "implement" }).revision).toBe(2);
    expect(main.select({ stage: "plan", handoff: "x".repeat(1600) }).error).toBeDefined();
  });

  it("restores only matching owned durable receipts on explicit continuation", () => {
    const old = new TaskContext("main", "/a");
    const receipt = old.select({ stage: "verify", handoff: "Proof remains tool-123" });
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "context-1",
            toolName: "context_load",
            output: { type: "text", value: JSON.stringify(receipt) },
          },
        ],
      },
    ];
    expect(new TaskContext("main", "/a", messages, true).snapshot().stage).toBe("verify");
    expect(new TaskContext("main", "/a", messages, false).snapshot().stage).toBe("orient");
    expect(new TaskContext("child", "/a", messages, true).snapshot().stage).toBe("orient");
    expect(new TaskContext("main", "/b", messages, true).snapshot().stage).toBe("orient");
    const otherTask: ModelMessage[] = [
      ...messages,
      { role: "user", content: "an unrelated new task" },
      { role: "assistant", content: "completed" },
      { role: "user", content: "continue" },
    ];
    expect(new TaskContext("main", "/a", otherTask, true, "orient", (t) => t === "continue").snapshot().stage).toBe(
      "orient",
    );
  });

  it("retains bounded handoff receipts through actual compaction and JSON roundtrip", () => {
    const context = new TaskContext("main", "/fixture");
    const receipt = context.select({ stage: "verify", handoff: "Proof toolCallId=retained-123; exit=1 unresolved" });
    const history: ModelMessage[] = [
      { role: "user", content: "original task" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolName: "context_load", toolCallId: "ctx", input: { stage: "verify" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "context_load",
            toolCallId: "ctx",
            output: { type: "text", value: JSON.stringify(receipt) },
          },
        ],
      },
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolName: "read_file", toolCallId: "other", input: { path: "fixture" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "read_file",
            toolCallId: "other",
            output: { type: "text", value: "z".repeat(10000) },
          },
        ],
      },
      { role: "user", content: "continue" },
    ];
    const compacted = compactSubAgentMessages(history, { thresholdChars: 1, keepLastTurns: 1 });
    const restored = new TaskContext(
      "main",
      "/fixture",
      JSON.parse(JSON.stringify(compacted)),
      true,
      "orient",
      (t) => t === "continue",
    ).snapshot();
    expect(restored.stage).toBe("verify");
    expect(restored.handoff).toContain("exit=1 unresolved");
    context.alignCwd("/other-repo");
    expect(context.snapshot()).toMatchObject({ stage: "orient", handoff: "" });
  });
});
