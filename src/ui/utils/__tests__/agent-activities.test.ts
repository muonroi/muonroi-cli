import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolCall, ToolResult } from "../../../types/index";
import { activityKindFor, collectAgentActivities, createJobStatusLookup, startedJob } from "../agent-activities.js";

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const ok = (output: string): ToolResult => ({ success: true, output });
const fail = (error: string): ToolResult => ({ success: false, output: "", error });

const resultEntry = (toolCall: ToolCall, toolResult: ToolResult): ChatEntry =>
  ({ type: "tool_result", content: "", timestamp: new Date(0), toolCall, toolResult }) as ChatEntry;

const groupEntry = (items: Array<{ toolCall: ToolCall; result?: ToolResult }>): ChatEntry =>
  ({
    type: "tool_group",
    content: "",
    timestamp: new Date(0),
    toolGroup: { id: "g1", state: "done", startedAt: 0, items },
  }) as unknown as ChatEntry;

const TASK = call("t1", "task", { agent: "general", description: "Fix the parser", prompt: "Do the thing" });
const DELEGATE = call("d1", "delegate", { agent: "explore", description: "Map the repo", prompt: "Explore" });
const BG = call("b1", "bash", { command: "npm run dev", background: true });

describe("activityKindFor", () => {
  it("recognises the spawning tools", () => {
    expect(activityKindFor(TASK)).toBe("subagent");
    expect(activityKindFor(DELEGATE)).toBe("delegate");
    expect(activityKindFor(BG)).toBe("background");
  });

  // A plain shell call is a tool, not a spawned job — listing it would bury the
  // real agents under every ls.
  it("ignores a foreground bash and unrelated tools", () => {
    expect(activityKindFor(call("x", "bash", { command: "ls" }))).toBeNull();
    expect(activityKindFor(call("x", "bash", { command: "ls", background: false }))).toBeNull();
    expect(activityKindFor(call("x", "read_file", { path: "a.ts" }))).toBeNull();
  });

  it("does not throw on the partial JSON a streaming call carries", () => {
    expect(activityKindFor(call("x", "bash", "not json" as unknown as object))).toBeNull();
  });
});

describe("collectAgentActivities", () => {
  it("reports a finished sub-agent with its prompt and output", () => {
    const [a] = collectAgentActivities([resultEntry(TASK, ok("all done"))]);
    expect(a.kind).toBe("subagent");
    expect(a.agent).toBe("general");
    expect(a.label).toBe("Fix the parser");
    expect(a.status).toBe("done");
    expect(a.detail).toBe("Do the thing\n\nall done");
  });

  it("marks a failed run and keeps the error as the detail", () => {
    const [a] = collectAgentActivities([resultEntry(DELEGATE, fail("agent crashed"))]);
    expect(a.status).toBe("failed");
    expect(a.detail).toContain("agent crashed");
  });

  it("labels a background shell with its command", () => {
    const [a] = collectAgentActivities([resultEntry(BG, ok("started pid 4"))]);
    expect(a.kind).toBe("background");
    expect(a.label).toBe("npm run dev");
    expect(a.agent).toBe("");
  });

  it("finds activities inside a tool group, not only bare tool_results", () => {
    const list = collectAgentActivities([groupEntry([{ toolCall: TASK, result: ok("done") }])]);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("done");
  });

  it("shows an in-flight call as running", () => {
    const [a] = collectAgentActivities([], [TASK]);
    expect(a.status).toBe("running");
    expect(a.detail).toBe("Do the thing");
  });

  // activeToolCalls is not cleared the instant the result lands; if the running
  // copy won, a finished agent would flip back to a spinner.
  it("keeps a finished row finished when the same call is still listed as active", () => {
    const list = collectAgentActivities([resultEntry(TASK, ok("done"))], [TASK]);
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("done");
  });

  it("returns nothing when no agent was spawned", () => {
    expect(collectAgentActivities([resultEntry(call("x", "bash", { command: "ls" }), ok("a.ts"))])).toEqual([]);
  });

  it("keeps transcript order across kinds", () => {
    const list = collectAgentActivities([
      resultEntry(TASK, ok("1")),
      resultEntry(BG, ok("2")),
      resultEntry(DELEGATE, ok("3")),
    ]);
    expect(list.map((a) => a.kind)).toEqual(["subagent", "background", "delegate"]);
  });
});

