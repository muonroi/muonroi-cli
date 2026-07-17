import { generateObject } from "ai";
import { z } from "zod";
import type { CouncilWarning } from "../ee/council-bridge.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import { createProviderFactory, detectProviderForModel, resolveModelRuntime } from "../providers/runtime.js";
import type { StreamChunk } from "../types/index.js";
import { withDeadlineRace, withTimeoutSignal } from "../utils/llm-deadline.js";
import { logger } from "../utils/logger.js";
import { type CouncilExperienceMode, getProviderStallTimeoutMs } from "../utils/settings.js";
import { tracedGenerate } from "./llm.js";
import { buildDebatePlanPrompt } from "./prompts.js";
import type { ClarifiedSpec, CouncilLLM, DebatePlan, DebateStance, OutputSection, OutputShape } from "./types.js";

const FALLBACK_PLAN: DebatePlan = {
  intentSummary: "(planner unavailable — using generic stances)",
  stances: [
    { name: "Primary Analyst", lens: "Address the success criteria with concrete reasoning." },
    { name: "Critical Reviewer", lens: "Stress-test claims, surface missing evidence, identify risks." },
  ],
  outputShape: {
    kind: "decision",
    sections: [
      { key: "agreed", heading: "Agreed", prompt: "points participants converged on", shape: "list" },
      { key: "tradeoffs", heading: "Trade-offs", prompt: "real trade-offs identified", shape: "list" },
      { key: "recommendation", heading: "Recommendation", prompt: "decisive verdict", shape: "text" },
    ],
    guardrails: ["Be evidence-grounded; flag any claim that lacks support."],
  },
};

// ── Zod schemas mirroring DebatePlan interface ───────────────────────────────

const DebateStanceSchema = z.object({
  name: z.string(),
  lens: z.string(),
  focus: z.string().optional(),
});

const OutputSectionSchema = z.object({
  key: z.string(),
  heading: z.string(),
  prompt: z.string().optional().default(""),
  shape: z.enum(["list", "text", "objectList"]).default("list"),
});

const DebatePlanSchema = z.object({
  intentSummary: z.string(),
  stances: z.array(DebateStanceSchema),
  outputShape: z.object({
    kind: z.string(),
    sections: z.array(OutputSectionSchema),
    guardrails: z.array(z.string()).default([]),
  }),
  plannedRounds: z.number().int().min(1).max(5).optional(),
});

// ── planDebate ────────────────────────────────────────────────────────────────

/**
 * Helper: for implementation_plan debates, guarantee at least one Product/User-side
 * voice in the roster. Engineering-only rosters (Architect/Cost/Skeptic/Researcher)
 * historically inflate scope — see session f1cec5324716 where "tạo todo app"
 * became a multi-tenant SaaS plan. The system prompt already asks the planner to
 * include such a stance, but we still post-check in case the planner ignored it.
 */
const PRODUCT_VOICE_PATTERNS = /(product\s*owner|user\s*advocate|customer|mvp\s*skeptic|user\s*proxy)/i;
const PRODUCT_LENS_PATTERNS = /(user\s+need|scope|v1|over[-\s]?build|day\s*1|would.*pay|ship.*tomorrow)/i;

function hasProductStance(stances: readonly DebateStance[]): boolean {
  return stances.some((s) => PRODUCT_VOICE_PATTERNS.test(s.name) || PRODUCT_LENS_PATTERNS.test(s.lens));
}

function ensureProductStance(plan: DebatePlan): DebatePlan {
  if (plan.outputShape.kind !== "implementation_plan") return plan;
  if (hasProductStance(plan.stances)) return plan;
  const productStance: DebateStance = {
    name: "Product Owner",
    lens:
      "What does the user actually need on day 1, and what are we over-building? " +
      "Challenge every actionItem that doesn't directly serve the user's stated prompt; " +
      "push enterprise/multi-tenant/scalability work to v2 unless the prompt explicitly requires it.",
    focus: "scope discipline & MVP cut-line",
  };
  return { ...plan, stances: [...plan.stances, productStance] };
}

