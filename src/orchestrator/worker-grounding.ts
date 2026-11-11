/**
 * src/orchestrator/worker-grounding.ts
 *
 * Grounding check on a delegated worker's FINAL result, before the result is
 * saved for (and delivered to) the orchestrator. The main-turn check
 * (grounding-check.ts, wired in tool-engine.ts) never saw worker results: a
 * worker that wrote "all tests pass" without running a test reached the
 * orchestrator as an unqualified completed result, and the only defence was
 * contract prose ("never claim a test ran when it didn't").
 *
 * The host now:
 *   1. observes every tool call the worker completes (input + result text),
 *   2. checks the final answer's test/build claims against the worker's own
 *      recorded runs (verification-claims.ts) and its counts / file:line refs
 *      against the worker's tool outputs (grounding-check.ts),
 *   3. folds a structured `[host-grounding]` block into the result — and a
 *      one-line flag at the top, so the delegation summary, the completion
 *      notice and the Agents rail all carry it, and
 *   4. appends a `[host-verification]` record of the runs it saw, so the
 *      orchestrator's own later "tests pass" can be grounded on them.
 *
 * Soft flag only: the job's success/failure is unchanged.
 */

import type { ToolSet } from "ai";
import type { ToolResult } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { findUnverifiedClaims, type UnverifiedClaim } from "./grounding-check.js";
import {
  checkVerificationClaims,
  formatHostVerificationRecord,
  outcomesFromToolCall,
  type RecordedVerification,
  type UnsupportedVerificationClaim,
} from "./verification-claims.js";

export const WORKER_GROUNDING_TAG = "[host-grounding]";
const FLAG_LINE_PREFIX = "[host] Grounding check:";
const MAX_OUTPUT_PER_CALL = 200_000;
const MAX_CORPUS_CHARS = 4_000_000;

export interface WorkerGroundingReport {
  v: 1;
  /** Test/build claims not supported by the worker's recorded runs. */
  verification: Array<Pick<UnsupportedVerificationClaim, "kind" | "polarity" | "text" | "reason">>;
  /** Counts / file:line refs absent from the worker's tool outputs. */
  unverified: Array<Pick<UnverifiedClaim, "kind" | "text">>;
}

/** Records what a worker's tools returned, for grounding its final answer. */
export class WorkerEvidence {
  private readonly outputs: string[] = [];
  private chars = 0;
  private readonly runs: RecordedVerification[] = [];

  /** Wrap every executable tool; execution and results are unchanged. */
  wrap(tools: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        if (!tool.execute) return [name, tool];
        const execute = tool.execute;
        return [
          name,
          {
            ...tool,
            execute: async (input: any, context: any) => {
              const result = await execute(input, context);
              this.observe(String(context?.toolCallId ?? `${name}-${this.runs.length}`), name, input, result);
              return result;
            },
          },
        ];
      }),
    ) as ToolSet;
  }

  observe(toolCallId: string, toolName: string, input: unknown, result: unknown): void {
    let text: string;
    try {
      text = typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      logger.file("warn", "orchestrator", "Worker grounding could not serialise a tool result", {
        toolName,
        error: String(err),
      });
      return;
    }
    if (typeof text !== "string") return;
    if (this.chars < MAX_CORPUS_CHARS) {
      const kept = text.slice(0, MAX_OUTPUT_PER_CALL);
      this.outputs.push(kept);
      this.chars += kept.length;
    }
    this.runs.push(...outcomesFromToolCall(toolCallId, toolName, input, text));
  }

  verifications(): RecordedVerification[] {
    return [...this.runs];
  }

  corpus(): string {
    return this.outputs.join("\n");
  }
}

/** Grounding report for a worker's final answer, or null when nothing is flagged. */
export function assessWorkerAnswer(
  answer: string,
  evidence: WorkerEvidence,
  assignment = "",
): WorkerGroundingReport | null {
  if (!answer.trim()) return null;
  const verification = checkVerificationClaims(answer, evidence.verifications()).map(
    ({ kind, polarity, text, reason }) => ({ kind, polarity, text, reason }),
  );
  // The assignment is part of the corpus: numbers the orchestrator handed the
  // worker are not fabrications when the worker repeats them.
  const unverified = findUnverifiedClaims(answer, `${assignment}\n${evidence.corpus()}`).map(({ kind, text }) => ({
    kind,
    text,
  }));
  if (!verification.length && !unverified.length) return null;
  return { v: 1, verification, unverified };
}

