import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolCall, ToolResult } from "../../../types/index";
import { activityKindFor, collectAgentActivities } from "../agent-activities.js";

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