/** Helper: inject Experience Auditor stance into a plan, depending on mode. */
function injectAuditorStance(
  plan: DebatePlan,
  eeWarnings: CouncilWarning[] | undefined,
  experienceMode: CouncilExperienceMode | undefined,
): DebatePlan {
  // CQ-14: Auto-add Experience Auditor stance when EE returns >= 1 warning and mode != off
  if (!eeWarnings || eeWarnings.length < 1 || experienceMode === "off") return plan;
  const auditorStance: DebateStance = {
    name: "Experience Auditor",
    lens: "Challenge all claims against known past mistakes and principles recorded in the experience brain.",
    focus: eeWarnings
      .map((w) => w.text)
      .join("; ")
      .slice(0, 300),
  };
  const stances = [...plan.stances];
  // advisory: append as 3rd voice; enforcing: replace last generic stance
  if (experienceMode === "enforcing" && stances.length >= 2) {
    stances[stances.length - 1] = auditorStance;
  } else {
    stances.push(auditorStance);
  }
  return { ...plan, stances };
}

/**
 * PIL task types whose deliverable is understanding/evaluation of something that
 * already exists — never a build. The user asked to assess, not to implement.
 */
const ANALYSIS_TASK_TYPES = new Set<string>(["analyze"]);

function isAnalysisTaskType(taskType?: string): boolean {
  return !!taskType && ANALYSIS_TASK_TYPES.has(taskType);
}

/**
 * Deterministic backstop for post-debate drift (session c4f78752a316).
 *
 * PIL is the authoritative intent classifier. When it says the request is
 * analysis/evaluation, the leader LLM must not be allowed to silently reshape the
 * debate into an `implementation_plan` — that shape makes the post-debate AskCard
 * default to "generate_plan" (build a plan) via pickPostDebateRecommendation,
 * which is the wrong next step for a request that only wanted an assessment.
 *
 * The prompt already asks the leader to honor the intent (soft), but LLMs drift;
 * this coerces a drifted shape back to "evaluation" so the synthesis stays the
 * deliverable and the default action becomes save_exit. Non-implementation shapes
 * are left untouched.
 */
function enforceAnalysisIntentShape(plan: DebatePlan, taskType?: string): DebatePlan {
  if (!isAnalysisTaskType(taskType)) return plan;
  if (plan.outputShape.kind !== "implementation_plan") return plan;
  logger.info(
    "orchestrator",
    `[debate-planner] PIL taskType=${taskType} (analysis) but leader chose implementation_plan; ` +
      "coercing outputShape.kind→evaluation to honor analysis intent",
  );
  return { ...plan, outputShape: { ...plan.outputShape, kind: "evaluation" } };
}

