import { canExecute, readState } from "./workflow-engine.js";

export interface MutationGateDecision {
  blocked: boolean;
  reason: string;
}

const NEVER_GATED_PREFIXES = ["gsd_", "respond_"];
const NEVER_GATED = new Set(["read_file", "grep", "glob", "bash_output_get", "gsd_status", "compact"]);
function isNeverGated(t: string): boolean {
  return NEVER_GATED.has(t) || NEVER_GATED_PREFIXES.some((p) => t.startsWith(p));
}

const GATE_DIRECTIVE =
  "BLOCKED: this task was assessed as non-trivial. GSD requires a reviewed plan before any code edit. " +
  "Call gsd_status, then gsd_discuss → gsd_plan → gsd_plan_review. Mutation tools unlock only after " +
  "plan-review returns verdict: pass. If this is genuinely trivial, call gsd_execute with force:true to override.";

/**
 * Gate = the SDK's own canExecute, keyed on the SDK STATE.md Depth (written by the
 * turn's syncWorkflowContext). Reading depth from readState — NOT from a
 * caller-passed value or pilCtx — makes STATE.md the single source of truth and
 * decouples the gate from pilCtx object propagation. quick depth is fast-pathed by
 * canExecute; standard/heavy gate on plan-verify pass.
 */
export function evaluateMutationGate(
  cwd: string,
  opts: { toolName: string; hardGateEnabled: boolean; directAnswer?: boolean },
): MutationGateDecision {
  const allow = { blocked: false, reason: "" };
  if (!opts.hardGateEnabled || opts.directAnswer || isNeverGated(opts.toolName)) return allow;
  try {
    const depth = readState(cwd).depth;
    // Fail OPEN on anything but an EXPLICIT "heavy" depth. quick/standard/null all pass:
    // - null STATE (not classified / native off mid-turn / write failed) → over-blocking on
    //   "we don't know" is the failure mode the design forbids.
    // - quick → trivial fast-path.
    // - standard → ADVISORY only. The layer4 directive still nudges gsd_plan_review, but
    //   hard-blocking every default-tier bash/edit until a plan-review pass over-reaches
    //   ("hard thì mọi tier không tốt"). Only genuinely non-trivial work (heavy, incl. tasks
    //   the leader-tier assessor UPGRADES to heavy) earns the hard gate.
    if (!depth || depth === "quick" || depth === "standard") return allow;
    const gate = canExecute(cwd, depth);
    return gate.allowed ? allow : { blocked: true, reason: GATE_DIRECTIVE };
  } catch (err) {
    console.error(`[gsd] mutation-gate canExecute failed, failing open: ${(err as Error).message}`);
    return allow; // fail open — a corrupt .planning must not brick the turn; caps still bound loops
  }
}
