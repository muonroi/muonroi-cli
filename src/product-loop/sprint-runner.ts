/**
 * src/product-loop/sprint-runner.ts
 *
 * Inner sprint loop body: plan -> implement -> verify -> judge -> done-gate.
 *
 * Wires together (no behavioural changes to any of them):
 *   - council.runCouncil       (planner, skipClarification = true)
 *   - processMessageFn         (implementer, host orchestrator's tool loop)
 *   - verify.runVerifyOrchestration (engineering floor)
 *   - product-loop.done-gate   (5-condition Definition-of-Done)
 *   - product-loop.circuit-breakers (CB-1 cost / CB-2 oscillation / CB-3 verify-blank)
 *   - product-loop.feedback-routing (failed cond -> next sprint focus)
 *   - product-loop.cost-scoper (per-product reservation + commit)
 *   - product-loop.phase-tracker-bridge (EE phase-outcome on sprint boundary)
 *   - product-loop.role-memory (per-role 2KB rolling memory)
 *
 * Critical ordering:
 *   - CB-3 (verify-blank) is checked BEFORE the planner runs on sprint 1, since
 *     a missing recipe should fail-closed without spending council tokens.
 *   - CB-1 (cost) uses history BEFORE this sprint commits its cost — CB-1 is a
 *     projection check, not a retroactive one.
 *   - CB-2 (oscillation) is checked AFTER this sprint's score is known.
 */

import * as path from "node:path";
import { runCouncil } from "../council/index.js";
import type { CouncilLLM } from "../council/types.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { StreamChunk, ToolResult, VerifyRecipe } from "../types/index.js";
import { commitToProduct, release } from "../usage/ledger.js";
import { CapBreachError } from "../usage/types.js";
import type { SandboxSettings } from "../utils/settings.js";
import { runVerifyOrchestration, type VerifyAgentLike } from "../verify/orchestrator.js";
import { appendIteration, readCriteria } from "./artifact-io.js";
import { formatUnverifiedForSprintContext, readLedger } from "./assumption-ledger.js";
import { CB1_costProjection, CB2_oscillation, CB3_verifyBlank } from "./circuit-breakers.js";
import { reserveForProduct } from "./cost-scoper.js";
import { formatProjectContextForPrompt } from "./discovery-context-format.js";
import { readProjectContext } from "./discovery-persistence.js";
import { evaluateDoneGate } from "./done-gate.js";
import type { ContinueFeedback } from "./feedback-routing.js";
import { buildContinueFeedback } from "./feedback-routing.js";
import { postSprintBoundary } from "./phase-tracker-bridge.js";
import { appendRoleMemory } from "./role-memory.js";
import type { DriverContext, IterationState, ProductSpec, RoleSlot } from "./types.js";
import { recordVerifyFailureAndMaybePush } from "./verify-failure-tracking.js";
import { parseVerifyResult } from "./verify-result.js";

export {
  computeFailureSignature,
  loadVerifyFailureSignatures,
  pushFailureToEE,
  recordVerifyFailureAndMaybePush,
  saveVerifyFailureSignatures,
  type VerifyFailureRecord,
  type VerifyFailureSignatures,
} from "./verify-failure-tracking.js";

export interface RunSprintArgs {
  sprintN: number;
  ctx: DriverContext;
  productSpec: ProductSpec;
  roleAssignments: Map<RoleSlot, { modelId: string; provider: string; tier?: string }>;
  history: IterationState[];
  /**
   * Optional carry-over from previous sprint's failed done-gate condition.
   * Sprint-runner prepends it to the planner topic so the council plans for it.
   */
  carryOver?: ContinueFeedback;
  /**
   * Optional phase scope for subsystem E phase-orchestrator.
   * When present the done-gate evaluates only the subset of criteria whose ids
   * are listed in `criteria`; all other criteria are excluded from the gate
   * scoring. Prompts still receive the full criteria set for agent context.
   */
  phaseScope?: { criteria: string[]; scope: string };
}

