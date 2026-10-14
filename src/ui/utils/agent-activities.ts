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
 *
 * A spawning tool's result is NOT the job's result for background work: `delegate`
 * (and `task` with the explore agent, which routes to it) and `bash
 * background:true` return as soon as the job STARTS. Reading that result as the
 * outcome put a green check on every background agent the instant it launched.
 * For those calls the started job's id is parsed from the result, and its real
 * state comes from a JobStatusLookup the UI refreshes from the live registries.
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

/**
 * Live state of the background jobs a tool call started. `undefined` means the
 * registry does not know the id; see liveStatus for what that implies per kind.
 */
export interface JobStatusLookup {
  delegation(id: string): ActivityStatus | undefined;
  /** `command` guards against a reused id from a previous CLI process. */
  process(id: number, command: string): ActivityStatus | undefined;
}

const DELEGATION_STARTED = /^Delegation started: (\S+)/m;
const PROCESS_STARTED = /^Background process started \(id: (\d+)/m;

/** The background job a successful tool result started, if any. */
export function startedJob(
  output: string | undefined,
): { type: "delegation"; id: string } | { type: "process"; id: number } | null {
  if (!output) return null;
  const d = DELEGATION_STARTED.exec(output);
  if (d) return { type: "delegation", id: d[1] };
  const p = PROCESS_STARTED.exec(output);
  if (p) return { type: "process", id: Number(p[1]) };
  return null;
}

function liveStatus(
  job: NonNullable<ReturnType<typeof startedJob>>,
  command: string,
  lookup: JobStatusLookup | undefined,
): ActivityStatus {
  if (job.type === "delegation") {
    // Delegation records are persisted before start() returns, so an unknown id
    // only means the lookup has not refreshed since the launch: still running.
    return lookup?.delegation(job.id) ?? "running";
  }
  // Background shells live in this process's memory and die with it. An id the
  // registry does not know belongs to an earlier run (a resumed session), so it
  // is not running any more.
  if (!lookup) return "running";
  return lookup.process(job.id, command) ?? "done";
}

/**
 * Build the lookup from what the registries report: delegation records
 * (`running` | `complete` | `error`) and background shell states.
 */
export function createJobStatusLookup(
  delegations: Record<string, "running" | "complete" | "error">,
  processes: Record<number, { command: string; state: "running" | "exited" | "failed" }>,
): JobStatusLookup {
  return {
    delegation(id) {
      const status = delegations[id];
      if (status === undefined) return undefined;
      return status === "running" ? "running" : status === "complete" ? "done" : "failed";
    },
    process(id, command) {
      const p = processes[id];
      if (!p || p.command !== command) return undefined;
      return p.state === "running" ? "running" : p.state === "failed" ? "failed" : "done";
    },
  };
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

function toActivity(
  tc: ToolCall,
  result: ToolResult | undefined,
  lookup: JobStatusLookup | undefined,
): AgentActivity | null {
  // A bash call the tool auto-backgrounded (dev servers, watchers) never said
  // background:true — its result is the only sign it spawned a job.
  const autoBackground =
    tc.function.name === "bash" && result?.success && startedJob(result.output)?.type === "process";
  const kind = activityKindFor(tc) ?? (autoBackground ? "background" : null);
  if (!kind) return null;
  const args = parseArgs(tc);

  const agent = kind === "background" ? "" : str(args.agent);
  const command = str(args.command);
  const label = (kind === "background" ? command : str(args.description) || str(args.prompt)) || tc.function.name;
  const request = kind === "background" ? command : str(args.prompt);

  let status: ActivityStatus = "running";
  if (result) {
    const job = result.success ? startedJob(result.output) : null;
    status = job ? liveStatus(job, command, lookup) : result.success ? "done" : "failed";
  }

  const output = result ? (result.success ? result.output || "" : result.error || "") : "";
  const detail = [request, output].filter((s) => s.trim().length > 0).join("\n\n");

  return { id: tc.id, kind, label: label.replace(/\s+/g, " ").trim(), agent, status, detail };
}

/**
 * Every activity in the session, oldest first. Later state for the same
 * tool-call id wins, so a call that finishes replaces its own running row
 * instead of adding a second one.
 */
export function collectAgentActivities(
  messages: ChatEntry[],
  activeToolCalls: ToolCall[] = [],
  jobs?: JobStatusLookup,
): AgentActivity[] {
  const byId = new Map<string, AgentActivity>();

  const add = (tc: ToolCall | undefined, result: ToolResult | undefined) => {
    if (!tc) return;
    const activity = toActivity(tc, result, jobs);
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
