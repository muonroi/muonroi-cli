/**
 * src/ui/utils/agent-activities.ts
 *
 * Collect every sub-agent / background job the main agent has spawned this
 * session, for the rail's Agents block.
 *
 * Derived entirely from state the UI already holds — the transcript entries and
 * the in-flight tool calls. Spawning goes through tools (`task`, `delegate`,
 * `bash background:true`), so the tool stream IS the record; there is no need
 * for a parallel registry in core, and nothing here can drift out of sync with
 * what the transcript shows.
 *
 * Running entries come from activeToolCalls (no result yet), finished ones from
 * tool_result / tool_group items. A call that is both (still streaming while an
 * earlier identical call finished) is keyed by tool-call id, so it appears once.
 */

import type { ChatEntry, ToolCall, ToolResult } from "../../types/index";

export type ActivityKind = "subagent" | "delegate" | "background";
export type ActivityStatus = "running" | "done" | "failed";

export interface AgentActivity {
  /** Tool-call id — stable across the running → finished transition. */
  id: string;
  kind: ActivityKind;
  /** Short line for the rail row, e.g. an explore agent's description. */
  label: string;
  /** Sub-agent type ("explore", "general", …). Empty for background shells. */
  agent: string;
  status: ActivityStatus;
  /** Full text shown when the row is opened: the prompt/command, then output. */
  detail: string;
}

const KIND_BY_TOOL: Record<string, ActivityKind> = {
  task: "subagent",
  delegate: "delegate",
};

function parseArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    // Arguments stream in as partial JSON while a call assembles — an
    // unparseable value here is expected mid-flight, not an error.
    return {};
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The activity kind a tool call represents, or null if it spawns nothing. */
export function activityKindFor(tc: ToolCall): ActivityKind | null {
  const name = tc.function.name;
  const known = KIND_BY_TOOL[name];
  if (known) return known;
  // A backgrounded shell is a spawned job too — but only when it actually
  // backgrounds. A normal bash call is just a tool, not an activity.
  if (name === "bash" && parseArgs(tc).background === true) return "background";
  return null;
}

function toActivity(tc: ToolCall, result: ToolResult | undefined): AgentActivity | null {
  const kind = activityKindFor(tc);
  if (!kind) return null;
  const args = parseArgs(tc);

  const agent = kind === "background" ? "" : str(args.agent);
  const command = str(args.command);
  const label = (kind === "background" ? command : str(args.description) || str(args.prompt)) || tc.function.name;
  const request = kind === "background" ? command : str(args.prompt);

  let status: ActivityStatus = "running";
  if (result) status = result.success ? "done" : "failed";

  const output = result ? (result.success ? result.output || "" : result.error || "") : "";
  const detail = [request, output].filter((s) => s.trim().length > 0).join("\n\n");

  return { id: tc.id, kind, label: label.replace(/\s+/g, " ").trim(), agent, status, detail };
}

/**
 * Every activity in the session, oldest first. Later state for the same
 * tool-call id wins, so a call that finishes replaces its own running row
 * instead of adding a second one.
 */
export function collectAgentActivities(messages: ChatEntry[], activeToolCalls: ToolCall[] = []): AgentActivity[] {
  const byId = new Map<string, AgentActivity>();

  const add = (tc: ToolCall | undefined, result: ToolResult | undefined) => {
    if (!tc) return;
    const activity = toActivity(tc, result);
    if (activity) byId.set(activity.id, activity);
  };

  for (const entry of messages) {
    if (entry.type === "tool_result") {
      add(entry.toolCall, entry.toolResult);
      continue;
    }
    if (entry.type === "tool_group") {
      for (const item of entry.toolGroup?.items ?? []) add(item.toolCall, item.result);
    }
  }

  // In-flight calls fill in only what the transcript does not already have.
  // activeToolCalls is not always cleared the instant a result lands, so adding
  // one unconditionally would flip a finished row back to "running".
  for (const tc of activeToolCalls) {
    if (!byId.has(tc.id)) add(tc, undefined);
  }

  return [...byId.values()];
}
