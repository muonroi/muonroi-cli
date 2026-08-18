import type { StreamChunk } from "../types/index.js";
import { getCouncilLanguage } from "../utils/settings.js";
import { tracedGenerate } from "./llm.js";
import { phaseDone, phaseError, phaseStart } from "./phase-events.js";
import { emitPreflightHarnessEvent } from "./preflight.js";
import { buildSynthesisPrompt } from "./prompts.js";
import type {
  ActionPlan,
  ClarifiedSpec,
  CouncilLLM,
  CouncilParticipant,
  DebatePlan,
  DebateState,
  EnhancedCouncilOutcome,
  IntentKind,
  PostDebateActionId,
  PreflightResponder,
} from "./types.js";
import { coerceIntentKind } from "./types.js";

export async function* runPlanning(
  debateState: DebateState,
  spec: ClarifiedSpec,
  participants: CouncilParticipant[],
  leaderModelId: string,
  respondToPreflight: PreflightResponder,
  llm: CouncilLLM,
  debatePlan?: DebatePlan,
  // CQ-18: PIL outputStyle from runCouncil
  outputStyle?: string | null,
  refineContext?: string, // User refinement answers from post-debate askcard
  planEmphasis?: boolean, // If true, emphasize action plan generation
): AsyncGenerator<
  StreamChunk,
  {
    outcome: EnhancedCouncilOutcome | null;
    plan: ActionPlan | null;
    synthesisText: string;
    synthesisFailReason?: string;
  },
  unknown
