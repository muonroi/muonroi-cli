/**
 * The marked execution envelope and the per-phase loop (design 2026-08-04).
 *
 * Replaces the old executor.ts, which flattened every step of the council's
 * action plan into ONE ungated prompt — the structural reason only the first
 * step ever landed. This module runs one phase per turn from the approved
 * `.planning/PLAN.md`, gates each phase on its OWN verify command, and halts
 * on the first failure instead of marching on with no evidence the phase
 * actually worked.
 *
 * The measured defect this closes: session 3a8378db4adf's post-debate
 * continuation was classified taskType=analyze / deliverable=report
 * (interaction_logs id 2498) because the prose carried no signal the pipeline
 * recognises as "this turn must keep write tools". COUNCIL_PLAN_EXECUTION_MARKER
 * (src/pil/layer6-output.ts) is stamped into every phase prompt so
 * src/pil/pipeline.ts routes it into the same directAnswer:false /
 * deliverableKind:"code" branch SPRINT_EXECUTION_MARKER already uses for /ideal.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { COUNCIL_PLAN_EXECUTION_MARKER } from "../pil/layer6-output.js";
import type { StreamChunk } from "../types/index.js";
import { markPhaseDone, nextPendingPhase, type PlanPhase } from "./plan-artifact.js";

export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => {
  stdout: string;
  stderr: string;
  status: number | null;
};

const VERIFY_TIMEOUT_MS = 600_000;

/** Mirrors the injectable-exec pattern in src/scaffold/bb-quality-gate.ts:39. */
function defaultExec(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8", shell: true });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

export function buildPhasePrompt(planPath: string, phase: PlanPhase): string {
  return [
    COUNCIL_PLAN_EXECUTION_MARKER,
    "",
    `Execute phase ${phase.id} — ${phase.title} — from the approved plan at \`${planPath}\`.`,
    "This phase only. Do not start a later phase and do not re-plan.",
    "",
    "Steps:",
    ...phase.steps.map((s) => `- ${s}`),
    "",
    phase.files.length ? `Files: ${phase.files.join(", ")}` : "",
    "",
    "Acceptance criteria this phase is gated on:",
    ...phase.acceptance.map((a) => `- ${a}`),
    "",
    phase.verify ? `Verify with: ${phase.verify}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Deterministic phase gate. A phase with NO verify command fails rather than
 * passing: an unverifiable phase silently ticking itself green is precisely the
 * shallow "implemented" the plan gate exists to prevent. The planner is required
 * to supply one (parsePlannerPhases drops criteria-less phases), so an empty
 * command here means the plan was hand-edited.
 */
export function verifyPhase(
  phase: PlanPhase,
  cwd: string,
  exec: ExecFn = defaultExec,
): { ok: boolean; output: string } {
  if (!phase.verify.trim()) {
    return { ok: false, output: `[${phase.id}] no verify command in the plan — cannot gate this phase` };
  }
  try {
    const r = exec(phase.verify, [], cwd, VERIFY_TIMEOUT_MS);
    const output = `${r.stdout}\n${r.stderr}`.trim();
    return { ok: r.status === 0, output };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[council/plan-execution] verify threw for ${phase.id}: ${message}`);
    return { ok: false, output: message };
  }
}

export interface ExecutionArgs {
  cwd: string;
  planPath: string;
  processMessage: (message: string) => AsyncGenerator<StreamChunk, void, unknown>;
  exec?: ExecFn;
}

export async function* runPlanExecution(
  args: ExecutionArgs,
): AsyncGenerator<StreamChunk, { completed: string[]; haltedAt: string | null; reason: string }, unknown> {
  const completed: string[] = [];
  for (;;) {
    const body = readFileSync(args.planPath, "utf8");
    const phase = nextPendingPhase(body);
    if (!phase) return { completed, haltedAt: null, reason: "plan complete" };

    yield { type: "content", content: `\n## ${phase.id} — ${phase.title}\n` };
    yield* args.processMessage(buildPhasePrompt(args.planPath, phase));

    const result = verifyPhase(phase, args.cwd, args.exec);
    if (!result.ok) {
      yield {
        type: "content",
        content: `\n> Halted at ${phase.id}: verify failed.\n\n${result.output.slice(0, 2000)}\n`,
      };
      return { completed, haltedAt: phase.id, reason: result.output };
    }
    writeFileSync(args.planPath, markPhaseDone(body, phase.id), "utf8");
    completed.push(phase.id);
  }
}
