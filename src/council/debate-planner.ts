import { generateObject } from "ai";
import { z } from "zod";
import type { StreamChunk } from "../types/index.js";
import type { ClarifiedSpec, CouncilLLM, DebatePlan, DebateStance, OutputSection, OutputShape } from "./types.js";
import type { CouncilWarning } from "../ee/council-bridge.js";
import type { CouncilExperienceMode } from "../utils/settings.js";
import { buildDebatePlanPrompt } from "./prompts.js";
import { tracedGenerate } from "./llm.js";
import { detectProviderForModel, createProviderFactory, resolveModelRuntime } from "../providers/runtime.js";
import { loadKeyForProvider } from "../providers/keychain.js";

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
    focus: eeWarnings.map((w) => w.text).join("; ").slice(0, 300),
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

export async function* planDebate(
  spec: ClarifiedSpec,
  leaderModelId: string,
  llm: CouncilLLM,
  eeWarnings?: CouncilWarning[],          // CQ-13: experience snippets to seed prompt
  experienceMode?: CouncilExperienceMode, // CQ-14: controls Experience Auditor injection
  taskType?: string,                       // CQ-11: task type from PIL (e.g. "architecture", "bugfix")
  complexityTier?: string,                 // CQ-11: complexity tier from PIL (e.g. "heavy", "medium", "light")
): AsyncGenerator<StreamChunk, DebatePlan, unknown> {
  const eeSnippets = eeWarnings?.map((w) => w.text).filter(Boolean) ?? [];
  const { system: baseSystem, prompt } = buildDebatePlanPrompt(spec);

  // Build calibration context from PIL metadata
  const pilCalibration: string[] = [];
  if (taskType) pilCalibration.push(`Task type: ${taskType}`);
  if (complexityTier) pilCalibration.push(`Complexity tier: ${complexityTier} — calibrate debate depth accordingly`);

  let system = baseSystem;
  if (pilCalibration.length > 0) {
    system += `\n\n## Task Context (from PIL)\n${pilCalibration.join("\n")}`;
  }
  if (eeSnippets.length > 0) {
    system += `\n\n## Experience Warnings (from brain)\nNote these past mistakes when designing debate stances:\n${eeSnippets.map((s) => `- ${s}`).join("\n")}`;
  }

  // Attempt 1: generateObject with Zod schema
  try {
    const providerId = detectProviderForModel(leaderModelId);
    const key = await loadKeyForProvider(providerId);
    const { factory } = createProviderFactory(providerId, { apiKey: key });
    const runtime = resolveModelRuntime(factory, leaderModelId);

    const { object } = await generateObject({
      model: runtime.model,
      schema: DebatePlanSchema,
      system,
      prompt,
      ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
    });

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
      return injectAuditorStance(plan, eeWarnings, experienceMode);
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
      if (retryParsed) return injectAuditorStance(retryParsed, eeWarnings, experienceMode);
    } catch (retryErr) {
      yield {
        type: "content",
        content: `[Debate planning retry failed: ${retryErr instanceof Error ? retryErr.message : retryErr}]\n`,
      };
    }
  }

  // All attempts exhausted — return fallback
  return injectAuditorStance(FALLBACK_PLAN, eeWarnings, experienceMode);
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
      intentSummary: typeof obj.intentSummary === "string" && obj.intentSummary.trim()
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