> {
  const p3Start = Date.now();
  yield phaseStart({
    phaseId: "phase:synthesis",
    kind: "synthesis",
    label: "Synthesis & planning",
    detail: `via ${leaderModelId}`,
  });

  const allExchanges = [...debateState.exchangeLogs.entries()]
    .map(([pair, log]) => `### Discussion: ${pair}\n${log.join("\n\n")}`)
    .join("\n\n---\n\n");

  const finalPositions = participants
    .map((p) => {
      const label = p.stance?.name ?? p.role;
      return `**${label}** (${p.role} · ${p.model}): ${p.position.slice(0, 2000)}...`;
    })
    .join("\n\n");

  let synthesisText = "";
  let outcome: EnhancedCouncilOutcome | null = null;
  let synthesisFailReason: string | undefined;

  try {
    const baseArgs = {
      spec,
      finalPositions,
      allExchanges,
      debatePlan,
      outputStyle: outputStyle ?? undefined,
      refineContext,
      planEmphasis,
      // Feature B — synthesis output language follows the resolved council
      // debate language (auto → detect from the brief; pinned → that locale).
      language: getCouncilLanguage(),
    };
    const first = buildSynthesisPrompt(baseArgs);
    synthesisText = yield* tracedGenerate(llm, {
      phase: "synthesis",
      label: "Synthesizing action plan",
      modelId: leaderModelId,
      system: first.system,
      prompt: first.prompt,
      maxTokens: 8192,
    });

    outcome = parseOutcome(synthesisText, debatePlan);

    // ── Empty / unparseable synthesis recovery ─────────────────────────────
    // Synthesis can return "" when the provider times out internally, or a
    // blob without a parseable JSON object when the model went off-script.
    // Retry ONCE with a compacted prompt (trim exchanges, demand JSON-only).
    // Without this, the user sees "Synthesis (empty)" with no explanation
    // and confidence locked at 0 — which is exactly the bug we're fixing.
    const trimmed = synthesisText.trim();
    const emptySynthesis = trimmed.length === 0;
    // A JSON object that opened and never closed means the completion was CUT
    // OFF at the provider's output ceiling — a different failure from "the model
    // ignored the format", and it needs the opposite retry: ask for LESS, not
    // for the same thing again. Measured on the leak this fixes: Z.ai caps
    // glm-5.2 completions at 4096 tokens regardless of the max_tokens we send
    // (probe: requested 8192 → finishReason "length", 4096 out, 2501 of them
    // reasoning), so a maximal structured answer cannot physically fit and both
    // attempts truncated identically.
    const truncated = !emptySynthesis && extractJsonObject(synthesisText).truncated;
    const unparseable = !emptySynthesis && !truncated && outcome === null;
    if (emptySynthesis || truncated || unparseable) {
      const initialReason = emptySynthesis
        ? "synthesizer returned an empty completion — on a reasoning leader this usually means the whole output budget went to thinking tokens"
        : truncated
          ? "synthesizer output was cut off mid-JSON at the provider's output ceiling"
          : "synthesizer output had no parseable JSON object (model produced markdown without the required JSON block)";
      yield {
        type: "content",
        content: `\n> Synthesis attempt 1 failed: ${initialReason}. Retrying once with a compact prompt…\n`,
      };
      // Compact: keep final positions (already capped per-participant to 2k),
      // drop the full exchange replay entirely, and ask explicitly for JSON.
      const compactArgs = {
        ...baseArgs,
        allExchanges: "_(exchange history omitted for retry; rely on final positions above)_",
      };
      const retry = buildSynthesisPrompt(compactArgs);
      const retrySystem =
        retry.system +
        `\n\n## Retry directive\n` +
        (truncated || emptySynthesis
          ? `Your previous attempt did not FIT in the output budget. Emit the JSON object FIRST and keep it SMALL: ` +
            `\`summary\` at most 400 characters, every list at most 3 entries of at most 200 characters each, ` +
            `no nested prose. Completing the JSON object matters more than covering every point. ` +
            `Skip the \`---READABLE---\` section entirely if you are running short.`
          : `Your previous attempt produced no parseable JSON. Emit the JSON object FIRST, ` +
            `then the literal line \`---READABLE---\`, then the markdown. Do not add any preamble before the JSON.`);
      const retryText = yield* tracedGenerate(llm, {
        phase: "synthesis",
        label: "Synthesizing action plan (retry, compact)",
        modelId: leaderModelId,
        system: retrySystem,
        prompt: retry.prompt,
        maxTokens: 4096,
      });
      if (retryText.trim().length > 0) {
        synthesisText = retryText;
        outcome = parseOutcome(synthesisText, debatePlan);
      }
      if (!synthesisText.trim() || outcome === null) {
        synthesisFailReason =
          synthesisText.trim().length === 0
            ? "Synthesizer returned empty completion on both attempts. Provider may be rate-limited, or the leader is a reasoning model spending its whole output budget on thinking tokens — the debate exchanges above are still usable as raw notes."
            : extractJsonObject(synthesisText).truncated
              ? "Synthesizer hit the provider's output ceiling on both attempts and the JSON was cut off mid-object. Raw output is shown above; try a leader model with a larger completion budget."
              : "Synthesizer produced text but no parseable JSON outcome on either attempt. Raw output is shown above; the structured sections could not be extracted.";
      }
    }

    const readablePart = synthesisText.includes("---READABLE---")
      ? synthesisText.split("---READABLE---")[1]?.trim()
      : synthesisText;
    const synthBody =
      readablePart && readablePart.length > 0
        ? readablePart
        : synthesisText.trim().length > 0
          ? synthesisText
          : `_(empty — ${synthesisFailReason ?? "no output"})_`;
    yield {
      type: "council_message" as const,
      councilMessage: {
        kind: "synthesis" as const,
        speaker: { role: "Leader", model: leaderModelId },
        text: synthBody,
      },
    };

    yield phaseDone({
      phaseId: "phase:synthesis",
      kind: "synthesis",
      label: "Synthesis & planning",
      startedAt: p3Start,
      detail: synthesisFailReason ? `failed: ${synthesisFailReason.slice(0, 60)}…` : `via ${leaderModelId}`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    synthesisFailReason = `Synthesizer call threw: ${msg}`;
    yield phaseError({
      phaseId: "phase:synthesis",
      kind: "synthesis",
      label: "Synthesis & planning",
      startedAt: p3Start,
      errorMessage: msg,
    });
    yield { type: "content", content: `[Synthesis error: ${msg}]\n` };
  }

  const plan = outcome?.plan ?? null;

  if (plan && plan.steps.length > 0) {
    const planPhaseStart = Date.now();
    yield phaseStart({
      phaseId: "phase:action-plan",
      kind: "action_plan",
      label: "Action plan review",
      detail: `${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`,
    });
    yield { type: "content", content: "\n### Action Plan\n" };
    for (const step of plan.steps) {
      yield { type: "content", content: `- [${step.priority}] ${step.description}\n` };
    }

    const preflightId = crypto.randomUUID();
    emitPreflightHarnessEvent({
      t: "event",
      kind: "askcard-open",
      questionId: preflightId,
      question: `Approve action plan for: ${spec.problemStatement}`,
      phase: "plan-confirm",
      optionCount: 2,
      defaultIndex: 0,
    });
    yield {
      type: "council_preflight" as StreamChunk["type"],
      content: "Review the action plan above. Approve to proceed with execution, or reject.",
      councilPreflight: {
        preflightId,
        problemStatement: spec.problemStatement,
        constraints: spec.constraints,
        successCriteria: spec.successCriteria,
        scope: spec.scope,
        participants: participants.map((p) => ({ role: p.role, model: p.model })),
        researchNeeded: false,
      },
    };

    const approved = await respondToPreflight(preflightId);
    emitPreflightHarnessEvent({
      t: "event",
      kind: "askcard-answered",
      questionId: preflightId,
      answerKind: "choice",
      answerText: approved ? "approve" : "reject",
    });
    yield phaseDone({
      phaseId: "phase:action-plan",
      kind: "action_plan",
      label: "Action plan review",
      startedAt: planPhaseStart,
      detail: approved ? "approved" : "rejected by user",
    });
    if (!approved) {
      return { outcome, plan: null, synthesisText, synthesisFailReason };
    }
  }

  return { outcome, plan, synthesisText, synthesisFailReason };
}

function shapeFallback(synthesisText: string, debatePlan: DebatePlan): EnhancedCouncilOutcome | null {
  const shape = debatePlan.outputShape;
  // Extract summary: first line with >= 20 non-whitespace chars
  const summary =
    synthesisText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length >= 20) ?? "";
  if (!summary) return null;
  // Simple markdown heading-based extraction for each section
  const sections: Record<string, unknown> = {};
  for (const s of shape.sections) {
    const heading = s.heading.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    // Find lines after "## Heading" pattern
    const lines: string[] = [];
    let found = false;
    for (const line of synthesisText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.match(new RegExp(`^#{1,3}\\s+${heading.replace(/\s+/g, "\\s+")}`, "i"))) {
        found = true;
        continue;
      }
      if (found) {
        if (trimmed.startsWith("#")) break;
        if (trimmed) lines.push(trimmed);
      }
    }
    if (s.shape === "list") {
      sections[s.key] = lines;
    } else if (s.shape === "objectList") {
      sections[s.key] = [];
    } else {
      sections[s.key] = lines.join("\n");
    }
  }
  return {
    type: shape.kind,
    summary,
    sections: Object.keys(sections).length > 0 ? sections : undefined,
  };
}

