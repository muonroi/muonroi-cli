/**
 * The planner phase: turns the council's approved synthesis (plus the debate
 * exchanges, for grounding) into an ordered, independently-gateable
 * `.planning/PLAN.md`. Without this, `/council` ended in prose or a single
 * flat recommendation — continuing past it required a whole new debate
 * (session 3a8378db4adf). Each phase carries its own acceptance criteria and
 * verify command so the executor (Task 8) can gate phases one at a time
 * instead of trusting one giant "implement everything" step.
 *
 * NOT wired into the council flow yet — that lands in a later task. This
 * module only builds the prompt, parses the model's phases, and writes the
 * artifact when called.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { planningArtifact } from "../gsd/paths.js";
import type { StreamChunk } from "../types/index.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import { type PlanPhase, renderPlanMarkdown } from "./plan-artifact.js";
import { extractJsonObject } from "./planner.js";
import type { CouncilLLM } from "./types.js";

export function buildPlannerPrompt(topic: string, synthesis: string, exchanges: string): string {
  return [
    `You are the council PLANNER. The debate on "${topic}" has concluded.`,
    "",
    "Approved conclusion:",
    synthesis,
    "",
    "Debate exchanges (for grounding — do NOT re-litigate them):",
    exchanges.slice(0, 12_000),
    "",
    "Write the implementation plan as ORDERED PHASES. Every phase must be independently",
    "gateable: it carries its own acceptance criteria and its own verify command.",
    "Do not fold the whole change into one phase, and do not invent scope the",
    "conclusion did not agree to.",
    "",
    "Emit ONE fenced json block and nothing else after it:",
    "```json",
    '{ "phases": [ { "id": "P0", "title": "…", "steps": ["…"], "files": ["…"],',
    '               "acceptance": ["…"], "verify": "<shell command, or empty string>" } ] }',
    "```",
  ].join("\n");
}

/**
 * Phases from planner output. A phase with no acceptance criteria is DROPPED:
 * the executor gates each phase on its criteria, so an empty-criteria phase
 * would auto-pass and reintroduce exactly the unverified "implement" the plan
 * gate exists to stop.
 */
export function parsePlannerPhases(raw: string): PlanPhase[] {
  const { json } = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.error(`[council/plan-phase] planner JSON parse failed: ${(err as Error).message}`);
    return [];
  }
  const rows = (parsed as { phases?: unknown })?.phases;
  if (!Array.isArray(rows)) return [];
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return rows
    .map((r): PlanPhase | null => {
      // A malformed element (`null`, a bare string, an array, ...) is an ordinary
      // LLM slip (truncation, stray comma) — drop it rather than crash reading
      // `.id` off it. Only real objects proceed to field coercion below.
      if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
      const row = r as Record<string, unknown>;
      return {
        id: typeof row.id === "string" ? row.id : "",
        title: typeof row.title === "string" ? row.title : "",
        steps: asStrings(row.steps),
        files: asStrings(row.files),
        acceptance: asStrings(row.acceptance),
        verify: typeof row.verify === "string" ? row.verify : "",
        done: false,
      };
    })
    .filter((p): p is PlanPhase => p !== null && p.id !== "" && p.title !== "" && p.acceptance.length > 0);
}

export interface PlannerArgs {
  cwd: string;
  topic: string;
  synthesis: string;
  exchanges: string;
  plannerModelId: string;
  llm: CouncilLLM;
}

export async function* runPlannerPhase(
  args: PlannerArgs,
): AsyncGenerator<StreamChunk, { planPath: string; phases: PlanPhase[] } | null, unknown> {
  const startedAt = Date.now();
  yield phaseStart({
    phaseId: "phase:plan",
    kind: "action_plan",
    label: "Planner — drafting the plan",
    detail: `via ${args.plannerModelId}`,
    startedAt,
  });

  let raw = "";
  try {
    raw = yield* tracedGenerate(args.llm, {
      modelId: args.plannerModelId,
      phase: "synthesis",
      label: "Planner",
      system: "You write phased, independently-verifiable implementation plans.",
      prompt: buildPlannerPrompt(args.topic, args.synthesis, args.exchanges),
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[council/plan-phase] planner generate failed: ${msg}`);
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner failed",
      startedAt,
      errorMessage: msg,
    });
    return null;
  }

  const phases = parsePlannerPhases(raw);
  if (phases.length === 0) {
    console.error("[council/plan-phase] planner emitted no gateable phase — plan not written");
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner produced no gateable phase",
      startedAt,
      errorMessage: "no phase with acceptance criteria was parsed from the planner output",
    });
    return null;
  }

  const planPath = planningArtifact(args.cwd, "PLAN.md");
  try {
    const body = renderPlanMarkdown(args.topic, phases);
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, body, "utf8");
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[council/plan-phase] writing ${planPath} failed: ${msg}`);
    yield phaseError({
      phaseId: "phase:plan",
      kind: "action_plan",
      label: "Planner failed to write PLAN.md",
      startedAt,
      errorMessage: msg,
    });
    return null;
  }

  yield phaseDone({
    phaseId: "phase:plan",
    kind: "action_plan",
    label: `Plan drafted — ${phases.length} phase(s)`,
    startedAt,
  });
  return { planPath, phases };
}
