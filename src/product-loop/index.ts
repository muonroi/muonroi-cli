import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { CouncilLLM, QuestionResponder, PreflightResponder } from "../council/types.js";
import type { StreamChunk, VerifyRecipe } from "../types/index.js";
import { createRun, loadRun } from "../flow/run-manager.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import {
  writeManifest,
  readManifest,
  readIterations,
  markIterationCrashed,
} from "./artifact-io.js";
import { runLoopDriver, type DriverContext, type DriverResult } from "./loop-driver.js";
import { runSprint } from "./sprint-runner.js";
import { previewRunCost, formatCostPreview } from "./cost-preview.js";
import { polishDelivery } from "./ship-polish.js";
import type { ProductSpec, IterationState, RoleSlot } from "./types.js";
import { fireAndForgetPhaseOutcome } from "../ee/phase-outcome.js";
import { buildContinueFeedback, type ContinueFeedback } from "./feedback-routing.js";
import { resolveRoles } from "./role-registry.js";
import { getModelsForProvider } from "../models/registry.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import type { ProviderId } from "../providers/types.js";
import type { ModelInfo } from "../types/index.js";
import { routeModel as eeRouteModel } from "../ee/bridge.js";
import type { EERouteResult } from "../ee/bridge.js";

export interface ProductLoopFlags {
  maxCost: number;
  maxSprints: number;
  doneThreshold: number;
  stack?: string;
}

export interface ProductLoopOptions {
  /** Required for `start` — the user's idea. Ignored for other subcommands. */
  idea?: string;
  /** Required for resume/abort/ship/status<runId>. */
  runId?: string;
  /** Subcommand selector. Default = start. */
  subcommand?: "start" | "status" | "resume" | "abort" | "ship";

  flowDir: string;
  /** Session model id from the orchestrator (this.modelId). Used to resolve real council models. */
  sessionModelId: string;
  llm: CouncilLLM;
  flags: ProductLoopFlags;
  respondToQuestion: QuestionResponder;
  respondToPreflight: PreflightResponder;

  /** Optional bridges; sprint-runner uses them when present. */
  cwd?: string;
  processMessageFn?: (message: string) => AsyncGenerator<StreamChunk, void, unknown>;
  detectVerifyRecipe?: () => Promise<VerifyRecipe | null>;
  /** Test hook: pre-resolved role assignments so the harness can pin model ids. */
  roleAssignments?: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
}

export interface ProductLoopResult extends DriverResult {
  /** Number of sprints actually executed (≥ 0). */
  sprintsRun?: number;
  /** Whether the run reached the shipped state (Cond #5 passed). */
  shipped?: boolean;
}

/**
 * Entry point for the Product Ideal Loop.
 *
 * Subcommands:
 *  - start (default): create run → drive FSM → run sprints → done | halted
 *  - status:  list runs (or detail one when runId provided)
 *  - resume:  re-enter the FSM from state.md, marking any in-flight sprint as crashed
 *  - abort:   write manifest aborted=true and post EE phase-outcome=aborted
 *  - ship:    skip Cond #1-#4 if already passing; force final user gate (Cond #5)
 */
export async function* runProductLoop(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const sub = opts.subcommand ?? "start";

  switch (sub) {
    case "status":
      return yield* runStatus(opts);
    case "resume":
      return yield* runResume(opts);
    case "abort":
      return yield* runAbort(opts);
    case "ship":
      return yield* runShip(opts);
    case "start":
    default:
      return yield* runStart(opts);
  }
}