function flagLine(report: WorkerGroundingReport): string {
  const parts = [
    ...(report.verification.length
      ? [`${report.verification.length} test/build claim(s) without a supporting recorded run`]
      : []),
    ...(report.unverified.length
      ? [`${report.unverified.length} count/file:line claim(s) absent from the worker's tool output`]
      : []),
  ];
  return `${FLAG_LINE_PREFIX} ${parts.join("; ")} — treat them as unverified; details in the ${WORKER_GROUNDING_TAG} block at the end.`;
}

/**
 * Fold the host's grounding report and verification record into a worker's
 * result text. JSON-only deliverables (reviews, verify recipes) and outputs
 * without flags or runs are returned unchanged.
 */
export function applyWorkerGrounding(
  result: ToolResult,
  report: WorkerGroundingReport | null,
  verifications: readonly RecordedVerification[],
  source: string,
): ToolResult {
  const output = result.output ?? "";
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return result;
  const record = formatHostVerificationRecord(source, verifications);
  if (!report && !record) return result;
  const tail = [
    ...(report ? [`${WORKER_GROUNDING_TAG} ${JSON.stringify(report)}`] : []),
    ...(record ? [record] : []),
  ].join("\n");
  const head = report ? `${flagLine(report)}\n` : "";
  return { ...result, output: `${head}${output}\n\n${tail}` };
}

const REPORT_RE = /\[host-grounding\] (\{[^\n]*\})/g;

/** Parse every worker grounding report embedded in `text`. */
export function parseWorkerGroundingReports(text: string): WorkerGroundingReport[] {
  const out: WorkerGroundingReport[] = [];
  for (const m of text.matchAll(REPORT_RE)) {
    try {
      const parsed = JSON.parse(m[1]!) as WorkerGroundingReport;
      if (parsed?.v === 1 && Array.isArray(parsed.verification) && Array.isArray(parsed.unverified)) out.push(parsed);
    } catch (err) {
      logger.file("warn", "orchestrator", "Malformed worker grounding report", { error: String(err) });
    }
  }
  return out;
}

/** Claim strings for the `grounding-flag` event / toast (prefixed with the job when known). */
export function workerGroundingClaims(report: WorkerGroundingReport, jobId?: string): string[] {
  const who = jobId ? `worker ${jobId}` : "worker";
  return [
    ...report.verification.map((c) => `${who}: "${c.text}" (${c.reason})`),
    ...report.unverified.map((c) => `${who}: ${c.text}`),
  ];
}

const surfaced = new Set<string>();

/**
 * Show worker grounding flags in the TUI (grounding-flag event + warn toast)
 * when a worker result reaches the orchestrator — notice, foreground task
 * result or delegation_read. Each report is surfaced once per process.
 */
export function surfaceWorkerGrounding(text: string | undefined, jobId?: string): number {
  if (!text?.includes(WORKER_GROUNDING_TAG)) return 0;
  const id = jobId ?? /\bjobId=([\w-]+)/.exec(text)?.[1] ?? /Background agent \w+: `([\w-]+)`/.exec(text)?.[1];
  const runtime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
    | { emitEvent: (e: unknown) => void }
    | undefined;
  let count = 0;
  for (const report of parseWorkerGroundingReports(text)) {
    const key = `${id ?? ""}:${JSON.stringify(report)}`;
    if (surfaced.has(key)) continue;
    surfaced.add(key);
    const claims = workerGroundingClaims(report, id);
    count += claims.length;
    runtime?.emitEvent({ t: "event", kind: "grounding-flag", claims, count: claims.length, ts: Date.now() });
    runtime?.emitEvent({
      t: "event",
      kind: "toast",
      level: "warn",
      text: `grounding: worker${id ? ` ${id}` : ""} — ${claims.length} unverified claim(s): ${claims.join("; ")}`,
    });
  }
  return count;
}
