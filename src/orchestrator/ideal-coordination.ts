/**
 * Local `/ideal status` and `/ideal abort` for the orchestrator role.
 *
 * Since b014c9b9 the TUI main agent is the orchestrator: `/ideal start` hands the
 * goal to the model, which coordinates bounded background workers. Every other
 * subcommand used to take the same path — `runProductLoopV1` forwarded
 * `status`/`abort` to `processMessage` as a "coordinate the user's /ideal status
 * request" prompt. That is a paid model call to read state the host already
 * holds, an answer only as good as the model's reading of it, and an "abort"
 * that could only ASK the model to stop its workers.
 *
 * Both are now answered by the host from the run record and the delegation
 * ledger. Pure formatting lives here so it is unit-testable; the orchestrator
 * owns the I/O (ledger read, kill).
 */
import type { PersistedAutopilot } from "../storage/transcript.js";
import type { DelegationStatus } from "../types/index.js";

/** The `/ideal start` the orchestrator is coordinating in this session. */
export interface IdealCoordinationRun {
  goal: string;
  /** ISO timestamp; every delegation started at or after it belongs to the run. */
  startedAt: string;
  /** Host autopilot state (ideal-autopilot.ts); absent when the run was started with the autopilot off. */
  autopilot?: PersistedAutopilot;
}

/** The subset of a delegation ledger entry the status/abort views need. */
export interface IdealJob {
  id: string;
  agent: string;
  description: string;
  status: DelegationStatus;
  startedAt: string;
  completedAt?: string;
}

/** Native FLOW state for the cwd (`readState`); null fields = not recorded. */
export interface IdealFlowView {
  phase: string | null;
  depth: string | null;
  planVerified: boolean;
  /** False when `.planning/STATE.md` does not exist. */
  exists: boolean;
}

export interface IdealKillOutcome {
  id: string;
  success: boolean;
  output: string;
}

/**
 * Jobs launched for the run: started at or after `/ideal start`. Both
 * timestamps are `Date#toISOString()`, so string order is time order.
 */
export function jobsOfIdealRun(run: IdealCoordinationRun, ledger: readonly IdealJob[]): IdealJob[] {
  return ledger.filter((job) => job.startedAt >= run.startedAt);
}

function elapsed(fromIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(fromIso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function jobLine(job: IdealJob): string {
  return `  ${job.id}  ${job.status.padEnd(9)}  ${job.agent}  ${job.description.replace(/\s+/g, " ").slice(0, 80)}`;
}

export function formatIdealStatus(input: {
  run: IdealCoordinationRun | null;
  jobs: readonly IdealJob[];
  flow: IdealFlowView;
  now: Date;
  /** `Autopilot: …` line from IdealAutopilotHost.statusLine; omitted when there is nothing to say. */
  autopilotLine?: string | null;
}): string {
  const lines: string[] = ["/ideal status (local — no model call)"];
  if (!input.run) {
    lines.push("No /ideal run has been started in this session.");
  } else {
    lines.push(`Goal: ${input.run.goal}`);
    lines.push(`Started: ${input.run.startedAt} (${elapsed(input.run.startedAt, input.now)} ago)`);
    if (input.autopilotLine) lines.push(input.autopilotLine);
  }
  lines.push(
    input.flow.exists
      ? `Flow: phase=${input.flow.phase ?? "—"}  depth=${input.flow.depth ?? "—"}  plan verified=${input.flow.planVerified ? "yes" : "no"}`
      : "Flow: no .planning/STATE.md in this project",
  );
  if (input.run) {
    const running = input.jobs.filter((j) => j.status === "running").length;
    if (input.jobs.length === 0) {
      lines.push("Workers: none launched since the run started.");
    } else {
      lines.push(`Workers (${running} running, ${input.jobs.length - running} finished):`);
      for (const job of input.jobs) lines.push(jobLine(job));
    }
    if (running > 0) lines.push("Stop them with /ideal abort.");
  }
  return `${lines.join("\n")}\n`;
}

export function formatIdealAbort(input: {
  run: IdealCoordinationRun | null;
  outcomes: readonly IdealKillOutcome[];
  finished: number;
}): string {
  if (!input.run) return "/ideal abort: no /ideal run has been started in this session — nothing to stop.\n";
  const lines = [`/ideal abort — run "${input.run.goal}" stopped.`];
  const stopped = input.outcomes.filter((o) => o.success);
  const failed = input.outcomes.filter((o) => !o.success);
  if (input.outcomes.length === 0) lines.push("No worker was running.");
  if (stopped.length > 0) lines.push(`Stopped ${stopped.length} worker(s): ${stopped.map((o) => o.id).join(", ")}`);
  for (const o of failed) lines.push(`Could not stop ${o.id}: ${o.output}`);
  if (input.finished > 0) lines.push(`${input.finished} worker(s) had already finished; their results are kept.`);
  lines.push("Start a new run with /ideal <goal>.");
  return `${lines.join("\n")}\n`;
}