/** start: createRun → loop-driver (gather/research/scoping) → sprint loop → done|halted. */
async function* runStart(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { idea, flowDir, llm, flags, respondToQuestion, respondToPreflight } = opts;
  if (!idea || !idea.trim()) {
    yield { type: "content", content: "error: /ideal start requires an idea" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_idea" };
  }

  const runState = await createRun(flowDir);
  const runId = runState.id;

  await writeManifest(flowDir, runId, {
    idea,
    capUsd: flags.maxCost,
    maxSprints: flags.maxSprints,
    doneThreshold: flags.doneThreshold,
    stack: flags.stack,
    createdAt: new Date(),
  });

  // Surface a cost-vs-cap preview before the loop kicks off so $50 isn't
  // an arbitrary number — show predicted spend per sprint × max-sprints
  // against the configured cap, with a recommended max-sprints if it
  // would exceed. Falls back gracefully for unknown-pricing models.
  const preview = previewRunCost({
    sessionModelId: opts.sessionModelId,
    maxSprints: flags.maxSprints,
    capUsd: flags.maxCost,
  });
  yield { type: "content", content: `\n${formatCostPreview(preview)}\n` } as StreamChunk;

  const ctx: DriverContext = {
    runId,
    flowDir,
    idea,
    sessionModelId: opts.sessionModelId,
    llm,
    flags,
    respondToQuestion,
    respondToPreflight,
    cwd: opts.cwd,
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
  };

  // Phase 1: outer FSM (gather → research → scoping → approved | halted).
  const driverGen = runLoopDriver(ctx);
  let driverResult: DriverResult | undefined;
  try {
    while (true) {
      const { value, done } = await driverGen.next();
      if (done) {
        driverResult = value as DriverResult;
        break;
      }
      yield value as StreamChunk;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: true, content: msg } as any;
    return { runId, stage: "error", success: false, reason: msg };
  }

  if (!driverResult?.success || driverResult.stage !== "approved") {
    return { ...driverResult!, runId };
  }

  // Phase 2: sprint loop until done or halted.
  const productSpec = await loadProductSpec(flowDir, runId, idea, opts.flags.stack);
  const roleAssignments =
    opts.roleAssignments ?? (await resolveRoleAssignments(opts.sessionModelId));
  return yield* drainSprints({
    ctx,
    productSpec,
    roleAssignments,
    history: [],
    flags,
  });
}

/** Drive sprint-runner repeatedly, honoring max-sprints and continue-feedback routing. */
async function* drainSprints(args: {
  ctx: DriverContext;
  productSpec: ProductSpec;
  roleAssignments: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
  history: IterationState[];
  flags: ProductLoopFlags;
}): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const { ctx, productSpec, roleAssignments, flags } = args;
  const history = args.history.slice();
  let carryOver: ContinueFeedback | undefined;
  let sprintsRun = 0;

  for (let sprintN = history.length + 1; sprintN <= flags.maxSprints; sprintN++) {
    let iter: IterationState;
    try {
      const sprintGen = runSprint({
        sprintN,
        ctx,
        productSpec,
        roleAssignments,
        history,
        carryOver,
      });
      let result: IterationState | undefined;
      while (true) {
        const step = await sprintGen.next();
        if (step.done) {
          result = step.value as IterationState;
          break;
        }
        yield step.value as StreamChunk;
      }
      iter = result!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "content", content: `\n> Sprint ${sprintN} halted: ${msg}\n` } as StreamChunk;
      // Mark manifest as halted (not aborted) so resume can pick up.
      const manifest = await readManifest(ctx.flowDir, ctx.runId);
      if (manifest) {
        await writeManifest(ctx.flowDir, ctx.runId, {
          ...manifest,
          verdict: { pass: false, score: 0, reason: msg, failedCondition: undefined as any },
        });
      }
      return {
        runId: ctx.runId,
        stage: "halted",
        success: false,
        reason: msg,
        sprintsRun,
      };
    }

    history.push(iter);
    sprintsRun++;

    if (iter.stage === "shipped") {
      // Final manifest update + EE pass outcome
      const manifest = await readManifest(ctx.flowDir, ctx.runId);
      if (manifest) {
        await writeManifest(ctx.flowDir, ctx.runId, {
          ...manifest,
          doneAt: new Date(),
          verdict: { pass: true, score: iter.scoreAfter, failedCondition: undefined as any, reason: "all_conditions_met" },
        });
      }
      // Ship-time delivery polish: scaffold README, fill package.json
      // metadata, write delivery-notes. Idempotent + non-destructive.
      if (ctx.cwd) {
        try {
          const polish = await polishDelivery({
            cwd: ctx.cwd,
            runDir: path.join(ctx.flowDir, "runs", ctx.runId),
            productSpec,
            runId: ctx.runId,
          });
          if (polish.notes.length > 0) {
            yield {
              type: "content",
              content: `\n**Delivery polish:**\n${polish.notes.map((n) => `- ${n}`).join("\n")}\n`,
            } as StreamChunk;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          yield { type: "content", content: `\n_Delivery polish skipped: ${msg}_\n` } as StreamChunk;
        }
      }
      return {
        runId: ctx.runId,
        stage: "approved",
        success: true,
        reason: "shipped",
        sprintsRun,
        shipped: true,
      };
    }

    // Build continue-feedback for next iteration. The DoneVerdict is not
    // surfaced from sprint-runner directly, but the iteration state encodes
    // enough — derive a synthetic verdict from criteria counts.
    carryOver = {
      focus: iter.lastVerifyResult === "PASS"
        ? `improve criteria coverage: met=${iter.criteriaMet}, partial=${iter.criteriaPartial}, unmet=${iter.criteriaUnmet}`
        : `fix verify failures (last result: ${iter.lastVerifyResult})`,
    };
  }

  yield { type: "content", content: `\n> Reached max-sprints (${flags.maxSprints}) without satisfying Definition-of-Done.\n` } as StreamChunk;
  return {
    runId: ctx.runId,
    stage: "halted",
    success: false,
    reason: "max_sprints_reached",
    sprintsRun,
  };
}

