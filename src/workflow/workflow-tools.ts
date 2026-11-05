import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { ExecutionRole } from "../orchestrator/orchestration-policy.js";
import type { TaskRequest, ToolResult } from "../types/index.js";
import type { AsyncPlanReviewHost, CompletedPlanReview } from "./async-plan-review.js";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { logFlowNativeEvent } from "./ee-closure.js";
import { isFlowNativeEnabled } from "./flags.js";
import { getFlowLoopHost, loopHostContext, taskToRunPerspectiveFn } from "./loop-host.js";
import { planningArtifact } from "./paths.js";
import type { PlanPerspective } from "./plan-council-prompts.js";
import {
  assessConvergence,
  currentWindow,
  readReviewRounds,
  type SettlementReason,
  type SettlementRecord,
  settlePlanReview,
} from "./plan-review-convergence.js";
import {
  createPlanReviewBudget,
  type PlanReviewBudget,
  planReviewBudgetStatus,
  resolvePlanReviewExhaustionPolicy,
} from "./review-budget.js";
import { MainReviewAssessmentSchema } from "./review-findings.js";
import { runVerifyCouncil } from "./verify-council.js";
import type { VerifyPerspective } from "./verify-council-prompts.js";
import {
  advancePhase,
  buildFlowStatusPayload,
  canExecute,
  canShip,
  readState,
  setStateField,
} from "./workflow-engine.js";