export async function* planDebate(
  spec: ClarifiedSpec,
  leaderModelId: string,
  llm: CouncilLLM,
  eeWarnings?: CouncilWarning[], // CQ-13: experience snippets to seed prompt
  experienceMode?: CouncilExperienceMode, // CQ-14: controls Experience Auditor injection
  taskType?: string, // CQ-11: task type from PIL (e.g. "architecture", "bugfix")
  complexityTier?: string, // CQ-11: complexity tier from PIL (e.g. "heavy", "medium", "light")
  signal?: AbortSignal, // user-abort signal — threaded into the direct generateObject attempt
): AsyncGenerator<StreamChunk, DebatePlan, unknown> {
  const eeSnippets = eeWarnings?.map((w) => w.text).filter(Boolean) ?? [];
  const { system: baseSystem, prompt } = buildDebatePlanPrompt(spec);

  // Every return path funnels through here: auditor + product-stance injection,
  // plus the deterministic analysis-intent backstop (applied first so a coerced
  // shape doesn't get a spurious product stance injected for it).
  const finalizePlan = (plan: DebatePlan): DebatePlan =>
    ensureProductStance(injectAuditorStance(enforceAnalysisIntentShape(plan, taskType), eeWarnings, experienceMode));

  // Build calibration context from PIL metadata
  const pilCalibration: string[] = [];
  if (taskType) pilCalibration.push(`Task type: ${taskType}`);
  if (complexityTier) pilCalibration.push(`Complexity tier: ${complexityTier} — calibrate debate depth accordingly`);

  let system = baseSystem;
  if (pilCalibration.length > 0) {
    system += `\n\n## Task Context (from PIL)\n${pilCalibration.join("\n")}`;
  }
  // Hard intent lock (steers stances AND shape). PIL already classified this as
  // analysis; the deterministic backstop in finalizePlan enforces it regardless,
  // but steering the leader here keeps the whole roster/synthesis on-intent.
  if (isAnalysisTaskType(taskType)) {
    system +=
      `\n\n## INTENT LOCK (authoritative)\n` +
      `PIL classified this request as ANALYSIS/EVALUATION (taskType=${taskType}). The user wants to ` +
      `understand and assess what ALREADY exists — not to build anything. ` +
      `outputShape.kind MUST be "evaluation" or "investigation" — NEVER "implementation_plan". ` +
      `Do NOT propose building, implementing, scaffolding, or "I'll spec that in vN". ` +
      `Stances must be analyst/critic/investigator voices, not implementers.`;
  }
  if (eeSnippets.length > 0) {
    system += `\n\n## Experience Warnings (from brain)\nNote these past mistakes when designing debate stances:\n${eeSnippets.map((s) => `- ${s}`).join("\n")}`;
  }
  // Ecosystem framing — stances + output sections should center on optimal
  // use of existing BB / Muonroi.* packages, not greenfield analysis.
  try {
    const { shouldApplyEcosystemBias, buildEcosystemDebateContext } = await import(
      "../product-loop/discovery-ecosystem.js"
    );
    if (shouldApplyEcosystemBias({ cwd: process.cwd() })) {
      system += `\n\n${buildEcosystemDebateContext()}`;
    }
  } catch {
    /* graceful — never block debate planning */
  }

  // Attempt 1: generateObject with Zod schema
  try {
    const providerId = detectProviderForModel(leaderModelId);
    const key = await loadKeyForProvider(providerId);
    // Registers the leader provider's factory so resolveModelRuntime can derive it.
    createProviderFactory(providerId, { apiKey: key });
    const runtime = resolveModelRuntime(leaderModelId);

    // Bound attempt-1: a wedged provider response here would freeze the whole
    // council/loop silently (no streamText stall watchdog covers generateObject).
    // On timeout this rejects → caught below → retry (guarded) → fallback plan.
    // The user-abort signal is combined in so an Esc during planning aborts it.
    const { signal: timedSignal, cleanup: cleanupTimeout } = withTimeoutSignal(signal, getProviderStallTimeoutMs());
    const { object } = await withDeadlineRace(
      () =>
        generateObject({
          model: runtime.model,
          schema: DebatePlanSchema,
          system,
          prompt,
          abortSignal: timedSignal,
          ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
        }),
      getProviderStallTimeoutMs() + 5_000,
      "plan_debate",
      signal,
    ).finally(() => cleanupTimeout());

    // Validate with existing sanitize helpers for normalization
    const stances = sanitizeStances(object.stances);
    const outputShape = sanitizeShape(object.outputShape);
    if (stances.length >= 2 && outputShape) {
      const rawPlanned = (object as { plannedRounds?: number }).plannedRounds;
      const plannedRounds =
        typeof rawPlanned === "number" && Number.isFinite(rawPlanned)
          ? Math.max(1, Math.min(5, Math.floor(rawPlanned)))
          : undefined;
      const plan: DebatePlan = {
        intentSummary: object.intentSummary || "(no intent summary provided)",
        stances,
        outputShape,
        plannedRounds,
      };
      return finalizePlan(plan);
    }
    // Invalid even with schema — fall through to retry with a sanitize-failure message
    throw new Error("Sanitize check failed: stances.length < 2 or outputShape is null");
  } catch (structuredErr) {
    // generateObject failed (or sanitize check failed) — retry once with schema error feedback
    // T-15-07: Slice error to 200 chars to prevent prompt blowout from verbose Zod errors
    const schemaFeedback = structuredErr instanceof Error ? structuredErr.message : String(structuredErr);
    const retryPrompt =
      prompt +
      `\n\nSchema validation failed: ${schemaFeedback.slice(0, 200)}. Output valid JSON matching the required schema.`;

    try {
      const retryRaw = yield* tracedGenerate(llm, {
        phase: "plan_debate",
        label: "Planning debate (retry with schema feedback)",
        modelId: leaderModelId,
        system,
        prompt: retryPrompt,
        maxTokens: 1500,
      });
      const retryParsed = parsePlan(retryRaw);
      if (retryParsed) return finalizePlan(retryParsed);
    } catch (retryErr) {
      yield {
        type: "content",
        content: `[Debate planning retry failed: ${retryErr instanceof Error ? retryErr.message : retryErr}]\n`,
      };
    }
  }

  // All attempts exhausted — return fallback
  return finalizePlan(FALLBACK_PLAN);
}