async function loadProductSpec(
  flowDir: string,
  runId: string,
  idea: string,
  stack?: string,
): Promise<ProductSpec> {
  const runDir = path.join(flowDir, "runs", runId);
  const roadmap = await readArtifact(runDir, "roadmap.md");
  const raw = roadmap?.sections.get("Product Specification") ?? "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Partial<ProductSpec>;
      return {
        idea: parsed.idea ?? idea,
        persona: parsed.persona ?? "users",
        mvp: parsed.mvp ?? [],
        phase2: parsed.phase2 ?? [],
        architecture: parsed.architecture ?? "",
        ioContract: parsed.ioContract ?? "",
        folderStructure: parsed.folderStructure ?? "",
        sprintEstimate: parsed.sprintEstimate ?? 1,
        costEstimate: parsed.costEstimate ?? 1,
        stack: parsed.stack ?? stack,
        createdAt: parsed.createdAt ? new Date(parsed.createdAt) : new Date(),
      };
    } catch {
      /* fall through */
    }
  }
  return {
    idea,
    persona: "users",
    mvp: [],
    phase2: [],
    architecture: "",
    ioContract: "",
    folderStructure: "",
    sprintEstimate: 1,
    costEstimate: 1,
    stack,
    createdAt: new Date(),
  };
}

// ── Subcommands: status / resume / abort / ship ─────────────────────────────

async function* runStatus(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  const runsRoot = path.join(opts.flowDir, "runs");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsRoot);
  } catch {
    yield { type: "content", content: "No runs found.\n" } as StreamChunk;
    return { runId: "", stage: "approved", success: true };
  }

  if (opts.runId) {
    const m = await readManifest(opts.flowDir, opts.runId);
    if (!m) {
      yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
      return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
    }
    const iters = await readIterations(opts.flowDir, opts.runId);
    yield {
      type: "content",
      content:
        `Run ${opts.runId}: ${m.idea}\n` +
        `Cap: $${m.capUsd}  MaxSprints: ${m.maxSprints}  DoneThreshold: ${m.doneThreshold}\n` +
        `Iterations: ${iters.length}  Aborted: ${m.aborted ?? false}  DoneAt: ${m.doneAt?.toISOString() ?? "—"}\n`,
    } as StreamChunk;
    return { runId: opts.runId, stage: "approved", success: true };
  }

  const lines: string[] = [`Active runs (${entries.length}):`];
  for (const id of entries) {
    const m = await readManifest(opts.flowDir, id).catch(() => null);
    const iters = await readIterations(opts.flowDir, id).catch(() => []);
    if (!m) continue;
    lines.push(
      `  ${id}  ${m.idea.slice(0, 60)}  sprints=${iters.length}  aborted=${m.aborted ?? false}`,
    );
  }
  yield { type: "content", content: `${lines.join("\n")}\n` } as StreamChunk;
  return { runId: "", stage: "approved", success: true };
}

