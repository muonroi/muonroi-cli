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
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { COUNCIL_PLAN_EXECUTION_MARKER } from "../pil/layer6-output.js";
import type { StreamChunk } from "../types/index.js";
import { markPhaseDone, nextPendingPhase, type PlanPhase, parsePlanMarkdown } from "./plan-artifact.js";

/**
 * `error` mirrors what `child_process.spawn`/`spawnSync` actually surface for a
 * timeout, a spawn failure (ENOENT — bad shell/cmd), or output overflow: NONE
 * of the three produce useful stdout/stderr on their own, all three leave
 * `status: null`, and the message is the only diagnostic. verifyPhase folds it
 * into the halt reason — the entire diagnostic value of this gate — so an
 * injected ExecFn can reproduce any of the three deterministically without a
 * real process (see plan-execution.test.ts).
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: { message: string };
}

export type ExecFn = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;

/**
 * Round 3 (code review): verify used to run via `spawnSync`, which blocks the
 * single-threaded event loop for its entire duration. A verify command is a
 * REAL test suite — `bunx vitest run` on this repo alone takes ~6.5 minutes
 * (CLAUDE.md) — and this call happens inside a live TUI turn, not a one-shot
 * scaffold step (spawnSync's origin, src/scaffold/bb-quality-gate.ts, runs
 * during scaffold, never inside a turn). Blocking the event loop for minutes
 * freezes rendering, keypresses, AND abort — every watchdog in this codebase
 * is setTimeout-driven and therefore blind while the loop is blocked. This
 * repo has documented history of exactly that pathology (~305s freezes where
 * input replayed on recovery — see project memory "Event-Loop Freeze").
 * `spawn` + a promise keeps the gate's CONTRACT identical (no verify command
 * fails, non-zero exit fails, a failed verify halts before markPhaseDone)
 * while never blocking the loop the TUI itself runs on.
 */
const VERIFY_TIMEOUT_MS = 600_000;
// Kept at the same 10-minute ceiling from round 1's spawnSync `timeout`
// option, chosen deliberately rather than left over by inertia: ~3.5 minutes
// of headroom over the documented ~6.5-minute full-suite baseline (CLAUDE.md)
// for a realistic verify command (tsc + vitest + lint chained), while still
// bounding a genuinely hung command (e.g. a test awaiting input) to a single
// digit number of minutes rather than leaving a phase — and the whole plan
// run behind it — stuck indefinitely. Async removes the EVENT-LOOP-blocking
// argument for shortening it; it does not remove the case for an upper bound.
const VERIFY_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Mirrors the injectable-exec pattern in src/scaffold/bb-quality-gate.ts:39,
 * adapted to async `spawn` (see the module-level comment on VERIFY_TIMEOUT_MS
 * for why). Streams stdout/stderr instead of buffering them internally the
 * way `spawnSync`'s `maxBuffer` does, so the overflow cap here is
 * self-enforced: once accumulated output crosses VERIFY_MAX_BUFFER_BYTES the
 * child is killed and `error` is set, mirroring spawnSync's ENOBUFS shape.
 */
function defaultExec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, shell: true });
    } catch (err) {
      // A handful of platforms throw synchronously on a malformed spawn
      // request instead of emitting 'error' — treat identically.
      resolve({ stdout: "", stderr: "", status: null, error: { message: (err as Error).message } });
      return;
    }

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ stdout, stderr, status: null, error: { message: `verify command timed out after ${timeoutMs}ms` } });
      child.kill("SIGKILL");
    }, timeoutMs);

    const onOverflow = () => {
      finish({
        stdout,
        stderr,
        status: null,
        error: { message: `verify command output exceeded ${VERIFY_MAX_BUFFER_BYTES} bytes` },
      });
      child.kill("SIGKILL");
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      if (stdout.length + stderr.length > VERIFY_MAX_BUFFER_BYTES) onOverflow();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > VERIFY_MAX_BUFFER_BYTES) onOverflow();
    });

    // 'error' = the process never started (bad shell/cmd — ENOENT-class).
    child.on("error", (err) => {
      finish({ stdout, stderr, status: null, error: { message: err.message } });
    });

    // 'close' = the process ran to completion (or was killed above, in which
    // case `finish` already settled and this is a no-op via the settled guard).
    child.on("close", (code) => {
      finish({ stdout, stderr, status: code });
    });
  });
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
export async function verifyPhase(
  phase: PlanPhase,
  cwd: string,
  exec: ExecFn = defaultExec,
): Promise<{ ok: boolean; output: string }> {
  if (!phase.verify.trim()) {
    return { ok: false, output: `[${phase.id}] no verify command in the plan — cannot gate this phase` };
  }
  try {
    const r = await exec(phase.verify, [], cwd, VERIFY_TIMEOUT_MS);
    // `error` (timeout / spawn failure / output overflow — see ExecResult's
    // doc comment) is the ONLY place those three signals surface; fold the
    // message into the halt reason or the gate fails silently on exactly the
    // failures where the diagnostic matters most.
    const parts = [r.stdout, r.stderr];
    if (r.error) parts.push(`[exec error] ${r.error.message}`);
    const output = parts.join("\n").trim();
    return { ok: r.status === 0 && !r.error, output };
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

    const result = await verifyPhase(phase, args.cwd, args.exec);
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
