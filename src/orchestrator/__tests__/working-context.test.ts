import type { ModelMessage, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { registerContextLoader } from "../../tools/context-load.js";
import { compactSubAgentMessages } from "../subagent-compactor.js";
import { projectTaskContext, TaskContext } from "../task-context.js";
import { retainWorkingContext, WorkingContext } from "../working-context.js";

const history: ModelMessage[] = [
  { role: "user", content: "Completed packaging task" },
  { role: "assistant", content: "STALE_PACKAGING_LOG ".repeat(900) },
  { role: "user", content: "Current council task; preserve the failed evidence" },
  { role: "assistant", content: "ACTIVE_COUNCIL_EVIDENCE" },
];

describe("native task-aware context pruning", () => {
  const call = (id = "evidence"): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolName: "read_file", toolCallId: id, input: { file_path: "proof.txt" } }],
  });
  const result = (id = "evidence", text = "UNRESOLVED_FAILURE"): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolName: "read_file", toolCallId: id, output: { type: "text", value: text } }],
  });
  const closedEvidence = (): ModelMessage[] => [
    { role: "user", content: "old task" },
    call(),
    result(),
    { role: "user", content: "new active task" },
  ];
  const select = (w: WorkingContext, extra = {}) =>
    w.update({
      action: "update",
      expected_revision: w.snapshot().revision,
      task_id: "current",
      goal: "Current goal",
      constraints: [],
      decisions: [],
      open_items: [],
      ...extra,
    });

  it("does nothing until main explicitly selects a working set", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    expect(w.project(history)).toEqual(history);
    expect(w.block()).toBe("");
  });
  it("inspects and restores only its own omitted turns inside the SDK's already-pruned history", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    const old = w.inspect().turns[0]!.id;
    select(w, { archive: [{ turn_id: old, reason: "Completed task" }] });
    const prepared = w.project(history);
    w.setSource(prepared);
    expect(w.inspect().turns.some((t) => t.id === old)).toBe(true);
    expect(select(w, { restore_turn_ids: [old] }).error).toBeUndefined();
    expect(JSON.stringify(w.project(prepared))).toContain("STALE_PACKAGING_LOG");
    w.update({ action: "reset", expected_revision: w.snapshot().revision });
    expect(JSON.stringify(w.project(prepared))).toContain("STALE_PACKAGING_LOG");
  });
  it("retires a long task prefix with one bounded boundary while retaining a dependency and restoring selected turns", () => {
    const source: ModelMessage[] = [];
    for (let i = 0; i < 100; i++)
      source.push({ role: "user", content: `Task ${i}` }, { role: "assistant", content: `OLD_LOG_${i}` });
    source.push({ role: "user", content: "Current task" });
    const w = new WorkingContext("owner", "/fixture", source);
    const first = w.inspect().turns[0]!.id,
      last = w.inspect(96).turns[3]!.id;
    const receipt = select(w, {
      archive_through: { turn_id: last, reason: "These tasks are complete" },
      keep_turn_ids: [first],
    });
    expect(receipt.error).toBeUndefined();
    expect(receipt.archive).toEqual([]);
    expect(JSON.stringify(receipt).length).toBeLessThan(1000);
    expect(JSON.stringify(w.project(source))).toContain("OLD_LOG_0");
    expect(JSON.stringify(w.project(source))).not.toContain("OLD_LOG_99");
    expect(select(w, { restore_turn_ids: [last] }).error).toBeUndefined();
    expect(JSON.stringify(w.project(source))).toContain("OLD_LOG_99");
    expect(
      select(w, { archive_through: { turn_id: w.inspect(96).turns[4]!.id, reason: "Cannot retire current" } }).error,
    ).toBeDefined();
    expect(w.retainedMessages(source).has(source[0]!)).toBe(true);
  });
  it("protects actual folded system policy and does not accumulate host-owned injected ledgers", () => {
    const policy: ModelMessage = { role: "system", content: "MANDATORY_POLICY" };
    const source: ModelMessage[] = [
      { role: "user", content: "Old task\n\n[System note]\nMANDATORY_POLICY" },
      { role: "assistant", content: "done" },
      { role: "user", content: "new" },
    ];
    const w = new WorkingContext("owner", "/fixture", source);
    w.setProtection({ pinned: [policy] });
    expect(w.inspect().turns[0]!.protected).toContain("user-pin-or-folded-policy");
    const context = new TaskContext("owner", "/fixture", history);
    select(context.working, { decisions: ["OLD_LEDGER"] });
    const projected = projectTaskContext(history, context);
    select(context.working, { decisions: ["CURRENT_LEDGER"] });
    const next = JSON.stringify(projectTaskContext(projected, context));
    expect(next).not.toContain("OLD_LEDGER");
    expect(next.split("CURRENT_LEDGER")).toHaveLength(2);
  });
  it("removes complete selected call/result bundles together, preserving exact retained evidence", () => {
    const source = closedEvidence();
    const w = new WorkingContext("owner", "/fixture", source);
    const id = w.inspect().turns[0]!.id;
    expect(select(w, { archive: [{ turn_id: id, reason: "Completed unrelated task" }] })).not.toHaveProperty("error");
    expect(w.project(source)).toEqual([source.at(-1)]);
    expect(source).toHaveLength(4);
  });
  it.each([
    "current",
    "pin",
    "job",
    "protection-down",
    "missing-result",
    "signed",
    "media",
    "duplicate",
  ])("refuses unsafe archive: %s", (kind) => {
    let source = closedEvidence();
    if (kind === "missing-result") source = [source[0]!, call(), source.at(-1)!];
    if (kind === "signed")
      source.splice(1, 0, {
        role: "assistant",
        content: [{ type: "reasoning", text: "opaque", providerOptions: { fixture: { signature: "signed" } } }],
      });
    if (kind === "media")
      source[0] = {
        role: "user",
        content: [
          { type: "text", text: "old" },
          { type: "image", image: "https://fixture.invalid/image.png" },
        ],
      };
    if (kind === "duplicate")
      source = [
        { role: "user", content: "same" },
        { role: "assistant", content: "same" },
        { role: "user", content: "same" },
        { role: "assistant", content: "same" },
        { role: "user", content: "active" },
      ];
    const w = new WorkingContext("owner", "/fixture", source);
    if (kind === "pin") w.setProtection({ pinned: [structuredClone(source[0]!)] });
    if (kind === "job") w.setProtection({ pendingJobIds: ["UNRESOLVED_FAILURE"] });
    if (kind === "protection-down") w.setProtection({ unavailable: true });
    const id = w.inspect().turns[kind === "current" ? 1 : 0]!.id;
    const before = w.snapshot();
    expect(select(w, { archive: [{ turn_id: id, reason: "Attempt to archive protected work" }] }).error).toContain(
      "protected",
    );
    expect(w.snapshot()).toEqual(before);
  });
  it("preserves a dependency/negative result even when an archive request names its turn", () => {
    const source = closedEvidence();
    const w = new WorkingContext("owner", "/fixture", source);
    const id = w.inspect().turns[0]!.id;
    expect(
      select(w, { keep_tool_ids: ["evidence"], archive: [{ turn_id: id, reason: "Do not lose this failure" }] }).error,
    ).toBeDefined();
    expect(select(w, { keep_turn_ids: [id], open_items: ["Failure still blocks task B"] }).error).toBeUndefined();
    expect(JSON.stringify(w.project(source))).toContain("UNRESOLVED_FAILURE");
    expect(w.block()).toContain("Failure still blocks task B");
    expect(w.retainedToolIds()).toContain("evidence");
    expect(w.retainedMessages(source).has(source[1]!)).toBe(true);
  });
  it("rechecks protections at projection time and honors explicit assistant keep/veto", () => {
    const source = closedEvidence();
    const w = new WorkingContext("owner", "/fixture", source);
    const id = w.inspect().turns[0]!.id;
    select(w, { archive: [{ turn_id: id, reason: "Old task" }], replace_checkpoint: true });
    for (const directive of ["PRESERVE_FULL_CONTEXT", "KEEP_TOOL_IDS: evidence"]) {
      const withDirective: ModelMessage[] = [...source, { role: "assistant", content: directive }];
      expect(JSON.stringify(w.project(withDirective))).toContain("UNRESOLVED_FAILURE");
    }
    w.setProtection({ pendingJobIds: ["UNRESOLVED_FAILURE"] });
    expect(JSON.stringify(w.project(source))).toContain("UNRESOLVED_FAILURE");
  });
  it("keeps cross-user tool chains intact", () => {
    const source: ModelMessage[] = [
      { role: "user", content: "before" },
      call(),
      { role: "user", content: "steer" },
      result(),
      { role: "user", content: "active" },
    ];
    const w = new WorkingContext("owner", "/fixture", source);
    expect(w.inspect().turns[0]!.protected).toContain("incomplete-or-cross-turn-tool-pair");
    expect(w.inspect().turns[1]!.protected).toContain("incomplete-or-cross-turn-tool-pair");
  });
  it("replaces ledger fields, supports restore and rejects stale, unknown or bloated edits", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    const id = w.inspect().turns[0]!.id;
    select(w, { decisions: ["OLD_DECISION"], archive: [{ turn_id: id, reason: "Old task closed" }] });
    expect(select(w, { decisions: ["CURRENT_DECISION"], restore_turn_ids: [id] }).error).toBeUndefined();
    expect(w.block()).not.toContain("OLD_DECISION");
    expect(w.block()).toContain("CURRENT_DECISION");
    expect(w.project(history)).toEqual(history);
    expect(w.update({ action: "reset", expected_revision: 0 }).error).toContain("revision");
    expect(select(w, { archive: [{ turn_id: `turn-${"a".repeat(24)}`, reason: "unknown" }] }).error).toBeDefined();
    expect(select(w, { decisions: ["x".repeat(501)] }).error).toBeDefined();
  });
  it("restores only owned/cwd-bound actual receipts and preserves them through compaction", () => {
    const w = new WorkingContext("owner", "/fixture", history);
    const id = w.inspect().turns[0]!.id;
    const receipt = select(w, { archive: [{ turn_id: id, reason: "Closed" }], decisions: ["DURABLE_DECISION"] });
    const persisted: ModelMessage[] = [
      ...history,
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: "context_load", toolCallId: "select", input: { topic: "working_set" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "context_load",
            toolCallId: "select",
            output: { type: "text", value: JSON.stringify(receipt) },
          },
        ],
      },
    ];
    expect(new WorkingContext("owner", "/fixture", persisted).block()).toContain("DURABLE_DECISION");
    expect(new WorkingContext("foreign", "/fixture", persisted).active()).toBe(false);
    expect(new WorkingContext("owner", "/other", persisted).active()).toBe(false);
    const tagged = retainWorkingContext(persisted, "owner", "/fixture")!;
    expect(new WorkingContext("owner", "/fixture", [tagged]).snapshot()).toEqual(receipt);
    const compacted = compactSubAgentMessages(
      [
        ...persisted,
        { role: "user", content: "later work" },
        call("later"),
        result("later", "x".repeat(10000)),
        { role: "user", content: "tail" },
      ],
      { thresholdChars: 1, keepLastTurns: 1, outputPreviewChars: 1 },
    );
    expect(JSON.stringify(compacted)).toContain("DURABLE_DECISION");
  });
  it("retires only the explicit old checkpoint and keeps real policies; refuses pending-job replacement", () => {
    const summary: ModelMessage = { role: "system", content: "[Context checkpoint summary]\nSTALE_STORY" };
    const policy: ModelMessage = { role: "system", content: "MANDATORY_PERMISSION_POLICY" };
    const source = [summary, policy, ...history];
    const w = new WorkingContext("owner", "/fixture", source);
    expect(select(w, { replace_checkpoint: true, constraints: ["MANDATORY_PERMISSION_POLICY"] }).error).toBeUndefined();
    expect(w.project(source)).not.toContain(summary);
    expect(w.project(source)).toContain(policy);
    w.setProtection({ pendingJobIds: ["active-worker"] });
    expect(w.project(source)).toContain(summary);
    expect(select(w, { replace_checkpoint: true }).error).toContain("unacknowledged");
  });
  it("archives an explicitly selected closed turn from the next request without rewriting canonical history", async () => {
    const canonical = JSON.stringify(history);
    const context = new TaskContext("owner", "/fixture", history);
    const tools: ToolSet = {};
    registerContextLoader(tools, context, () => "/fixture", "orchestrator");
    const run = async (input: unknown) =>
      JSON.parse(
        (await tools.context_load!.execute!(input as never, { toolCallId: "ctx", messages: history })) as string,
      );
    const inventory = await run({ topic: "working_set", action: "inspect" });
    expect(inventory.error).toBeUndefined();
    expect(inventory.turns).toHaveLength(2);
    const selected = await run({
      topic: "working_set",
      action: "update",
      expected_revision: 0,
      task_id: "council",
      goal: "Verify council evidence",
      constraints: ["Keep permission boundaries"],
      decisions: [],
      open_items: ["Independent evidence is unresolved"],
      archive: [{ turn_id: inventory.turns[0].id, reason: "Packaging completed; unrelated to council" }],
    });
    expect(selected.error).toBeUndefined();
    const prepared = projectTaskContext(history, context, "orchestrator");
    expect(JSON.stringify(prepared)).not.toContain("STALE_PACKAGING_LOG");
    expect(JSON.stringify(prepared)).toContain("ACTIVE_COUNCIL_EVIDENCE");
    expect(JSON.stringify(prepared)).toContain("Independent evidence is unresolved");
    expect(JSON.stringify(history)).toBe(canonical);
    expect(context.measurements(prepared).contextPrunedChars).toBeGreaterThan(10000);
    await run({ topic: "working_set", action: "reset", expected_revision: selected.revision });
    expect(JSON.stringify(projectTaskContext(history, context))).toContain("STALE_PACKAGING_LOG");
  });
});