function parsePlan(raw: string): DebatePlan | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]) as Partial<DebatePlan>;

    const stances = sanitizeStances(obj.stances);
    if (stances.length < 2) return null;

    const outputShape = sanitizeShape(obj.outputShape);
    if (!outputShape) return null;

    const rawPlanned = (obj as { plannedRounds?: unknown }).plannedRounds;
    const plannedRounds =
      typeof rawPlanned === "number" && Number.isFinite(rawPlanned)
        ? Math.max(1, Math.min(5, Math.floor(rawPlanned)))
        : undefined;

    return {
      intentSummary:
        typeof obj.intentSummary === "string" && obj.intentSummary.trim()
          ? obj.intentSummary.trim()
          : "(no intent summary provided)",
      stances,
      outputShape,
      plannedRounds,
    };
  } catch {
    return null;
  }
}

function sanitizeStances(raw: unknown): DebateStance[] {
  if (!Array.isArray(raw)) return [];
  const out: DebateStance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const lens = typeof obj.lens === "string" ? obj.lens.trim() : "";
    if (!name || !lens) continue;
    const focus = typeof obj.focus === "string" && obj.focus.trim() ? obj.focus.trim() : undefined;
    out.push({ name, lens, focus });
    if (out.length >= 4) break;
  }
  return out;
}

function sanitizeShape(raw: unknown): OutputShape | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const sections = sanitizeSections(obj.sections);
  if (sections.length === 0) return null;
  const guardrails = Array.isArray(obj.guardrails)
    ? obj.guardrails.filter((g): g is string => typeof g === "string" && g.trim().length > 0).map((g) => g.trim())
    : [];
  return {
    kind: typeof obj.kind === "string" && obj.kind.trim() ? obj.kind.trim() : "decision",
    sections,
    guardrails,
  };
}

function sanitizeSections(raw: unknown): OutputSection[] {
  if (!Array.isArray(raw)) return [];
  const out: OutputSection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key.trim() : "";
    const heading = typeof obj.heading === "string" ? obj.heading.trim() : "";
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!key || !heading) continue;
    const shapeRaw = typeof obj.shape === "string" ? obj.shape.trim() : "list";
    const shape: OutputSection["shape"] =
      shapeRaw === "text" ? "text" : shapeRaw === "objectList" ? "objectList" : "list";
    out.push({ key, heading, prompt: prompt || heading.toLowerCase(), shape });
  }
  return out;
}
