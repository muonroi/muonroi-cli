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
import { markPhaseDone, nextPendingPhase, type PlanPhase, parsePlanMarkdown } from "./plan-artifact.js";

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
// spawnSync's default maxBuffer is 1 MB — a verify command (e.g. a test suite
// with a failing assertion dump) can trivially exceed that, and when it does
// the overflow surfaces ONLY via r.error (ENOBUFS), not via stdout/stderr
// truncation you'd notice. Set deliberately rather than inheriting the default.
const VERIFY_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Mirrors the injectable-exec pattern in src/scaffold/bb-quality-gate.ts:39.
 *
 * spawnSync surfaces a timeout (ETIMEDOUT), a spawn failure (ENOENT — bad
 * shell/cmd), and stdout/stderr overflow (ENOBUFS) ONLY via `r.error`, and all
 * three also leave `status: null`. Without folding `r.error.message` into the
 * output, `verifyPhase` still correctly fails the gate, but the halt reason —
 * the entire diagnostic value of this gate — is empty or silently truncated.
 */
function defaultExec(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  const r = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    shell: true,
    maxBuffer: VERIFY_MAX_BUFFER_BYTES,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.error ? `${r.stderr ?? ""}\n[exec error] ${r.error.message}` : (r.stderr ?? "");
  return { stdout, stderr, status: r.status };
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
    let body: string;
    try {
      body = readFileSync(args.planPath, "utf8");
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[council/plan-execution] could not read ${args.planPath}: ${message}`);
      return {
        completed,
        haltedAt: completed[completed.length - 1] ?? null,
        reason: `could not read ${args.planPath}: ${message}`,
      };
    }
    const phase = nextPendingPhase(body);
    if (!phase) return { completed, haltedAt: null, reason: "plan complete" };

    yield { type: "content", content: `\n## ${phase.id} — ${phase.title}\n` };

    // Filter the inner turn's OWN terminal `{type:"done"}` chunk(s) rather than
    // forwarding them verbatim. runCouncil (the caller of runPlanExecution)
    // emits its own done at the true end of the turn, after every phase — a
    // done chunk surfacing after phase 1 tells the stream consumer the turn
    // ended there, which previously made this exact class of consumer stop
    // pulling and suspend the generator (see the blocker-5 comment above Phase
    // E's call site in council/index.ts). With N phases this would strand
    // every phase after the first — precisely the "only the first step ever
    // landed" defect this module exists to fix, one layer up.
    for await (const chunk of args.processMessage(buildPhasePrompt(args.planPath, phase))) {
      if (chunk.type === "done") continue;
      yield chunk;
    }

    const result = verifyPhase(phase, args.cwd, args.exec);
    if (!result.ok) {
      yield {
        type: "content",
        content: `\n> Halted at ${phase.id}: verify failed.\n\n${result.output.slice(0, 2000)}\n`,
      };
      return { completed, haltedAt: phase.id, reason: result.output };
    }

    // Re-read rather than reusing the pre-turn `body`: the phase's own agent
    // turn holds write tools pointed at the plan path itself, and may have
    // touched PLAN.md (e.g. to annotate progress) — writing back the STALE
    // pre-turn body would silently clobber that edit.
    let freshBody: string;
    try {
      freshBody = readFileSync(args.planPath, "utf8");
    } catch (err) {
      const message = (err as Error).message;
      console.error(
        `[council/plan-execution] verify passed for ${phase.id} but could not re-read ${args.planPath}: ${message}`,
      );
      return { completed, haltedAt: phase.id, reason: `verify passed but could not re-read the plan: ${message}` };
    }

    // The phase turn may have already marked itself done in PLAN.md — not an
    // error, just nothing further to write.
    const alreadyDone = parsePlanMarkdown(freshBody).find((p) => p.id === phase.id)?.done === true;
    if (!alreadyDone) {
      const next = markPhaseDone(freshBody, phase.id);
      // markPhaseDone returns the body UNCHANGED when the phase's `**Status:**`
      // line is missing or the id no longer matches (plan-artifact.ts) — almost
      // always a hand-edited plan, since the planner's own renderPlanMarkdown
      // always emits one. Without this check a no-op write-back means the next
      // loop iteration re-reads the SAME pending phase and runs another full
      // agent turn plus another verify — unbounded, with no iteration cap.
      if (next === freshBody) {
        const reason = `could not mark ${phase.id} done — the plan on disk no longer matches the phase that was just verified`;
        console.error(`[council/plan-execution] ${reason}`);
        yield { type: "content", content: `\n> Halted at ${phase.id}: ${reason}\n` };
        return { completed, haltedAt: phase.id, reason };
      }
      try {
        writeFileSync(args.planPath, next, "utf8");
      } catch (err) {
        const message = (err as Error).message;
        console.error(
          `[council/plan-execution] verify passed for ${phase.id} but could not write ${args.planPath}: ${message}`,
        );
        return {
          completed,
          haltedAt: phase.id,
          reason: `verify passed but could not persist plan progress: ${message}`,
        };
      }
    }
    completed.push(phase.id);
  }
}
