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
 * One exception to "the tool stream IS the record": a background delegation or
 * shell returns as soon as the job STARTS. Its tool result is a "started" line,
 * not the outcome — treating it as done painted a green check on every explore
 * agent that was still working. For those, the job id is recovered from the
 * started line and the state comes from the live {@link BackgroundJobSnapshot}.
 */

import type { ChatEntry, ToolCall, ToolResult } from "../../types/index";
import {
  type BackgroundJobSnapshot,
  type BackgroundJobState,
  parseBackgroundProcessStarted,
  parseDelegationStartedId,
  processJobKey,
} from "../../utils/background-jobs.js";

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
  /** Set when the call spawned a background job — what /jobs can stop. */
  job?: { delegationId?: string; processId?: number };
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

/**
 * bash auto-backgrounds commands it recognises as long-running (dev servers,
 * watchers) even without background:true — only the result shows it.
 */
function kindFor(tc: ToolCall, result: ToolResult | undefined): ActivityKind | null {
  const kind = activityKindFor(tc);
  if (kind) return kind;
  if (tc.function.name === "bash" && result?.success && parseBackgroundProcessStarted(result.output)) {
    return "background";
  }
  return null;
}

function fromJobState(state: BackgroundJobState): ActivityStatus {
  return state;
}

function toActivity(
  tc: ToolCall,
  result: ToolResult | undefined,
  live: BackgroundJobSnapshot | undefined,
  /** Epoch ms the call was made, when known. */
  at?: number,
): AgentActivity | null {
  const kind = kindFor(tc, result);
  if (!kind) return null;
  const args = parseArgs(tc);

  const agent = kind === "background" ? "" : str(args.agent);
  const command = str(args.command);
  const label = (kind === "background" ? command : str(args.description) || str(args.prompt)) || tc.function.name;
  const request = kind === "background" ? command : str(args.prompt);

  let status: ActivityStatus = "running";
  if (result) status = result.success ? "done" : "failed";

  let output = result ? (result.success ? result.output || "" : result.error || "") : "";
  let job: AgentActivity["job"];

  if (result?.success) {
    // A "started" result means the job is running — not that it finished.
    // A job missing from the snapshot is still running: the record exists
    // before the tool returns, so absence only means the poll has not caught up.
    const delegationId = parseDelegationStartedId(result.output);
    const proc = delegationId ? null : parseBackgroundProcessStarted(result.output);
    if (delegationId) {
      job = { delegationId };
      const d = live?.delegations[delegationId];
      status = d ? fromJobState(d.state) : "running";
      if (d?.summary) output = `${output}\n\nResult: ${d.summary}`;
    } else if (proc) {
      job = { processId: proc.id };
      const p = live?.processes[processJobKey(proc.id, proc.pid)];
      const fromEarlierRun = !p && live?.processesSince !== undefined && at !== undefined && at < live.processesSince;
      status = p ? fromJobState(p.state) : fromEarlierRun ? "done" : "running";
      if (p && p.state !== "running") output = `${output}\n\nExited with code ${p.exitCode ?? "unknown"}.`;
      if (fromEarlierRun) output = `${output}\n\n(Started by an earlier CLI run — no longer running.)`;
    }
  }

  const detail = [request, output].filter((s) => s.trim().length > 0).join("\n\n");

  return { id: tc.id, kind, label: label.replace(/\s+/g, " ").trim(), agent, status, detail, ...(job ? { job } : {}) };
}

function entryTime(entry: ChatEntry): number | undefined {
  const t = entry.timestamp instanceof Date ? entry.timestamp.getTime() : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Every activity in the session, oldest first. Later state for the same
 * tool-call id wins, so a call that finishes replaces its own running row
 * instead of adding a second one.
 */
export function collectAgentActivities(
  messages: ChatEntry[],
  activeToolCalls: ToolCall[] = [],
  live?: BackgroundJobSnapshot,
): AgentActivity[] {
  const byId = new Map<string, AgentActivity>();

  const add = (tc: ToolCall | undefined, result: ToolResult | undefined, at?: number) => {
    if (!tc) return;
    const activity = toActivity(tc, result, live, at);
    if (activity) byId.set(activity.id, activity);
  };

  for (const entry of messages) {
    if (entry.type === "tool_result") {
      add(entry.toolCall, entry.toolResult, entryTime(entry));
      continue;
    }
    if (entry.type === "tool_group") {
      for (const item of entry.toolGroup?.items ?? []) add(item.toolCall, item.result, item.startedAt);
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

export interface RailActivities {
  /** Still running — the only rows the rail lists. */
  running: AgentActivity[];
  done: number;
  failed: number;
}

/**
 * What the rail shows: running work only. A finished job leaves the rail (it
 * piled up into a wall of checkmarks otherwise) and is counted in a summary
 * line instead; /jobs still lists every one with its prompt and result.
 */
export function partitionForRail(activities: AgentActivity[]): RailActivities {
  const running: AgentActivity[] = [];
  let done = 0;
  let failed = 0;
  for (const a of activities) {
    if (a.status === "running") running.push(a);
    else if (a.status === "failed") failed++;
    else done++;
  }
  return { running, done, failed };
}

/** /jobs order: running first, then most recently spawned first. */
export function orderForJobsView(activities: AgentActivity[]): AgentActivity[] {
  const indexed = activities.map((a, i) => ({ a, i }));
  indexed.sort((x, y) => {
    const xr = x.a.status === "running" ? 0 : 1;
    const yr = y.a.status === "running" ? 0 : 1;
    return xr - yr || y.i - x.i;
  });
  return indexed.map(({ a }) => a);
}
