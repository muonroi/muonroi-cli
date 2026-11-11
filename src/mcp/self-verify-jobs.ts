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
import { validateSelfVerifyRequest } from "../self-qa/validate-request.js";

export type JobKind = "tier1" | "agentic";
export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface StartTier1Opts {
  kind: "tier1";
  cwd?: string;
  files?: string[];
  mockLlmDir?: string;
  since?: string;
  max?: number;
  emit?: boolean;
  out?: string;
}

export interface StartAgenticOpts {
  kind: "agentic";
  cwd?: string;
  goal: string;
  llm: string;
  turns?: number;
  mockLlmDir?: string;
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
  /** Settles when the run leaves `running` (done / error / cancelled / evicted). */
  private finished = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Terminal runs whose outcome reached the caller (notice or result read). */
  private reported = new Set<string>();

  constructor(private readonly runner: Runner) {}

  private settle(runId: string): void {
    this.finished.get(runId)?.resolve();
  }

  /**
   * Host wait until `runId` is no longer running (or `signal` aborts /
   * `timeoutMs` elapses). Replaces polling selfverify_status. Returns the job,
   * or undefined for an unknown runId.
   */
  async waitFor(runId: string, signal?: AbortSignal, timeoutMs?: number): Promise<Job | undefined> {
    const job = this.jobs.get(runId);
    if (!job || job.status !== "running") return job;
    const gate = this.finished.get(runId);
    if (!gate) return job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      gate.promise,
      new Promise<void>((resolve) => {
        if (timeoutMs !== undefined) timer = setTimeout(resolve, timeoutMs);
        if (signal) {
          onAbort = () => resolve();
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    return this.jobs.get(runId);
  }

  /** Mark a terminal run as reported so no completion notice repeats it. */
  markReported(runId: string): void {
    const job = this.jobs.get(runId);
    if (job && job.status !== "running") this.reported.add(runId);
  }

  /**
   * One notice per run that finished since the last call and whose outcome the
   * caller has not read yet — the self-verify counterpart of delegation
   * completion notices, so a caller is told instead of polling.
   */
  consumeCompletionNotices(): string[] {
    const notices: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" || this.reported.has(job.runId)) continue;
      this.reported.add(job.runId);
      const summary =
        job.report && "summary" in job.report
          ? JSON.stringify(job.report.summary)
          : job.report && "verdict" in job.report
            ? `verdict=${String(job.report.verdict)}`
            : job.error
              ? `error=${job.error}`
              : "";
      notices.push(
        `Self-verify run ${job.status}: runId=${job.runId} kind=${job.kind}${summary ? ` ${summary}` : ""}. Full report: selfverify_result({runId:"${job.runId}"}).`,
      );
    }
    return notices;
  }

  start(opts: StartOpts): string {
    const invalid = validateSelfVerifyRequest(opts);
    if (invalid) throw new Error(invalid);
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
    let resolveFinished = () => {};
    const finishedPromise = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    this.finished.set(runId, { promise: finishedPromise, resolve: resolveFinished });
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
        this.settle(runId);
      },
      (err) => {
        this.controllers.delete(runId); // I2: keep maps symmetric after natural completion
        if (job.status === "cancelled") return;
        job.error = err instanceof Error ? err.message : String(err);
        job.status = "error";
        job.finishedAt = Date.now();
        this.settle(runId);
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
    // The caller cancelled it: it already knows, so no completion notice.
    this.reported.add(runId);
    this.settle(runId);
    return true;
  }

  private evict(): void {
    if (this.jobs.size <= JOB_CAP) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (this.jobs.size > JOB_CAP) {
      const oldest = sorted.shift();
      if (!oldest) break;
      this.controllers.get(oldest.runId)?.abort(); // I1: abort still-running evicted jobs
      this.settle(oldest.runId);
      this.jobs.delete(oldest.runId);
      this.controllers.delete(oldest.runId);
      this.finished.delete(oldest.runId);
      this.reported.delete(oldest.runId);
    }
  }
}