/**
 * Pull the synthesis JSON object out of a leader completion.
 *
 * The old `/\{[\s\S]*\}/` greedy match had two failure modes that both fired in
 * session e74e820c6417:
 *
 *   1. No `---READABLE---` separator (the model emitted a ```json fence and then
 *      markdown) → the match ran from the first `{` to the LAST `}` anywhere in
 *      the prose, producing invalid JSON.
 *   2. The completion was CUT OFF at the provider's output ceiling mid-object →
 *      no trailing `}` at all → no match, and the caller could not tell
 *      "truncated" from "model ignored the format".
 *
 * This scanner strips code fences, then walks from the first `{` with a
 * string/escape-aware depth counter and stops at the matching close. `truncated`
 * is true when the object never closed — the signal the retry path needs to ask
 * for a SHORTER answer rather than repeating the same oversized request.
 */
export function extractJsonObject(raw: string): { json: string | null; truncated: boolean } {
  // Only consider the pre-separator half when the contract was honoured.
  const beforeSeparator = raw.includes("---READABLE---") ? raw.split("---READABLE---")[0]! : raw;
  // ```json … ``` (or a bare ``` fence) around the object.
  const fenced = beforeSeparator.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  const body = fenced ? fenced[1]! : beforeSeparator;
  const start = body.indexOf("{");
  if (start === -1) return { json: null, truncated: false };

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: body.slice(start, i + 1), truncated: false };
    }
  }
  // Ran off the end with the object still open.
  return { json: null, truncated: true };
}