async function* runAbort(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  if (!opts.runId) {
    yield { type: "content", content: "error: abort requires a runId\n" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_runId" };
  }
  const m = await readManifest(opts.flowDir, opts.runId);
  if (!m) {
    yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
  }
  await writeManifest(opts.flowDir, opts.runId, { ...m, aborted: true, doneAt: new Date() });
  // Fire-and-forget EE phase-outcome=aborted (extension landed in 13-05).
  try {
    fireAndForgetPhaseOutcome({
      sessionId: opts.runId,
      phaseName: "product-loop",
      outcome: "aborted" as any,
    });
  } catch { /* non-fatal */ }
  yield { type: "content", content: `Aborted run ${opts.runId}.\n` } as StreamChunk;
  return { runId: opts.runId, stage: "halted", success: false, reason: "aborted" };
}

async function* runResume(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  if (!opts.runId) {
    yield { type: "content", content: "error: resume requires a runId\n" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_runId" };
  }
  const run = await loadRun(opts.flowDir, opts.runId);
  if (!run) {
    yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
  }
  const manifest = await readManifest(opts.flowDir, opts.runId);
  if (!manifest) {
    yield { type: "content", content: `Manifest missing for ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "manifest_missing" };
  }
  if (manifest.aborted) {
    yield { type: "content", content: `Run ${opts.runId} was aborted; cannot resume.\n` } as StreamChunk;
    return { runId: opts.runId, stage: "halted", success: false, reason: "aborted" };
  }

  // Detect crashed in-flight sprint: an iterations.md entry without a closing
  // Verify line is treated as crashed. Our schema always writes the Verify line
  // before returning, so an iteration is "in-flight" iff the file has a Sprint
  // heading but no matching Verify field. readIterations skips malformed
  // entries — so we mark the highest sprint number as crashed regardless.
  const iters = await readIterations(opts.flowDir, opts.runId);
  let nextSprint = iters.length + 1;
  if (iters.length > 0) {
    const last = iters[iters.length - 1]!;
    if (!last.lastVerifyResult || last.lastVerifyResult === "UNKNOWN") {
      await markIterationCrashed(opts.flowDir, opts.runId, last.sprintN);
      nextSprint = last.sprintN; // retry with retryOf metadata
      yield {
        type: "content",
        content: `Detected crashed sprint ${last.sprintN}; restarting fresh.\n`,
      } as StreamChunk;
    }
  }

  // Fire EE phase-outcome=resumed (extension landed in 13-05).
  try {
    fireAndForgetPhaseOutcome({
      sessionId: opts.runId,
      phaseName: `sprint-${Math.max(1, nextSprint - 1)}`,
      outcome: "resumed" as any,
    });
  } catch { /* non-fatal */ }

  // Resume into sprint loop with reconstructed history + manifest flags.
  const productSpec = await loadProductSpec(opts.flowDir, opts.runId, manifest.idea, manifest.stack);
  const ctx: DriverContext = {
    runId: opts.runId,
    flowDir: opts.flowDir,
    idea: manifest.idea,
    sessionModelId: opts.sessionModelId,
    llm: opts.llm,
    flags: opts.flags,
    respondToQuestion: opts.respondToQuestion,
    respondToPreflight: opts.respondToPreflight,
    cwd: opts.cwd,
    processMessageFn: opts.processMessageFn,
    detectVerifyRecipe: opts.detectVerifyRecipe,
  };
  const roleAssignments =
    opts.roleAssignments ?? (await resolveRoleAssignments(opts.sessionModelId));
  return yield* drainSprints({
    ctx,
    productSpec,
    roleAssignments,
    history: iters.filter((i) => !i.crashed),
    flags: opts.flags,
  });
}

/**
 * Build the inventory of models reachable in this session (= every provider
 * that has a key on the keychain) and let role-registry assign one model per
 * RoleSlot. The resulting Map is consumed by sprint-runner → done-gate Cond #4
 * (PO ↔ Customer cross-model debate). Without this, the Map is empty and the
 * gate immediately returns "missing_roles".
 *
 * On refusal (no keys, single-provider with too few models, or PO/Customer
 * collision) we return an empty Map; done-gate's R5 short-circuit (skip Cond
 * #4 when score < 0.85) keeps early sprints unblocked, and the user-approval
 * gate (Cond #5) still runs so the loop can ship via /ship.
 */
async function resolveRoleAssignments(
  sessionModelId: string,
): Promise<Map<RoleSlot, { modelId: string; provider: string; tier?: string }>> {
  const out = new Map<RoleSlot, { modelId: string; provider: string; tier?: string }>();
  const order: ProviderId[] = ["anthropic", "openai", "google", "deepseek", "siliconflow", "ollama"];
  const inventory: ModelInfo[] = [];
  for (const p of order) {
    try {
      await loadKeyForProvider(p);
    } catch {
      continue;
    }
    inventory.push(...getModelsForProvider(p));
  }
  if (inventory.length === 0) return out;

  // EE-driven override: ask the experience brain for the best (model,tier)
  // per role, given accumulated past-performance signals. routeModel returns
  // null when no EE core is installed, in which case role-registry falls
  // back to its tier-preference cold-start logic.
  const eeRouteOverride = async (slot: RoleSlot): Promise<EERouteResult | null> => {
    const task = describeRoleTask(slot);
    try {
      return await eeRouteModel(
        task,
        { role: slot, sessionModel: sessionModelId, source: "product-loop" },
        "muonroi-cli",
      );
    } catch {
      return null;
    }
  };

  const result = await resolveRoles({ inventory, eeRouteOverride });
  if (result.kind !== "ok") return out;
  for (const [slot, a] of Object.entries(result.roles)) {
    out.set(slot as RoleSlot, { modelId: a.model, provider: a.provider, tier: a.tier });
  }
  return out;
}

/**
 * Slot → human-readable task description fed to EE's routeModel. The brain
 * uses this string as the primary classification key, so phrasing matters:
 * keep it specific to the role's actual deliverable.
 */
function describeRoleTask(slot: RoleSlot): string {
  switch (slot) {
    case "PO":
      return "product owner: clarify product spec and acceptance criteria";
    case "Architect":
      return "software architect: design module boundaries and data flow";
    case "Implementer":
      return "implementer: write production code from a spec";
    case "Tester":
      return "tester: design and write unit/integration tests";
    case "Reviewer":
      return "code reviewer: critique code for bugs, perf, and clarity";
    case "Customer":
      return "customer proxy: validate that built feature meets user need";
    default:
      return `role ${String(slot)}`;
  }
}

async function* runShip(
  opts: ProductLoopOptions,
): AsyncGenerator<StreamChunk, ProductLoopResult, unknown> {
  if (!opts.runId) {
    yield { type: "content", content: "error: ship requires a runId\n" } as StreamChunk;
    return { runId: "", stage: "error", success: false, reason: "missing_runId" };
  }
  const m = await readManifest(opts.flowDir, opts.runId);
  if (!m) {
    yield { type: "content", content: `Run not found: ${opts.runId}\n` } as StreamChunk;
    return { runId: opts.runId, stage: "error", success: false, reason: "not_found" };
  }
  const iters = await readIterations(opts.flowDir, opts.runId);
  if (iters.length === 0) {
    yield { type: "content", content: `not ready to ship: no iterations recorded\n` } as StreamChunk;
    return { runId: opts.runId, stage: "halted", success: false, reason: "not_ready" };
  }
  const last = iters[iters.length - 1]!;
  if (last.lastVerifyResult !== "PASS") {
    yield {
      type: "content",
      content: `not ready to ship: last verify=${last.lastVerifyResult}\n`,
    } as StreamChunk;
    return { runId: opts.runId, stage: "halted", success: false, reason: "not_ready" };
  }

  // Force final user-approval gate (Cond #5). Reuse runPreflight via the
  // respondToPreflight responder: caller handles approve/reject prompt.
  const approved = await opts.respondToPreflight("ship-final");
  if (!approved) {
    yield { type: "content", content: `Ship rejected by user.\n` } as StreamChunk;
    // Build feedback so caller can pipe back into a continue cycle.
    buildContinueFeedback({ pass: false, failedCondition: "user_approval", score: last.scoreAfter, reason: "user_rejected" }, null, []);
    return { runId: opts.runId, stage: "halted", success: false, reason: "user_rejected" };
  }
  await writeManifest(opts.flowDir, opts.runId, {
    ...m,
    doneAt: new Date(),
    verdict: { pass: true, score: last.scoreAfter, failedCondition: undefined as any, reason: "force_shipped" },
  });
  yield { type: "content", content: `Shipped run ${opts.runId}.\n` } as StreamChunk;
  return { runId: opts.runId, stage: "approved", success: true, reason: "shipped", shipped: true };
}
