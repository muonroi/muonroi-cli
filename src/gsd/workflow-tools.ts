import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { TaskRequest, ToolResult } from "../types/index.js";
import { ensurePlanningWorkspace } from "./config-bridge.js";
import { isGsdNativeEnabled } from "./flags.js";
import { getGsdLoopHost, loopHostContext, taskToRunPerspectiveFn } from "./loop-host.js";
import { planningArtifact } from "./paths.js";
import type { PlanPerspective } from "./plan-council-prompts.js";
import { runVerifyCouncil } from "./verify-council.js";
import type { VerifyPerspective } from "./verify-council-prompts.js";
import {
  advancePhase,
  buildGsdStatusPayload,
  canExecute,
  canShip,
  readState,
  setStateField,
} from "./workflow-engine.js";

export const GSD_WORKFLOW_TOOL_NAMES = [
  "gsd_status",
  "gsd_discuss",
  "gsd_plan",
  "gsd_plan_review",
  "gsd_execute",
  "gsd_verify",
  "gsd_ship",
] as const;

export interface GsdWorkflowToolOpts {
  cwd: string;
  sessionModelId: string;
  sessionId?: string;
  depth?: string;
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDebate?: (topic: string) => Promise<string>;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Adapts `taskToRunPerspectiveFn` (typed for plan-council `PlanPerspective`) to the verify
 * council's `VerifyPerspective` shape. Safe: `resolveGsdPerspectiveAgent` only special-cases
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
    console.error(`[gsd] verify-council diff capture failed: ${(err as Error).message}`);
    return "";
  }
}

export function shouldRegisterGsdTools(depth?: string): boolean {
  if (!isGsdNativeEnabled()) return false;
  if (depth === "quick") {
    return true;
  }
  return true;
}

export function registerGsdWorkflowTools(tools: ToolSet, opts: GsdWorkflowToolOpts): ToolSet {
  if (!isGsdNativeEnabled()) return tools;

  const depth = opts.depth ?? "standard";
  const { cwd, sessionModelId, sessionId, runTask } = opts;

  tools.gsd_status = dynamicTool({
    description:
      "Read native GSD workflow progress: STATE.md phase, depth, plan-verify status, and gsd-tools init.progress summary. Use to orient mid-task. Pure read — does not advance phase or write STATE.md.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => {
      // Pure read: bootstrap .planning/ only if absent (idempotent — no write when it exists).
      // Turn-start sync (message-processor) handles depth/STATE writes; gsd_status must NOT
      // mutate STATE.md mtime, or the dispatch cache (keyed on STATE mtime) would thrash.
      ensurePlanningWorkspace(cwd, sessionModelId);
      return json(buildGsdStatusPayload(cwd, depth));
    },
  });

  tools.gsd_discuss = dynamicTool({
    description: "Enter GSD discuss phase — surface ambiguities before planning. Sets STATE.md phase to discuss.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        notes: { type: "string", description: "Gray-area notes to append" },
      },
    }),
    execute: async (input: any) => {
      ensurePlanningWorkspace(cwd, sessionModelId);
      const host = getGsdLoopHost();
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

  tools.gsd_plan = dynamicTool({
    description:
      "Write PLAN.md for a multi-step task (leader-tier draft). Call before gsd_plan_review and gsd_execute.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        body: { type: "string", description: "Full PLAN.md markdown body" },
      },
      required: ["body"],
    }),
    execute: async (input: any) => {
      if (!input.body?.trim()) {
        return json({ ok: false, error: "gsd_plan requires non-empty body" });
      }
      ensurePlanningWorkspace(cwd, sessionModelId);
      writeFileSync(planningArtifact(cwd, "PLAN.md"), input.body.trim(), "utf8");
      setStateField(cwd, "Plan Verified", "no");
      advancePhase(cwd, "plan");
      const host = getGsdLoopHost();
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

  if (depth !== "quick") {
    tools.gsd_plan_review = dynamicTool({
      description:
        "Run multi-perspective plan council (research + skeptic at standard; full council at heavy). Mandatory before gsd_execute at standard/heavy depth.",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => {
        const host = getGsdLoopHost();
        const ctx = loopHostContext(cwd, sessionModelId, depth, {
          sessionId,
          runPerspectiveFn: runTask ? taskToRunPerspectiveFn(runTask, sessionModelId) : undefined,
          runDebate: opts.runDebate,
        });
        await host.firePoint("plan:post", ctx);
        const reviewResult = await host.firePoint("plan-review:post", ctx);
        const state = readState(cwd);
        return json({
          planReview: reviewResult,
          planVerified: state.planVerified,
          phase: state.phase,
        });
      },
    });
  }

  tools.gsd_execute = dynamicTool({
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
      const host = getGsdLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth);
      await host.onExecuteStart(ctx);
      advancePhase(cwd, "execute");
      return json({ blocked: false, phase: "execute" });
    },
  });

  tools.gsd_verify = dynamicTool({
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
    execute: async (input: any) => {
      const passed = input.passed === true;
      if (passed && !input.evidence?.trim()) {
        return json({
          ok: false,
          error: "gsd_verify requires non-empty evidence when passed=true",
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
            runPerspectiveFn: runTask ? verifyRunPerspectiveFn(runTask, sessionModelId) : undefined,
            runDebate: opts.runDebate,
          });
          if (!council.skipped && council.verdict !== "pass") {
            effectivePassed = false;
            councilConcerns = council.concerns;
          }
        } catch (err) {
          // Fail OPEN — a council wiring failure must not block a genuinely-passing verify;
          // honor the deterministic floor's verdict. Log per No-Silent-Catch.
          console.error(`[gsd] verify-council wiring failed, honoring deterministic floor: ${(err as Error).message}`);
        }
      }

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

      const host = getGsdLoopHost();
      const ctx = loopHostContext(cwd, sessionModelId, depth, {
        sessionId,
        verifyPassed: effectivePassed,
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

  tools.gsd_ship = dynamicTool({
    description:
      "Polish delivery after gsd_verify pass — writes .planning/SHIP.md. Call when task is ready to hand off.",
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
      const host = getGsdLoopHost();
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