function parseOutcome(synthesisText: string, debatePlan?: DebatePlan): EnhancedCouncilOutcome | null {
  const { json: extracted } = extractJsonObject(synthesisText);
  const jsonMatch = extracted ? [extracted] : null;
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      // Authoritative kind: trust the planner's already-coerced kind over the
      // synthesizer's free-form "type" string (it can drift — bug 12d3022b was a
      // leader LLM emitting implementation_plan for an analysis request). Fall
      // back to coercing the synthesizer's type only when no plan kind exists.
      const type: IntentKind = debatePlan?.outputShape.kind ?? coerceIntentKind(parsed.type);
      const summary = typeof parsed.summary === "string" ? parsed.summary : "";
      if (!summary) {
        throw new Error("No summary in parsed JSON");
      }

      // Pull dynamic sections out by the leader's proposed keys.
      const sections: Record<string, unknown> = {};
      if (debatePlan?.outputShape.sections) {
        for (const s of debatePlan.outputShape.sections) {
          if (s.key in parsed) sections[s.key] = parsed[s.key];
        }
      }

      // Model-first post-debate options. Keep only entries whose action is in
      // the wired vocabulary; drop malformed items so a hallucinated action id
      // can't reach the handler switch. Empty → index.ts uses its fallback set.
      const VALID_ACTIONS = new Set(["ask_followup", "implement", "save_exit", "continue_session"]);
      const nextActions = Array.isArray(parsed.nextActions)
        ? (parsed.nextActions as unknown[])
            .filter(
              (a): a is { action: string; label: string; reason?: string } =>
                !!a &&
                typeof a === "object" &&
                typeof (a as { action?: unknown }).action === "string" &&
                VALID_ACTIONS.has((a as { action: string }).action) &&
                typeof (a as { label?: unknown }).label === "string" &&
                (a as { label: string }).label.trim().length > 0,
            )
            .map((a) => ({
              action: a.action as PostDebateActionId,
              label: a.label.trim(),
              reason: typeof a.reason === "string" ? a.reason.trim() : undefined,
            }))
        : undefined;

      return {
        type,
        summary,
        sections: Object.keys(sections).length > 0 ? sections : undefined,
        nextActions: nextActions && nextActions.length > 0 ? nextActions : undefined,
        // Legacy fields — synthesizer may still emit them when shape calls for them.
        agreed: Array.isArray(parsed.agreed) ? (parsed.agreed as string[]) : undefined,
        tradeoffs: Array.isArray(parsed.tradeoffs) ? (parsed.tradeoffs as string[]) : undefined,
        recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : undefined,
        actionItems: Array.isArray(parsed.actionItems) ? (parsed.actionItems as string[]) : undefined,
        planUpdate: typeof parsed.planUpdate === "string" ? parsed.planUpdate : undefined,
        resolvedQuestion: parsed.resolvedQuestion as EnhancedCouncilOutcome["resolvedQuestion"],
        plan: parsed.plan as ActionPlan | undefined,
      };
    } catch {
      // fall through to log + fallback
    }
  }
  // Log raw text for diagnostics
  console.error("[Council] parseOutcome failed — raw synthesis text:", synthesisText.slice(0, 500));
  // Shape-based fallback — feed it the READABLE prose only. Handing it the raw
  // completion let a truncated JSON blob through line-first summary extraction
  // and persisted `summary: "\"type\": \"evaluation\","` with every section empty
  // into session memory as the council's decision (session e74e820c6417).
  if (debatePlan?.outputShape) {
    const prose = synthesisText.includes("---READABLE---")
      ? (synthesisText.split("---READABLE---")[1] ?? "")
      : stripJsonPreamble(synthesisText);
    return shapeFallback(prose.trim().length > 0 ? prose : synthesisText, debatePlan);
  }
  return null;
}

/**
 * Drop a leading (possibly truncated / fenced) JSON object so the prose fallback
 * summarises prose, not JSON syntax. Returns "" when the text is JSON all the
 * way down — better an empty fallback the caller can reject than a summary that
 * reads `"type": "evaluation",`.
 */
function stripJsonPreamble(text: string): string {
  const withoutFence = text.replace(/```(?:json)?[\s\S]*?(?:```|$)/i, "");
  const start = withoutFence.indexOf("{");
  if (start === -1) return withoutFence;
  const { json } = extractJsonObject(withoutFence);
  if (!json) return withoutFence.slice(0, start);
  const end = withoutFence.indexOf(json) + json.length;
  return `${withoutFence.slice(0, start)}\n${withoutFence.slice(end)}`;
}
