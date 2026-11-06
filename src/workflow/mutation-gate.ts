import { canExecute, readState } from "./workflow-engine.js";

export interface MutationGateDecision {
  blocked: boolean;
  reason: string;
}

const NEVER_GATED_PREFIXES = ["flow_", "respond_"];
// Shared by the execution wrapper and gate so new read-only diagnostics cannot
// accidentally inherit workspace mutation authorization requirements.
export const WORKFLOW_READ_ONLY_TOOLS = Object.freeze([
  "context_load",
  "skill_load",
  "search_session_history",
  "retrieve_tool_result",
  "list_tools",
  "list_mcp_servers",
  "describe_tool",
  "worker_models",
  "worker_capabilities",
  "usage_forensics",
  "delegation_read",
  "delegation_list",
  "selfverify_status",
  "selfverify_result",
  "selfverify_list",
  "wait_for_diagnostics",
  "impact_of_change",
]);
const NEVER_GATED = new Set([
  ...WORKFLOW_READ_ONLY_TOOLS,
  "read_file",
  "grep",
  "glob",
  "bash_output_get",
  "flow_status",
  "integration_status",
  "compact",
  // Background delegation enforces explore-only. Research and human questions
  // are prerequisites for reviewing a plan, not authorization to mutate code.
  "delegate",
  "ask_user",
  "delegation_kill",
  // Progress bookkeeping neither edits the workspace nor grants execution.
  "todo_write",
  "delegation_ack",
  "verification_run",
]);
function isNeverGated(t: string): boolean {
  return NEVER_GATED.has(t) || NEVER_GATED_PREFIXES.some((p) => t.startsWith(p));
}

const GATE_DIRECTIVE =
  "BLOCKED: this task was assessed as non-trivial. FLOW requires a reviewed plan before any code edit. " +
  "Call flow_status, then flow_discuss → flow_plan → flow_plan_review. Mutation tools unlock only after " +
  "plan-review returns verdict: pass. For verification of existing code, use verification_run with explicit local test files and a supported runner, or selfverify_start mode=tier1 emit=false. These do not unlock source edits. If this is genuinely trivial, call flow_execute with force:true to override.";

const TASK_GATE_DIRECTIVE =
  "BLOCKED: FLOW refused dispatch of a mutation-capable worker because this workspace is at heavy depth " +
  "and canExecute has not admitted execution. No worker was started by this call. " +
  "worker_models and worker_capabilities remain available for discovery; task(agent=explore) remains available " +
  "for read-only research, with its shell independently gated. This is not a provider authentication or permission-mode failure; " +
  "yolo does not satisfy a workflow review. Inspect flow_status for the exact gate and obtain an authorized reviewed plan " +
  "before dispatching mutation-capable work. If the requested probe forbids workflow changes, report this blocker and stop.";

/**
 * Gate = the SDK's own canExecute, keyed on the SDK STATE.md Depth (written by the
 * turn's syncWorkflowContext). Reading depth from readState — NOT from a
 * caller-passed value or pilCtx — makes STATE.md the single source of truth and
 * decouples the gate from pilCtx object propagation. quick depth is fast-pathed by
 * canExecute; standard is advisory, explicit heavy gates mutations and
 * mutation-capable task dispatch. Catalog discovery grants no execution rights.
 */
export function evaluateMutationGate(
  cwd: string,
  opts: { toolName: string; hardGateEnabled: boolean; directAnswer?: boolean; input?: unknown },
): MutationGateDecision {
  const allow = { blocked: false, reason: "" };
  const input = opts.input as { mode?: unknown; emit?: unknown; agent?: unknown } | undefined;
  // The built-in explore executor exposes read-only tools; its shell remains
  // independently gated against the originating main cwd in StreamRunner.
  if (opts.toolName === "task" && input?.agent === "explore") return allow;
  if (opts.toolName === "selfverify_start" && input?.mode === "tier1" && input.emit === false) return allow;
  if (!opts.hardGateEnabled || opts.directAnswer || isNeverGated(opts.toolName)) return allow;
  try {
    const depth = readState(cwd).depth;
    // Fail OPEN on anything but an EXPLICIT "heavy" depth. quick/standard/null all pass:
    // - null STATE (not classified / native off mid-turn / write failed) → over-blocking on
    //   "we don't know" is the failure mode the design forbids.
    // - quick → trivial fast-path.
    // - standard → ADVISORY only. The layer4 directive still nudges flow_plan_review, but
    //   hard-blocking every default-tier bash/edit until a plan-review pass over-reaches
    //   ("hard thì mọi tier không tốt"). Only genuinely non-trivial work (heavy, incl. tasks
    //   the leader-tier assessor UPGRADES to heavy) earns the hard gate.
    if (!depth || depth === "quick") return allow;
    if (depth === "standard") {
      console.warn(
        `[flow] advisory: depth=standard but plan-review not yet passed — ` + GATE_DIRECTIVE.slice(0, 120) + "...",
      );
      return { blocked: false, reason: GATE_DIRECTIVE };
    }
    const gate = canExecute(cwd, depth);
    return gate.allowed
      ? allow
      : { blocked: true, reason: opts.toolName === "task" ? TASK_GATE_DIRECTIVE : GATE_DIRECTIVE };
  } catch (err) {
    console.error(`[flow] mutation-gate canExecute failed, failing open: ${(err as Error).message}`);
    return allow; // fail open — a corrupt .planning must not brick the turn; caps still bound loops
  }
}