export interface FlowWorkflowToolOpts extends AsyncPlanReviewHost {
  executionRole?: ExecutionRole;
  cwd: string;
  sessionModelId: string;
  sessionId?: string;
  depth?: string;
  planReviewBudget?: PlanReviewBudget;
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDebate?: (topic: string, abortSignal?: AbortSignal, synthesisOutputContract?: string) => Promise<string>;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Adapts `taskToRunPerspectiveFn` (typed for plan-council `PlanPerspective`) to the verify
 * council's `VerifyPerspective` shape. Safe: `resolveFlowPerspectiveAgent` only special-cases
 * `id === "research"` (a plan-only id that never appears in `VerifyPerspectiveId`), so every
 * verify perspective routes to the same "verify" subagent regardless of id — only the id
 * value is threaded through for the task description string.
 */
function verifyRunPerspectiveFn(
  runTask: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>,
  sessionModelId: string,
): (prompt: string, p: VerifyPerspective) => Promise<string> {
  const planFn = taskToRunPerspectiveFn(runTask, sessionModelId);
  return (prompt, p) => planFn(prompt, p as unknown as PlanPerspective);
}

/** Best-effort implementation diff for the verify council. Empty on any failure — never throws. */
function readImplementationDiff(cwd: string): string {
  try {
    return execFileSync("git", ["diff", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    console.error(`[flow] verify-council diff capture failed: ${(err as Error).message}`);
    return "";
  }
}

export function registerFlowWorkflowTools(tools: ToolSet, opts: FlowWorkflowToolOpts): ToolSet {
  if (!isFlowNativeEnabled()) return tools;

  const depth = opts.depth ?? "standard";
  const { cwd, sessionModelId, sessionId, runTask } = opts;
  const reviewBudget = opts.planReviewBudget ?? createPlanReviewBudget(cwd);

  /**
   * Terminal outcome for a plan review that is not converging. Returns null when
   * the loop may continue (plan already admitted, no recorded non-pass review in
   * the current loop, or objections still changing within the allowance).
   */
  const convergenceOutcome = (
    budgetSpent: boolean,
  ):
    | { kind: "settled"; record: SettlementRecord }
    | { kind: "stop"; reason: SettlementReason; detail: string }
    | null => {
    if (readState(cwd).planVerified) return null;
    const rounds = readReviewRounds(cwd).rounds;
    const last = currentWindow(rounds).at(-1);
    if (!last) return null;
    const convergence = assessConvergence(rounds, { stallRounds: reviewBudget.max });
    const reason: SettlementReason | null = convergence.stalled
      ? convergence.reason
      : budgetSpent
        ? "budget_exhausted"
        : null;
    if (!reason) return null;
    const detail = convergence.stalled
      ? convergence.detail
      : `${convergence.trailingNonPass} consecutive non-pass review(s); ${convergence.detail}`;
    if (resolvePlanReviewExhaustionPolicy(cwd) === "stop") return { kind: "stop", reason, detail };
    const record = settlePlanReview({ cwd, reason, detail, openItems: last.openBlocking, budget: reviewBudget });
    // A settled plan is admitted: the tool loop must continue into execution.
    reviewBudget.stopRequested = false;
    announceSettlement(record, last.reviewId);
    return { kind: "settled", record };
  };
  const announceSettlement = (record: SettlementRecord, reviewId: string) => {
    logFlowNativeEvent(sessionId ?? "flow-native", {
      phase: readState(cwd).phase,
      depth,
      loopPoint: "plan:settle",
      planVerified: true,
      councilVerdict: `settled:${record.reason}`,
      councilConcernCount: record.openItems.length,
      reviewId,
    });
    const runtime = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { emitEvent?: (e: unknown) => void }
      | undefined;
    try {
      runtime?.emitEvent?.({
        t: "event",
        kind: "toast",
        level: "warn",
        text: `Plan review settled (${record.reason}): proceeding with ${record.openItems.length} open item(s) — ${record.openItems
          .map((f) => f.id)
          .join(", ")}`,
      });
    } catch (err) {
      console.error(`[flow] plan settlement toast emit failed: ${(err as Error).message}`);
    }
  };
  const settledResponse = (record: SettlementRecord) => {
    const status = buildFlowStatusPayload(cwd, depth);
    return json({
      ok: true,
      planVerified: true,
      settlement: record,
      review: status.review,
      gates: status.gates,
      phase: readState(cwd).phase,
      reviewBudget: planReviewBudgetStatus(reviewBudget),
      nextAction: "execute_with_open_items",
      message: record.message,
    });
  };
  const exhaustedReview = () => {
    if (readState(cwd).planVerified) {
      // Already admitted (council pass or host settlement): another council or a
      // plan rewrite is refused, but the request must not be stopped.
      return json({
        ok: false,
        code: "plan_review_budget_exhausted",
        planVerified: true,
        reviewBudget: planReviewBudgetStatus(reviewBudget),
        review: buildFlowStatusPayload(cwd, depth).review,
        nextAction: "execute",
        message:
          "The plan is already admitted; no further council or plan rewrite is bought. Proceed with the current plan and settle any open items in verification.",
      });
    }
    const outcome = convergenceOutcome(true);
    if (outcome?.kind === "settled") return settledResponse(outcome.record);
    reviewBudget.stopRequested = true;
    return json({
      ok: false,
      blocked: true,
      code: "plan_review_budget_exhausted",
      reviewBudget: planReviewBudgetStatus(reviewBudget),
      review: buildFlowStatusPayload(cwd, depth).review,
      nextAction: "stop_and_report",
      ...(outcome ? { nonConvergence: { reason: outcome.reason, detail: outcome.detail, policy: "stop" } } : {}),
      message:
        "Stop buying councils or ordinary plan rewrites. Read-only verification and main completion of an unchanged bound review remain available. For changed inputs, flow_plan_review(action=revalidate, jobId, resultVersion, reason, optional planBody) permits one independent verification per exact planning/source snapshot, without another council or allowance reset. Read the fresh dossier and supply per-finding main decisions. Failed/stale revalidation remains gated; report remaining evidence gaps. Never force execution or create a request to evade the allowance.",
    });
  };

  tools.flow_status = dynamicTool({
    description:
      "Read machine-readable native Muonroi Flow JSON: phase, gates, review concerns/artifact/nextAction, progress and completion scope. Plan approval is not implementation completion; recorded verification is not proof of whole-goal coverage or freshness. STATE.md is human-readable storage, not the gate JSON API. Pure read — does not advance phase or write state.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => {
      // Status is read-only even in a fresh workspace. Turn preparation/planning
      // owns bootstrap; inspecting a workflow must never create or unlock it.
      const status = {
        ...buildFlowStatusPayload(cwd, depth),
        reviewBudget: planReviewBudgetStatus(reviewBudget),
        gateScope: {
          canExecute:
            "Admission for flow_execute only; not a global task/delegate execution lock. Separately, an enabled heavy-depth mutation gate checks task dispatch that exposes mutation tools. Discovery and read-only research remain available.",
          canShip: "Admission for flow_ship only.",
          workerDispatch:
            "task/delegate apply their own model, role, permission and concurrency checks. Heavy-depth mutation admission also applies to mutation-capable task dispatch, independently of safe/auto/yolo permissions. worker_models, worker_capabilities and read-only research do not require a reviewed plan.",
        },
      };
      if (opts.executionRole !== "orchestrator") return json(status);
      // Preserve gate facts and durable state; project only host-generated action advice.
      const gate = (value: typeof status.gates.canExecute) => ({
        ...value,
        ...(value.reason ? { reason: value.reason.split(" — ")[0] } : {}),
      });
      return json({
        ...status,
        gates: { ...status.gates, canExecute: gate(status.gates.canExecute), canShip: gate(status.gates.canShip) },
        nextActions: status.reviewBudget.exhausted
          ? [
              "No additional ordinary plan rewrite or council is authorized. Read-only verification and completion of an unchanged bound review remain available. Changed plan: use flow_plan_review(action=revalidate, original jobId/resultVersion, reason, optional planBody) for fresh independent verification of the corrected planning/source snapshot; read its dossier, then complete its exact result with main decisions. No allowance reset or stale-verdict reuse. Fix evidenced gaps, then revalidate changed inputs with the original council; unchanged failed work is not retried.",
            ]
          : [
              "Use exposed planning/review tools to resolve the reported gate; delegate substantive implementation and independent verification to eligible workers through task.",
              "If a required workflow transition is unavailable, report the exact blocked gate and obtain an authorized workflow path. Do not clear state, widen grants, invent a tool or bypass the guard.",
            ],
      });
    },
  });

  tools.flow_discuss = dynamicTool({
    description: "Enter FLOW discuss phase — surface ambiguities before planning. Sets STATE.md phase to discuss.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        notes: { type: "string", description: "Gray-area notes to append" },
      },
    }),
    execute: async (input: any) => {
      ensurePlanningWorkspace(cwd, sessionModelId);
      const host = getFlowLoopHost();
      host.ensureHost(cwd, sessionModelId);
      advancePhase(cwd, "discuss");
      await host.onDiscussComplete(loopHostContext(cwd, sessionModelId, depth, { phase: "discuss" }));
      if (input.notes?.trim()) {
        const ctxPath = planningArtifact(cwd, "CONTEXT.md");
        const prior = existsSync(ctxPath) ? readFileSync(ctxPath, "utf8") : "# CONTEXT\n\n";
        writeFileSync(ctxPath, `${prior}\n${input.notes.trim()}\n`, "utf8");
      }
      return json({ phase: "discuss", ok: true });
    },
  });

  tools.flow_plan = dynamicTool({
    description:
      opts.executionRole === "orchestrator"
        ? "Write PLAN.md for a multi-step task. Resolve required review through available planning/review tools, then dispatch eligible workers within the resulting workflow gate."
        : "Write PLAN.md for a multi-step task (leader-tier draft). Call before flow_plan_review and flow_execute.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        body: { type: "string", description: "Full PLAN.md markdown body" },
      },
      required: ["body"],
    }),
    execute: async (input: any) => {
      if (reviewBudget.used >= reviewBudget.max) return exhaustedReview();
      if (!input.body?.trim()) {
        return json({ ok: false, error: "flow_plan requires non-empty body" });
      }
      ensurePlanningWorkspace(cwd, sessionModelId);
      writeFileSync(planningArtifact(cwd, "PLAN.md"), input.body.trim(), "utf8");
      setStateField(cwd, "Plan Verified", "no");
      advancePhase(cwd, "plan");
      const host = getFlowLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth, {
        phase: "plan",
        sessionId,
        planBody: input.body.trim(),
        planTitle: input.body
          .trim()
          .match(/^#\s+(.+)$/m)?.[1]
          ?.trim(),
      });
      await host.onPlanWritten(ctx);
      return json({ ok: true, path: planningArtifact(cwd, "PLAN.md") });
    },
  });

  // A resumed owner must still be able to complete its durable heavy review
  // when the new short wake-up message is classified as quick.
  if (depth !== "quick" || opts.executionRole === "orchestrator") {
    tools.flow_plan_review = dynamicTool({
      description:
        opts.executionRole === "orchestrator"
          ? "Start a durable background plan council and return immediately. Read the result and dossier with delegation_read, verify material claims, then complete with exact jobId/resultVersion, assessment and per-finding decisions. Exhaustion permits unchanged bound completion. Changed plan: action=revalidate with original council jobId/resultVersion, reason and optional amended planBody launches one independent verify worker per exact planning/source snapshot without another council/reset. Read its fresh result/dossier, then complete that verification job with main decisions. Stale/failed verification never unlocks the gate. End the turn when only background work remains; no polling."
          : "Run multi-perspective plan council (research + skeptic at standard; full council at heavy). Mandatory before flow_execute at standard/heavy depth.",
      inputSchema: jsonSchema({
        type: "object",
        properties:
          opts.executionRole === "orchestrator"
            ? {
                action: {
                  type: "string",
                  enum: ["start", "revalidate", "complete"],
                  description:
                    "start=council; revalidate=one fresh independent verify worker for changed inputs, including at exhausted council allowance; complete=main evidence decisions after reading the exact result and dossier.",
                },
                jobId: { type: "string" },
                resultVersion: { type: "string" },
                reason: {
                  type: "string",
                  description:
                    "For revalidate: concrete finding amendment/verification reason. jobId/resultVersion identify the original owned council.",
                },
                planBody: {
                  type: "string",
                  description:
                    "For revalidate only: optional complete amended plan, bound to the single independent verification attempt. Does not reset council allowance.",
                },
                assessment: {
                  type: "string",
                  description:
                    "Main's independent evidence assessment and limits; reviewer verdict alone is not proof.",
                },
                decisions: {
                  type: "array",
                  description:
                    "Required for dossier reviews: one decision for each current/prior open finding. accept=confirmed and still open; reject=unsupported with counter-evidence; resolved=closure verified; defer=unknown. Only open blocking findings gate execution.",
                  items: {
                    type: "object",
                    properties: {
                      findingId: { type: "string" },
                      decision: { type: "string", enum: ["accept", "reject", "resolved", "defer"] },
                      rationale: { type: "string", minLength: 1 },
                      evidence: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
                    },
                    required: ["findingId", "decision", "rationale", "evidence"],
                    additionalProperties: false,
                  },
                },
              }
            : {},
        additionalProperties: false,
      }),
      execute: async (input: any, context) => {
        const abortSignal = context?.abortSignal;
        abortSignal?.throwIfAborted();
        let completed: CompletedPlanReview | undefined;
        if (opts.executionRole === "orchestrator") {
          if (!opts.startPlanReview || !opts.readPlanReview)
            return json({
              ok: false,
              code: "background_review_unavailable",
              message:
                "Native background review callbacks are unavailable. No inline council or gate override was attempted.",
            });
          if (input.action === "revalidate") {
            if (!input.jobId || !input.resultVersion || !input.reason?.trim())
              return json({
                ok: false,
                code: "plan_revalidation_refused",
                message: "Revalidation requires the exact owned source council and a concrete reason.",
              });
            try {
              const receipt = await opts.startPlanReview(
                {
                  depth,
                  revisionCycle: reviewBudget.used,
                  revalidation: {
                    jobId: input.jobId,
                    resultVersion: input.resultVersion,
                    reason: input.reason,
                    planBody: input.planBody,
                  },
                },
                abortSignal,
              );
              if (receipt.success) reviewBudget.stopRequested = true;
              return json({
                ok: receipt.success,
                pending: receipt.success,
                receipt,
                reviewBudget: planReviewBudgetStatus(reviewBudget),
                nextAction: receipt.success ? "await_background_result" : "report_dispatch_failure",
                message:
                  "One independent current-plan verification, not another council. No gate verdict or allowance reset. Read its result and dossier, then complete with main's per-finding decisions.",
              });
            } catch (err) {
              console.error(`[flow] plan revalidation refused: ${(err as Error).message}`);
              return json({ ok: false, code: "plan_revalidation_refused", message: (err as Error).message });
            }
          }
          if (input.action === "complete") {
            if (!input.jobId || !input.resultVersion || !input.assessment?.trim())
              return json({
                ok: false,
                code: "plan_review_refused",
                message: "Completion requires jobId, resultVersion and main's non-empty evidence assessment.",
              });
            try {
              completed = await opts.readPlanReview({ jobId: input.jobId, resultVersion: input.resultVersion });
              await completed.assertCurrent();
              if (completed.requiresAdjudication)
                MainReviewAssessmentSchema.parse({
                  assessment: input.assessment,
                  decisions: input.decisions,
                  jobId: input.jobId,
                  resultVersion: input.resultVersion,
                });
            } catch (err) {
              console.error(`[flow] plan review completion refused: ${(err as Error).message}`);
              return json({ ok: false, code: "plan_review_refused", message: (err as Error).message });
            }
          } else if (input.action && input.action !== "start") {
            return json({ ok: false, code: "invalid_review_action" });
          }
        }
        if (!completed && depth === "quick")
          return json({
            ok: true,
            skipped: true,
            message:
              "No plan council is required for this quick request. Existing bound reviews may still be completed with their exact result version.",
          });
        if (!completed && reviewBudget.used >= reviewBudget.max) return exhaustedReview();
        // A loop already shown to be non-converging (e.g. carried over from an
        // earlier request whose allowance was reset) must not buy another council.
        if (!completed) {
          const outcome = convergenceOutcome(false);
          if (outcome?.kind === "settled") return settledResponse(outcome.record);
          if (outcome?.kind === "stop") {
            reviewBudget.stopRequested = true;
            return json({
              ok: false,
              blocked: true,
              code: "plan_review_not_converging",
              nonConvergence: { reason: outcome.reason, detail: outcome.detail, policy: "stop" },
              reviewBudget: planReviewBudgetStatus(reviewBudget),
              review: buildFlowStatusPayload(cwd, depth).review,
              nextAction: "stop_and_report",
              message:
                "Plan review is not converging and the configured policy is `stop`: no further council is bought. Report the unresolved objections to the user.",
            });
          }
        }
        // Reserve synchronously before any await. A failed/cancelled review can
        // already have spent provider calls and does not refund this allowance.
        const revisionCycle = completed?.binding.revisionCycle ?? reviewBudget.used++;
        const reviewDepth = completed?.binding.depth ?? depth;
        if (!completed && reviewBudget.used >= reviewBudget.max) reviewBudget.stopRequested = true;
        if (opts.executionRole === "orchestrator" && !completed) {
          const receipt = await opts.startPlanReview!({ depth, revisionCycle }, abortSignal);
          return json({
            ok: receipt.success,
            pending: receipt.success,
            receipt,
            reviewBudget: planReviewBudgetStatus(reviewBudget),
            nextAction: receipt.success ? "await_background_result" : "report_dispatch_failure",
            message:
              "No Flow verdict was applied. Read the completed review, verify its claims/evidence, then explicitly complete this exact result. Do not repeat dispatch to poll.",
          });
        }
        const host = getFlowLoopHost();
        const ctx = loopHostContext(cwd, sessionModelId, reviewDepth, {
          sessionId,
          abortSignal,
          revisionCycle,
          runPerspectiveFn: runTask
            ? taskToRunPerspectiveFn((request) => runTask(request, abortSignal), sessionModelId)
            : undefined,
          runDebate: completed
            ? async () => completed.synthesis
            : opts.runDebate
              ? (topic, contract) => opts.runDebate!(topic, abortSignal, contract)
              : undefined,
          beforeReviewPersist: completed?.assertCurrent,
          mainReviewAssessment: completed?.requiresAdjudication
            ? MainReviewAssessmentSchema.parse({
                assessment: input.assessment,
                decisions: input.decisions,
                jobId: input.jobId,
                resultVersion: input.resultVersion,
                revalidation: completed.revalidation,
              })
            : undefined,
        });
        const councilResult = await host.firePoint("plan:post", ctx);
        if (councilResult.overlayError)
          return json({ ok: false, code: "plan_review_failed", message: councilResult.overlayError });
        const reviewResult = await host.firePoint("plan-review:post", ctx);
        const settled = readState(cwd).planVerified ? null : convergenceOutcome(reviewBudget.used >= reviewBudget.max);
        const state = readState(cwd);
        if (state.planVerified) reviewBudget.stopRequested = false;
        const status = buildFlowStatusPayload(cwd, reviewDepth);
        return json({
          ...(completed
            ? {
                completedJobId: input.jobId,
                resultVersion: input.resultVersion,
                mainAssessment: input.assessment.trim(),
              }
            : {}),
          planReview: reviewResult,
          review: status.review,
          gates: status.gates,
          planVerified: state.planVerified,
          phase: state.phase,
          reviewBudget: planReviewBudgetStatus(reviewBudget),
          ...(settled?.kind === "settled"
            ? { settlement: settled.record, nextAction: "execute_with_open_items", message: settled.record.message }
            : settled?.kind === "stop"
              ? { nonConvergence: { reason: settled.reason, detail: settled.detail, policy: "stop" } }
              : {}),
          ...(!state.planVerified && reviewBudget.used >= reviewBudget.max ? { nextAction: "stop_and_report" } : {}),
        });
      },
    });
  }

  tools.flow_execute = dynamicTool({
    description:
      "Advance to execute phase after plan-verify pass. Does not run code itself — unlocks implement step in workflow state.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        force: { type: "boolean", description: "Bypass plan-verify gate (yolo/debug only)" },
      },
    }),
    execute: async (input: any) => {
      const gate = canExecute(cwd, depth);
      if (!gate.allowed && !input.force) {
        return json({ blocked: true, reason: gate.reason });
      }
      const host = getFlowLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth);
      await host.onExecuteStart(ctx);
      advancePhase(cwd, "execute");
      return json({ blocked: false, phase: "execute" });
    },
  });

  tools.flow_verify = dynamicTool({
    description: "Mark verify phase complete after tests/self-verify. Requires evidence when passed=true.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        passed: { type: "boolean", description: "true when tests/self-verify passed" },
        evidence: { type: "string", description: "Test/lint evidence summary (required when passed=true)" },
      },
      required: ["passed"],
      additionalProperties: false,
    }),
    execute: async (input: any, context) => {
      const abortSignal = context?.abortSignal;
      abortSignal?.throwIfAborted();
      const passed = input.passed === true;
      if (passed && !input.evidence?.trim()) {
        return json({
          ok: false,
          error: "flow_verify requires non-empty evidence when passed=true",
        });
      }

      // Layer 2: council adjudication ONLY when the deterministic floor passed at non-quick
      // depth. The council verdict OVERRIDES the model's self-reported `passed` — "tests green
      // but doesn't meet the goal" is caught here. A `passed=false` floor never reaches the
      // council (cheap: no LLM spend on an already-known failure).
      let effectivePassed = passed;
      let councilConcerns: string[] = [];
      if (passed && depth !== "quick") {
        try {
          const diff = readImplementationDiff(cwd);
          const council = await runVerifyCouncil({
            cwd,
            sessionModelId,
            depth,
            evidence: input.evidence?.trim(),
            diff,
            abortSignal,
            runPerspectiveFn: runTask
              ? verifyRunPerspectiveFn((request) => runTask(request, abortSignal), sessionModelId)
              : undefined,
            runDebate: opts.runDebate ? (topic, contract) => opts.runDebate!(topic, abortSignal, contract) : undefined,
          });
          if (!council.skipped && council.verdict !== "pass") {
            effectivePassed = false;
            councilConcerns = council.concerns;
          }
        } catch (err) {
          // Fail OPEN — a council wiring failure must not block a genuinely-passing verify;
          // honor the deterministic floor's verdict. Log per No-Silent-Catch.
          console.error(`[flow] verify-council wiring failed, honoring deterministic floor: ${(err as Error).message}`);
          abortSignal?.throwIfAborted();
        }
      }

      abortSignal?.throwIfAborted();
      const verdictLine = effectivePassed ? "verdict: pass" : "verdict: fail";
      const concernBlock = councilConcerns.length
        ? `\n\n## Council concerns\n${councilConcerns.map((c) => `- ${c}`).join("\n")}`
        : "";
      if (input.evidence?.trim() || councilConcerns.length) {
        writeFileSync(
          planningArtifact(cwd, "VERIFY.md"),
          `${verdictLine}\n\n${input.evidence?.trim() ?? ""}${concernBlock}\n`,
          "utf8",
        );
      }

      const host = getFlowLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth, {
        sessionId,
        verifyPassed: effectivePassed,
        abortSignal,
        verifyEvidence: {
          evidence: input.evidence?.trim(),
          evidenceChars: input.evidence?.length ?? 0,
          passed: effectivePassed,
        },
      });
      const verifyResult = await host.onVerifyComplete(ctx);
      return json({
        ok: true,
        phase: effectivePassed ? "review" : "debug",
        passed: effectivePassed,
        councilConcerns,
        loop: verifyResult,
      });
    },
  });

  tools.flow_ship = dynamicTool({
    description:
      "Polish delivery after flow_verify pass — writes .planning/SHIP.md. Call when task is ready to hand off.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: { type: "string" },
          description: "Optional delivery notes (agent-supplied, unverified)",
        },
        commitMessage: {
          type: "string",
          description: "Suggested commit message (stored in SHIP.md only, no git)",
        },
      },
      additionalProperties: false,
    }),
    execute: async (input: any) => {
      const gate = canShip(cwd, depth);
      if (!gate.allowed) {
        return json({ blocked: true, reason: gate.reason });
      }
      const host = getFlowLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth, {
        sessionId,
        shipNotes: input.notes,
        commitMessage: input.commitMessage,
      });
      const shipResult = await host.onShipComplete(ctx);
      advancePhase(cwd, "review");
      return json({
        ok: true,
        phase: "review",
        shipMdPath: planningArtifact(cwd, "SHIP.md"),
        loop: shipResult,
      });
    },
  });

  return tools;
}