// `delegate`, `task` with the explore agent, and `bash background:true` return
// as soon as the job STARTS. Their tool result is not the job's outcome, so the
// rail must not show a check until the job really finishes.
describe("background job status", () => {
  const DELEGATION_STARTED =
    "Delegation started: calm-teal-otter\nAgent: explore\nYou will be notified when it completes.";
  const SHELL_STARTED = "Background process started (id: 7, pid: 4242)\nCommand: npm run dev";
  const EXPLORE_TASK = call("e1", "task", { agent: "explore", description: "Hunt screen", prompt: "Look" });

  it("parses the job a start result names", () => {
    expect(startedJob(DELEGATION_STARTED)).toEqual({ type: "delegation", id: "calm-teal-otter" });
    expect(startedJob(SHELL_STARTED)).toEqual({ type: "process", id: 7 });
    expect(startedJob("all done")).toBeNull();
  });

  it("keeps a launched delegation running until its record finishes", () => {
    const entries = [resultEntry(DELEGATE, ok(DELEGATION_STARTED)), resultEntry(EXPLORE_TASK, ok(DELEGATION_STARTED))];
    const before = collectAgentActivities(entries, [], createJobStatusLookup({}, {}));
    expect(before.map((a) => a.status)).toEqual(["running", "running"]);

    const running = createJobStatusLookup({ "calm-teal-otter": "running" }, {});
    expect(collectAgentActivities(entries, [], running)[0].status).toBe("running");

    const done = createJobStatusLookup({ "calm-teal-otter": "complete" }, {});
    expect(collectAgentActivities(entries, [], done)[0].status).toBe("done");

    const failed = createJobStatusLookup({ "calm-teal-otter": "error" }, {});
    expect(collectAgentActivities(entries, [], failed)[0].status).toBe("failed");
  });

  it("follows a background shell through running, exit and failure", () => {
    const entries = [resultEntry(BG, ok(SHELL_STARTED))];
    const state = (s: "running" | "exited" | "failed") =>
      createJobStatusLookup({}, { 7: { command: "npm run dev", state: s } });
    expect(collectAgentActivities(entries, [], state("running"))[0].status).toBe("running");
    expect(collectAgentActivities(entries, [], state("exited"))[0].status).toBe("done");
    expect(collectAgentActivities(entries, [], state("failed"))[0].status).toBe("failed");
  });

  // Shell ids restart at 1 in every CLI process. A resumed session's old shell
  // must not borrow the state of a new one that happens to share its id.
  it("treats an unknown or reused shell id as no longer running", () => {
    const entries = [resultEntry(BG, ok(SHELL_STARTED))];
    expect(collectAgentActivities(entries, [], createJobStatusLookup({}, {}))[0].status).toBe("done");
    const other = createJobStatusLookup({}, { 7: { command: "vite", state: "running" } });
    expect(collectAgentActivities(entries, [], other)[0].status).toBe("done");
  });

  it("lists a shell the tool auto-backgrounded without background:true", () => {
    const vite = call("v1", "bash", { command: "vite" });
    const lookup = createJobStatusLookup({}, { 7: { command: "vite", state: "running" } });
    const [a] = collectAgentActivities([resultEntry(vite, ok(SHELL_STARTED))], [], lookup);
    expect(a.kind).toBe("background");
    expect(a.status).toBe("running");
  });

  it("still marks a launch that failed to start as failed", () => {
    const [a] = collectAgentActivities([resultEntry(DELEGATE, fail("Nested background delegations are disabled."))]);
    expect(a.status).toBe("failed");
  });
});

describe("activityPrefix", () => {
  it("names the sub-agent type, and calls a background job a shell", async () => {
    const { activityPrefix } = await import("../../components/agent-rail-activities.js");
    const [task] = collectAgentActivities([resultEntry(TASK, ok("x"))]);
    const [bg] = collectAgentActivities([resultEntry(BG, ok("x"))]);
    expect(activityPrefix(task)).toBe("general");
    expect(activityPrefix(bg)).toBe("shell");
  });

  // A delegate whose fixture omitted `agent` must still say what it is.
  it("falls back to the kind when the agent type is absent", async () => {
    const { activityPrefix } = await import("../../components/agent-rail-activities.js");
    const [d] = collectAgentActivities([
      resultEntry(call("d2", "delegate", { description: "x", prompt: "y" }), ok("z")),
    ]);
    expect(activityPrefix(d)).toBe("delegate");
  });
});