/**
 * Run a single sprint. Yields StreamChunk events for the UI and returns the
 * resulting IterationState (already persisted to iterations.md before return).
 *
 * Throws on circuit-breaker halt — caller (loop driver) catches and writes
 * the appropriate halt state to manifest/state.
 */
export async function* runSprint(args: RunSprintArgs): AsyncGenerator<StreamChunk, IterationState, unknown> {
  const { sprintN, ctx, productSpec, roleAssignments, history, carryOver, phaseScope } = args;
  const runDir = path.join(ctx.flowDir, "runs", ctx.runId);
  const cwd = ctx.cwd ?? runDir;

  // ── Step 1: Cost projection (CB-1) BEFORE incurring sprint cost ───────────
  const spentUsd = history.reduce((s, h) => s + (h.actualCost ?? h.costUsd ?? 0), 0);
  const cb1History = history.map((h) => ({ actualCost: h.actualCost ?? h.costUsd ?? 0 }));
  const cb1 = CB1_costProjection(cb1History, ctx.flags.maxCost, spentUsd, productSpec.costEstimate);
  if (cb1.halt) {
    throw new Error(
      `Halted by circuit breaker: cost projection ${cb1.projection.toFixed(4)} exceeds headroom ${cb1.headroom.toFixed(4)}`,
    );
  }

  // ── Step 2: Detect verify recipe BEFORE the planner spends any token ──────
  // CB-3 fires deterministically on sprint 1 if recipe is null or coverage === 0.
  const verifyAgent = buildVerifyAgent(ctx, cwd);
  const verifyRecipe = await verifyAgent.detectVerifyRecipe(verifyAgent.getSandboxSettings());
  const cb3 = CB3_verifyBlank(sprintN, verifyRecipe);
  if (cb3.halt) {
    throw new Error(`Halted by circuit breaker: ${cb3.reason}`);
  }

  // ── Step 3: Plan stage (council, skipClarification=true) ──────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Planning\n` };

  const carryOverContext =
    history.length > 0
      ? `\nCarry-over from prior sprints:\n${history
          .map((h) => `- Sprint ${h.sprintN}: verify=${h.lastVerifyResult}, score=${h.scoreAfter.toFixed(2)}`)
          .join("\n")}\n`
      : "";

  const focusContext = carryOver?.focus ? `\nFOCUS for this sprint:\n${carryOver.focus}\n` : "";

  // P6: surface unverified assumptions so the sprint plan prioritizes
  // validation work over feature work when foundational claims remain
  // unchecked. Silent skip on ledger read failure (e.g. fresh greenfield
  // run before research has written the ledger).
  let assumptionContext = "";
  try {
    const ledger = await readLedger(ctx.flowDir, ctx.runId);
    const formatted = formatUnverifiedForSprintContext(ledger);
    if (formatted) assumptionContext = "\n" + formatted;
  } catch {
    /* non-critical */
  }

  const projectCtx = await readProjectContext(ctx.flowDir, ctx.runId);
  const projectContextStr = projectCtx ? "\nProject Context:\n" + formatProjectContextForPrompt(projectCtx) : "";

  const councilTopic =
    `Plan sprint ${sprintN} for product: ${productSpec.idea}\n\n` +
    `Persona: ${productSpec.persona}\n` +
    `MVP features: ${productSpec.mvp.join(", ")}\n` +
    `Architecture: ${productSpec.architecture}\n` +
    `IO contract: ${productSpec.ioContract}\n` +
    `Folder structure: ${productSpec.folderStructure}\n` +
    `${carryOverContext}${focusContext}${assumptionContext}${projectContextStr}\n` +
    `Goal: produce concrete edits and verifications that move the criteria toward "met".`;

  const productLlm = createProductLlm(ctx.llm, ctx.runId, ctx.flags.maxCost);
  const sessionModelId =
    roleAssignments.get("Architect")?.modelId ?? roleAssignments.get("PO")?.modelId ?? ctx.sessionModelId;

  const noopProcess: NonNullable<DriverContext["processMessageFn"]> = async function* () {
    /* no host orchestrator wired during planning */
  };

  const planGen = runCouncil(
    councilTopic,
    sessionModelId,
    [],
    ctx.runId,
    productLlm,
    ctx.respondToQuestion,
    ctx.respondToPreflight,
    ctx.processMessageFn ?? noopProcess,
    { skipClarification: true, cwd },
  );

  let planSynthesis = "";
  while (true) {
    const step = await planGen.next();
    if (step.done) {
      planSynthesis = step.value ?? "";
      break;
    }
    yield step.value as StreamChunk;
  }

  // ── Step 4: Implement stage — pipe plan through host process loop ─────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Implementation\n` };
  if (ctx.processMessageFn && planSynthesis.trim()) {
    const implGen = ctx.processMessageFn(planSynthesis);
    for await (const chunk of implGen) {
      yield chunk as StreamChunk;
    }
  } else {
    yield {
      type: "content",
      content: "\n> Implementation step skipped (no processMessageFn or empty plan).\n",
    };
  }

  // ── Step 5: Verify stage ──────────────────────────────────────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Verification\n` };
  const verifyResult: ToolResult = await runVerifyOrchestration(verifyAgent);
  const verifyVerdict = parseVerifyResult(verifyResult);
  const recipeFromVerify =
    (verifyResult as ToolResult & { verifyRecipe?: VerifyRecipe | null }).verifyRecipe ?? verifyRecipe;

  // P3.3: Track repeating failures; push to EE judge-worker when count hits 3.
  if (verifyVerdict === "FAIL" || verifyVerdict === "ERROR") {
    const errorMessage = verifyResult.error?.trim() ? verifyResult.error : (verifyResult.output ?? "");
    const verifyCommand = (recipeFromVerify as { command?: string } | null)?.command ?? "unknown";
    // fileTouched: sprint-runner has no fine-grained file context at this depth;
    // use "unknown" as a stable fallback so the signature still incorporates the
    // verify command and error message for deduplication.
    await recordVerifyFailureAndMaybePush({
      flowDir: ctx.flowDir,
      runId: ctx.runId,
      cwd,
      errorMessage,
      verifyCommand,
      fileTouched: "unknown",
    }).catch(() => {
      /* failure tracking must not derail the sprint */
    });
  }

  // ── Step 6: Read current criteria + judge stage ──────────────────────────
  yield { type: "content", content: `\n## Sprint ${sprintN} — Judgment\n` };
  const currentCriteria = await readCriteria(ctx.flowDir, ctx.runId);

  // When a phaseScope is provided (subsystem E), evaluate the done-gate only
  // against criteria belonging to this phase. Full criteria are kept for
  // counter fields so telemetry reflects the whole spec, but the gate itself
  // sees only the scoped subset.
  let evalCriteria = currentCriteria;
  if (phaseScope && phaseScope.criteria.length > 0) {
    const wanted = new Set(phaseScope.criteria.map((s) => s.trim()));
    const filtered = currentCriteria.filter((c) => wanted.has(c.id.trim()));
    // Permissive fallback: if phase.successCriteria text doesn't map to any Criterion.id
    // (gray-areas headings are slugs, not verbatim spec text), fall back to full set
    // rather than collapse to zero. Phase boundary tracking happens in phase-runner via
    // sprintResult.criteriaMet/totalCriteria, not here.
    evalCriteria = filtered.length > 0 ? filtered : currentCriteria;
  }

  const verdict = await evaluateDoneGate({
    lastVerify: verifyResult,
    recipe: recipeFromVerify,
    criteria: evalCriteria,
    history,
    roleAssignments,
    doneThreshold: ctx.flags.doneThreshold,
    llm: productLlm,
    respondToPreflight: ctx.respondToPreflight,
    // P6: pass run location so done-gate condition #6 can read the
    // assumption ledger and block ship when high-confidence assumptions
    // remain unverified.
    flowDir: ctx.flowDir,
    runId: ctx.runId,
  });

  // ── Step 7: CB-2 oscillation check (now we know this sprint's score) ─────
  const cb2History = history.map((h) => ({ score: h.score ?? h.scoreAfter ?? 0 })).concat([{ score: verdict.score }]);
  const cb2 = CB2_oscillation(cb2History, sprintN);
  if (cb2.halt) {
    throw new Error(
      `Halted by circuit breaker: oscillation detected (delta_t=${cb2.delta_t.toFixed(3)}, delta_t-1=${cb2.delta_t_minus_1.toFixed(3)})`,
    );
  }

  // ── Step 8: Persist iteration state, role memory, EE boundary ────────────
  const scoreBefore = history.length > 0 ? history[history.length - 1].scoreAfter : 0;

  const iter: IterationState = {
    sprintN,
    stage: verdict.pass ? "shipped" : "retrospective",
    scoreBefore,
    scoreAfter: verdict.score,
    criteriaMet: currentCriteria.filter((c) => c.status === "met").length,
    criteriaPartial: currentCriteria.filter((c) => c.status === "partial").length,
    criteriaUnmet: currentCriteria.filter((c) => c.status === "unmet").length,
    costUsd: 0, // Per-sprint cost is observed via the per-product ledger; field kept for compat.
    actualCost: 0,
    score: verdict.score,
    lastVerifyResult: verifyVerdict,
  };

  await appendIteration(ctx.flowDir, ctx.runId, iter);

  // Update Resume Digest in state.md so PIL Layer 5 + future resume can pick it up
  const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
  stateMap.sections.set(
    "Resume Digest",
    `Sprint: ${sprintN} | Stage: ${iter.stage} | Score: ${verdict.score.toFixed(2)} | Verify: ${verifyVerdict}`,
  );
  await writeArtifact(runDir, "state.md", stateMap);

  // Per-role rolling memory (2KB hard cap, oldest-first truncation handled by helper)
  for (const [slot] of roleAssignments.entries()) {
    await appendRoleMemory(
      ctx.flowDir,
      ctx.runId,
      slot,
      sprintN,
      `Sprint ${sprintN}: verify=${verifyVerdict}, score=${verdict.score.toFixed(2)}, pass=${verdict.pass}`,
    ).catch(() => {
      /* memory failure is non-fatal */
    });
  }

  // Fire EE phase-outcome on the sprint boundary (fire-and-forget)
  await postSprintBoundary({
    sessionId: ctx.runId,
    sprintN,
    outcome: verdict.pass ? "pass" : "fail",
    evidence: { score: verdict.score, verifyResult: verifyVerdict },
  }).catch(() => {
    /* EE failures must not derail the loop */
  });

  // ── Step 9: If not done, surface continue-feedback to the user ───────────
  if (!verdict.pass) {
    const fb = buildContinueFeedback(verdict, verifyResult, currentCriteria);
    yield {
      type: "content",
      content: `\n> Sprint ${sprintN} did not satisfy Definition-of-Done (${verdict.failedCondition ?? "unknown"}). Next focus: ${fb.focus}\n`,
    };
  } else {
    yield {
      type: "content",
      content: `\n> Sprint ${sprintN} passed Definition-of-Done (score ${(verdict.score * 100).toFixed(1)}%).\n`,
    };
  }

  return iter;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildVerifyAgent(ctx: DriverContext, cwd: string): VerifyAgentLike {
  let sandbox: SandboxSettings = {} as SandboxSettings;
  return {
    getCwd: () => cwd,
    getSandboxSettings: () => sandbox,
    setSandboxSettings: (s: SandboxSettings) => {
      sandbox = s;
    },
    detectVerifyRecipe: async () => {
      if (ctx.detectVerifyRecipe) return ctx.detectVerifyRecipe();
      return null; // Treat as fail-closed — CB-3 will halt on sprint 1.
    },
    runTaskRequest: async (req) => {
      // If a host process loop is wired, run the verify prompt through it. Otherwise
      // return a deterministic synthetic result so the loop can still complete in tests.
      if (!ctx.processMessageFn) {
        return { success: true, output: "" } as ToolResult;
      }
      const gen = ctx.processMessageFn(req.prompt);
      let output = "";
      for await (const chunk of gen) {
        if (chunk.type === "content" && typeof chunk.content === "string") {
          output += chunk.content;
        }
      }
      return { success: true, output } as ToolResult;
    },
  };
}

/**
 * Heuristic role tag from the system prompt. Cheap pattern match — lets the
 * cost report break out PO/Customer/moderator/leader spend without changing
 * the CouncilLLM signature. Unknown → undefined (entry still tagged callsite).
 */
function detectRoleFromSystem(system: string): string | undefined {
  const s = system.toLowerCase();
  if (s.startsWith("you are the product owner")) return "po";
  if (s.startsWith("you are the customer")) return "customer";
  if (s.startsWith("you are the debate moderator")) return "moderator";
  if (s.includes("leader") && s.includes("council")) return "leader";
  if (s.includes("judge")) return "judge";
  return undefined;
}

/**
 * Wraps a CouncilLLM with per-product reserve/commit semantics so every model
 * call is metered against BOTH the monthly and per-product ledgers (cost-scoper).
 */
function createProductLlm(base: CouncilLLM, runId: string, capUsd: number): CouncilLLM {
  return {
    async generate(modelId, system, prompt, maxTokens) {
      const provider = detectProviderForModel(modelId);
      const estIn = Math.ceil((system.length + prompt.length) / 4);
      const estOut = maxTokens ?? 2048;
      const tok = await reserveForProduct(
        { provider, model: modelId, estInputTokens: estIn, estOutputTokens: estOut },
        runId,
        capUsd,
      );
      if (tok instanceof CapBreachError) {
        throw new Error(`Cost cap breached: ${tok.message}`);
      }
      const startedAt = Date.now();
      // Capture real usage from the underlying council LLM via the onUsage
      // side-channel (added in Session 4). When the provider returns no usage
      // we fall back to chars/4 — preserves prior behavior.
      let captured: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      try {
        const text = await base.generate(modelId, system, prompt, maxTokens, (u) => {
          captured = u;
        });
        const actualIn = captured?.inputTokens && captured.inputTokens > 0 ? captured.inputTokens : estIn;
        const actualOut =
          captured?.outputTokens && captured.outputTokens > 0
            ? captured.outputTokens
            : Math.max(1, Math.ceil(text.length / 4));
        await commitToProduct(tok, runId, actualIn, actualOut, undefined, {
          callsite: "sprint.generate",
          role: detectRoleFromSystem(system),
          systemChars: system.length,
          promptChars: prompt.length,
          cachedInputTokens: captured?.cachedInputTokens,
          durationMs: Date.now() - startedAt,
        });
        return text;
      } catch (err) {
        await release(tok).catch(() => undefined);
        throw err;
      }
    },
    async research(modelId, topic, conversationContext, signal) {
      const provider = detectProviderForModel(modelId);
      const estIn = Math.ceil((topic.length + conversationContext.length) / 4);
      const estOut = 4096;
      const tok = await reserveForProduct(
        { provider, model: modelId, estInputTokens: estIn, estOutputTokens: estOut },
        runId,
        capUsd,
      );
      if (tok instanceof CapBreachError) {
        throw new Error(`Cost cap breached: ${tok.message}`);
      }
      const startedAt = Date.now();
      let captured: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      try {
        const text = await base.research(modelId, topic, conversationContext, signal, undefined, undefined, (u) => {
          captured = u;
        });
        const actualIn = captured?.inputTokens && captured.inputTokens > 0 ? captured.inputTokens : estIn;
        const actualOut =
          captured?.outputTokens && captured.outputTokens > 0
            ? captured.outputTokens
            : Math.max(1, Math.ceil(text.length / 4));
        await commitToProduct(tok, runId, actualIn, actualOut, undefined, {
          callsite: "sprint.research",
          role: "researcher",
          systemChars: topic.length,
          promptChars: conversationContext.length,
          cachedInputTokens: captured?.cachedInputTokens,
          durationMs: Date.now() - startedAt,
        });
        return text;
      } catch (err) {
        await release(tok).catch(() => undefined);
        throw err;
      }
    },
    // debate() delegates to base — cost metering will be added in Phase 15 Plan 02 when fully implemented.
    async debate(modelId, system, prompt, signal) {
      return base.debate(modelId, system, prompt, signal);
    },
  };
}
