/**
 * src/mcp/self-verify-jobs.ts
 *
 * In-process job tracker for self-verify runs exposed over MCP.
 * Pure module: the actual self-verify execution is injected via the Runner
 * interface so unit tests never spawn a real TUI.
 */

import { randomUUID } from "node:crypto";
import type { AgenticReport } from "../self-qa/agentic-loop.js";
import type { SelfVerifyReport } from "../self-qa/index.js";

export type JobKind = "tier1" | "agentic";
export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface StartTier1Opts {
  kind: "tier1";
  since?: string;
  max?: number;
  emit?: boolean;
  out?: string;
}

export interface StartAgenticOpts {
  kind: "agentic";
  goal: string;
  llm: string;
  turns?: number;
}

export type StartOpts = StartTier1Opts | StartAgenticOpts;

export interface Job {
  runId: string;
  kind: JobKind;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  logBuffer: string[];
  report?: SelfVerifyReport | AgenticReport;
  error?: string;
}

/**
 * Execution backend. The default implementation (in tools-server.ts) calls
 * runSelfVerify / runAgenticLoop. `signal` is best-effort — the underlying
 * self-verify functions may ignore it; cancellation discards any late result.
 */
export interface Runner {
  tier1(opts: StartTier1Opts, log: (m: string) => void, signal: AbortSignal): Promise<SelfVerifyReport>;
  agentic(opts: StartAgenticOpts, log: (m: string) => void, signal: AbortSignal): Promise<AgenticReport>;
}

const LOG_CAP = 2000;
const JOB_CAP = 20;

export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();

  constructor(private readonly runner: Runner) {}

  start(opts: StartOpts): string {
    const runId = randomUUID();
    const ctrl = new AbortController();
    const job: Job = {
      runId,
      kind: opts.kind,
      status: "running",
      startedAt: Date.now(),
      logBuffer: [],
    };
    this.jobs.set(runId, job);
    this.controllers.set(runId, ctrl);
    this.evict();

    const log = (m: string) => {
      job.logBuffer.push(m);
      if (job.logBuffer.length > LOG_CAP) {
        job.logBuffer.splice(0, job.logBuffer.length - LOG_CAP);
      }
    };

    const run =
      opts.kind === "tier1" ? this.runner.tier1(opts, log, ctrl.signal) : this.runner.agentic(opts, log, ctrl.signal);

    run.then(
      (report) => {
        this.controllers.delete(runId); // I2: keep maps symmetric after natural completion
        if (job.status === "cancelled") return;
        job.report = report;
        job.status = "done";
        job.finishedAt = Date.now();
      },
      (err) => {
        this.controllers.delete(runId); // I2: keep maps symmetric after natural completion
        if (job.status === "cancelled") return;
        job.error = err instanceof Error ? err.message : String(err);
        job.status = "error";
        job.finishedAt = Date.now();
      },
    );

    return runId;
  }

  status(runId: string): Job | undefined {
    return this.jobs.get(runId);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  cancel(runId: string): boolean {
    const job = this.jobs.get(runId);
    if (!job || job.status !== "running") return false;
    this.controllers.get(runId)?.abort();
    job.status = "cancelled";
    job.finishedAt = Date.now();
    return true;
  }

  private evict(): void {
    if (this.jobs.size <= JOB_CAP) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (this.jobs.size > JOB_CAP) {
      const oldest = sorted.shift();
      if (!oldest) break;
      this.controllers.get(oldest.runId)?.abort(); // I1: abort still-running evicted jobs
      this.jobs.delete(oldest.runId);
      this.controllers.delete(oldest.runId);
    }
  }
}
