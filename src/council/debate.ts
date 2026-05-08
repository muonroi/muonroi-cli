import type { StreamChunk } from "../types/index.js";
import type {
  ClarifiedSpec,
  CouncilConfig,
  CouncilLLM,
  CouncilParticipant,
  DebateState,
  LeaderEvaluation,
} from "./types.js";
import {
  buildOpeningPrompt,
  buildResponsePrompt,
  buildFollowupPrompt,
  buildLeaderEvaluationPrompt,
  buildRoundSummaryPrompt,
} from "./prompts.js";
import { tracedAsync, tracedGenerate } from "./llm.js";
import { phaseDone, phaseStart } from "./phase-events.js";

const ABSOLUTE_MAX_ROUNDS = 8;

export async function* runDebate(
  spec: ClarifiedSpec,
  config: CouncilConfig,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, DebateState, unknown> {
  const { leaderModelId, participants, conversationContext, signal, debatePlan } = config;
  const active: CouncilParticipant[] = [];
  const exchangeLogs: Map<string, string[]> = new Map();
  let runningSummary = "";
  let researchFindings: string | undefined;

  // ── Leader decides: research needed? ───────────────────────────────────────
  const needsResearch = yield* evaluateResearchNeed(spec, leaderModelId, conversationContext, llm);

  if (needsResearch) {
    const p0Start = Date.now();
    const researchCandidate = participants.find((c) => c.role === "research") ?? participants[0];
    yield phaseStart({
      phaseId: "phase:research",
      kind: "research",
      label: "Research",
      detail: `via ${researchCandidate.model}`,
    });

    const researchTraces: string[] = [];
    researchFindings = yield* tracedAsync(
      () => llm.research(researchCandidate.model, spec.problemStatement, conversationContext, signal, (t) => researchTraces.push(t)),
      {
        phase: "research",
        label: "Researching codebase",
        detail: spec.problemStatement.slice(0, 80),
        role: "research",
      },
    );
    // CQ-22: emit research tool traces as council_status
    for (const trace of researchTraces) {
      yield { type: "council_status" as const, content: trace };
    }
    yield phaseDone({
      phaseId: "phase:research",
      kind: "research",
      label: "Research",
      startedAt: p0Start,
      detail: `via ${researchCandidate.model}`,
    });
    yield { type: "content", content: `\n### Research findings\n${researchFindings}\n` };
  }

  const enrichedContext = researchFindings
    ? `${conversationContext}\n\n---\n\n## Research Findings\n${researchFindings}`
    : conversationContext;

  // ── Phase 1: Parallel opening statements ───────────────────────────────────
  const p1Start = Date.now();
  yield phaseStart({
    phaseId: "phase:opening",
    kind: "opening",
    label: "Opening analysis",
    detail: `${participants.length} participants in parallel`,
  });

  const openingPromises = participants.map((self) => {
    const partner = participants.find((c) => c.role !== self.role) ?? participants[0];
    const { system, prompt } = buildOpeningPrompt({
      speakerRole: self.role,
      partnerRole: partner.role,
      speakerStance: self.stance,
      partnerStance: partner.stance,
      spec,
      outputShape: debatePlan?.outputShape,
      conversationContext: enrichedContext,
    });
    return llm
      .generate(self.model, system, prompt)
      .then((text) => ({ role: self.role, model: self.model, stance: self.stance, position: text, error: null as string | null }))
      .catch((err: unknown) => ({
        role: self.role,
        model: self.model,
        stance: self.stance,
        position: "",
        error: err instanceof Error ? err.message : String(err),
      }));
  });

  const openings = yield* tracedAsync(() => Promise.all(openingPromises), {
    phase: "opening",
    label: `Generating opening statements (${participants.length} participants in parallel)`,
    detail: participants.map((p) => p.role).join(", "),
  });

  yield { type: "content", content: "\n## Opening Analysis\n" };
  for (const o of openings) {
    const heading = o.stance ? `${o.stance.name} (\`${o.role}\` · ${o.model})` : `\`[${o.role}]\` ${o.model}`;
    yield { type: "content", content: `\n### ${heading}\n` };
    if (o.error) {
      yield { type: "content", content: `[Error: ${o.error}]\n` };
    } else {
      active.push({ role: o.role as any, model: o.model, position: o.position, stance: o.stance });
      yield { type: "content", content: `${o.position}\n` };
    }
  }

  yield phaseDone({
    phaseId: "phase:opening",
    kind: "opening",
    label: "Opening analysis",
    startedAt: p1Start,
    detail: `${active.length}/${participants.length} participants succeeded`,
  });

  if (active.length < 2) {
    yield { type: "content", content: "\nNot enough successful openings for discussion.\n" };
    return { spec, exchangeLogs, runningSummary: "", roundCount: 0, researchFindings, active };
  }

  // ── Phase 2: Dynamic discussion rounds ─────────────────────────────────────
  let roundCount = 0;

  for (let round = 1; round <= ABSOLUTE_MAX_ROUNDS; round++) {
    roundCount = round;
    const p2Start = Date.now();
    const roundPhaseId = `phase:round-${round}`;
    yield phaseStart({
      phaseId: roundPhaseId,
      kind: "round",
      label: `Discussion round ${round}`,
    });

    const pairs: Array<{ a: CouncilParticipant; b: CouncilParticipant; key: string }> = [];
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      const b = active[(i + 1) % active.length];
      const key = `${a.role}<>${b.role}`;
      if (!exchangeLogs.has(key)) exchangeLogs.set(key, []);
      pairs.push({ a, b, key });
    }

    const pairResults = yield* tracedAsync(
      () => Promise.all(
        pairs.map(async ({ a, b, key }) => {
        const log = exchangeLogs.get(key)!;
        const chunks: Array<{ label: string; text: string; toolCalls?: Array<{ toolName: string; result?: unknown }>; traces?: string[] }> = [];

        try {
          let aResponse: string;
          let bResponse: string;
          let aToolCalls: Array<{ toolName: string; result?: unknown }> = [];
          let bToolCalls: Array<{ toolName: string; result?: unknown }> = [];

          const aLabel = a.stance?.name ?? a.role;
          const bLabel = b.stance?.name ?? b.role;
          if (round === 1) {
            const aPrompt = buildResponsePrompt({
              speakerRole: a.role, partnerRole: b.role,
              speakerStance: a.stance, partnerStance: b.stance,
              speakerPosition: a.position, partnerPosition: b.position,
              spec,
            });
            const aTraces: string[] = [];
            const aResult = await llm.debate(a.model, aPrompt.system, aPrompt.prompt, signal, (t) => aTraces.push(t));
            aResponse = aResult.text;
            aToolCalls = aResult.toolCalls;
            log.push(`[${aLabel}]: ${aResponse}`);
            chunks.push({ label: `[${aLabel}] → [${bLabel}]`, text: aResponse, toolCalls: aToolCalls, traces: aTraces });

            const bPrompt = buildResponsePrompt({
              speakerRole: b.role, partnerRole: a.role,
              speakerStance: b.stance, partnerStance: a.stance,
              speakerPosition: b.position, partnerPosition: aResponse,
              spec,
            });
            const bTraces: string[] = [];
            const bResult = await llm.debate(b.model, bPrompt.system, bPrompt.prompt, signal, (t) => bTraces.push(t));
            bResponse = bResult.text;
            bToolCalls = bResult.toolCalls;
            log.push(`[${bLabel}]: ${bResponse}`);
            chunks.push({ label: `[${bLabel}] → [${aLabel}]`, text: bResponse, toolCalls: bToolCalls, traces: bTraces });
          } else {
            const historyText = log.join("\n\n");
            const aPrompt = buildFollowupPrompt({
              speakerRole: a.role, partnerRole: b.role,
              speakerStance: a.stance, partnerStance: b.stance,
              partnerPosition: b.position, exchangeHistory: historyText, round,
              runningSummary, spec,
            });
            const aTraces: string[] = [];
            const aResult = await llm.debate(a.model, aPrompt.system, aPrompt.prompt, signal, (t) => aTraces.push(t));
            aResponse = aResult.text;
            aToolCalls = aResult.toolCalls;
            log.push(`[${aLabel}] (round ${round}): ${aResponse}`);
            chunks.push({ label: `[${aLabel}] → [${bLabel}]`, text: aResponse, toolCalls: aToolCalls, traces: aTraces });

            const bPrompt = buildFollowupPrompt({
              speakerRole: b.role, partnerRole: a.role,
              speakerStance: b.stance, partnerStance: a.stance,
              partnerPosition: aResponse, exchangeHistory: historyText, round,
              runningSummary, spec,
            });
            const bTraces: string[] = [];
            const bResult = await llm.debate(b.model, bPrompt.system, bPrompt.prompt, signal, (t) => bTraces.push(t));
            bResponse = bResult.text;
            bToolCalls = bResult.toolCalls;
            log.push(`[${bLabel}] (round ${round}): ${bResponse}`);
            chunks.push({ label: `[${bLabel}] → [${aLabel}]`, text: bResponse, toolCalls: bToolCalls, traces: bTraces });
          }

          b.position = bResponse;
          a.position = aResponse;
          return { key, chunks, error: null as string | null };
        } catch (err: unknown) {
          return { key, chunks, error: err instanceof Error ? err.message : String(err) };
        }
      }),
      ),
      {
        phase: "exchange",
        label: `Discussion round ${round} (${pairs.length} pair${pairs.length === 1 ? "" : "s"})`,
        detail: pairs.map((p) => `${p.a.role}↔${p.b.role}`).join(", "),
      },
    );

    yield { type: "content", content: `\n## Discussion Round ${round}\n` };
    for (const pr of pairResults) {
      for (const chunk of pr.chunks) {
        const labelParts = chunk.label.match(/\[(\w+)\] → \[(\w+)\]/);
        const cleanLabel = labelParts
          ? `\`[${labelParts[1]}]\` → \`[${labelParts[2]}]\``
          : chunk.label;
        yield { type: "content", content: `\n### ${cleanLabel}\n${chunk.text}\n` };
        // CQ-22: emit tool traces as council_status for orchestrator persistence
        for (const trace of chunk.traces ?? []) {
          yield { type: "council_status" as const, content: trace };
        }
      }
      if (pr.error) {
        yield { type: "content", content: `[Discussion error: ${pr.error}]\n` };
      }
    }

    yield phaseDone({
      phaseId: roundPhaseId,
      kind: "round",
      label: `Discussion round ${round}`,
      startedAt: p2Start,
      detail: `${pairs.length} pair${pairs.length === 1 ? "" : "s"} exchanged`,
    });

    // ── Per-round persistence: emit [Council Round N] system message ──────────
    const roundSummaryText = pairResults
      .flatMap((pr) => pr.chunks)
      .map((c) => {
        const toolSuffix = c.toolCalls?.length
          ? ` [tools: ${c.toolCalls.map((t) => t.toolName).join(", ")}]`
          : "";
        return `${c.label}: ${c.text}${toolSuffix}`;
      })
      .join("\n\n");
    const roundPersistText = `[Council Round ${round}]\n${roundSummaryText}`;
    // Emit as council_status so orchestrator layer can persist [Council Round N] to conversation DB
    yield { type: "council_status" as const, content: roundPersistText };

    // ── Leader evaluation (replaces self-evaluated convergence) ──────────────
    const evalPhaseId = `phase:evaluation-${round}`;
    const evalStart = Date.now();
    yield phaseStart({
      phaseId: evalPhaseId,
      kind: "evaluation",
      label: `Leader evaluation (round ${round})`,
    });
    const allExchangeText = [...exchangeLogs.values()].flat().slice(-8).join("\n\n");
    const evaluation = yield* evaluateDebate(spec, allExchangeText, round, leaderModelId, llm);

    if (evaluation) {
      const metCount = evaluation.criteriaStatus.filter((c) => c.met).length;
      const total = evaluation.criteriaStatus.length;
      yield phaseDone({
        phaseId: evalPhaseId,
        kind: "evaluation",
        label: `Leader evaluation (round ${round})`,
        startedAt: evalStart,
        detail: `${metCount}/${total} criteria met · ${evaluation.reason.slice(0, 80)}`,
      });
      yield {
        type: "content",
        content: `\n> **Leader evaluation:** ${metCount}/${total} criteria met — ${evaluation.reason}\n`,
      };

      if (evaluation.needsResearch && evaluation.researchQuery) {
        const midPhaseId = `phase:mid-research-${round}`;
        const midStart = Date.now();
        yield phaseStart({
          phaseId: midPhaseId,
          kind: "mid_research",
          label: "Mid-debate research",
          detail: evaluation.researchQuery.slice(0, 80),
        });
        const researchCandidate = participants.find((c) => c.role === "research") ?? participants[0];
        const midTraces: string[] = [];
        const findings = yield* tracedAsync(
          () => llm.research(researchCandidate.model, evaluation.researchQuery!, enrichedContext, signal, (t) => midTraces.push(t)),
          {
            phase: "research",
            label: "Mid-debate research",
            detail: evaluation.researchQuery.slice(0, 80),
            role: "research",
          },
        );
        // CQ-22: emit mid-debate research tool traces
        for (const trace of midTraces) {
          yield { type: "council_status" as const, content: trace };
        }
        yield phaseDone({
          phaseId: midPhaseId,
          kind: "mid_research",
          label: "Mid-debate research",
          startedAt: midStart,
          detail: evaluation.researchQuery.slice(0, 80),
        });
        yield { type: "content", content: `\n### Mid-debate Research\n${findings}\n` };
        for (const log of exchangeLogs.values()) {
          log.push(`[research findings]: ${findings}`);
        }
      }

      if (!evaluation.shouldContinue) {
        yield {
          type: "content",
          content: `\n> Leader decided: debate sufficient at round ${round}.\n`,
        };
        break;
      }
    } else {
      yield phaseDone({
        phaseId: evalPhaseId,
        kind: "evaluation",
        label: `Leader evaluation (round ${round})`,
        startedAt: evalStart,
        detail: "evaluation unavailable — continuing",
      });
    }

    // Generate inter-round summary
    if (round < ABSOLUTE_MAX_ROUNDS) {
      const sumPhaseId = `phase:summary-${round}`;
      const sumStart = Date.now();
      yield phaseStart({
        phaseId: sumPhaseId,
        kind: "summary",
        label: `Round ${round} summary`,
      });
      try {
        const allEx = [...exchangeLogs.values()].flat().slice(-6).join("\n\n");
        const { system, prompt } = buildRoundSummaryPrompt(allEx, spec.problemStatement, round);
        runningSummary = yield* tracedGenerate(llm, {
          phase: "summary",
          label: `Summarizing round ${round}`,
          modelId: active[0].model,
          system,
          prompt,
          maxTokens: 512,
        });
        const headline = runningSummary.split("\n").filter((l) => l.trim()).slice(0, 1).join(" ").slice(0, 100);
        yield phaseDone({
          phaseId: sumPhaseId,
          kind: "summary",
          label: `Round ${round} summary`,
          startedAt: sumStart,
          detail: headline,
        });
      } catch {
        yield phaseDone({
          phaseId: sumPhaseId,
          kind: "summary",
          label: `Round ${round} summary`,
          startedAt: sumStart,
          detail: "skipped",
        });
      }
    }
  }

  return { spec, exchangeLogs, runningSummary, roundCount, researchFindings, active };
}

async function* evaluateResearchNeed(
  spec: ClarifiedSpec,
  leaderModelId: string,
  conversationContext: string,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, boolean, unknown> {
  try {
    const raw = yield* tracedGenerate(llm, {
      phase: "evaluate",
      label: "Leader deciding if research is needed",
      modelId: leaderModelId,
      system:
        `You are deciding whether a codebase research phase is needed before a multi-expert discussion.\n` +
        `If the discussion topic requires knowledge of specific files, functions, errors, or configurations in the codebase, answer true.\n` +
        `If the discussion is about general strategy, architecture concepts, or trade-offs that don't need codebase data, answer false.\n` +
        `Output ONLY: {"needsResearch": true/false, "reason": "one sentence"}`,
      prompt: `Topic: ${spec.problemStatement}\nConstraints: ${spec.constraints.join("; ")}\nContext: ${conversationContext.slice(0, 3000)}`,
      maxTokens: 256,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { needsResearch?: boolean };
      return parsed.needsResearch === true;
    }
  } catch {
    // Default to research for safety
  }
  return true;
}

async function* evaluateDebate(
  spec: ClarifiedSpec,
  exchangeText: string,
  round: number,
  leaderModelId: string,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, LeaderEvaluation | null, unknown> {
  try {
    const { system, prompt } = buildLeaderEvaluationPrompt({ spec, exchangeLogs: exchangeText, round });
    const raw = yield* tracedGenerate(llm, {
      phase: "evaluate",
      label: `Leader evaluating round ${round}`,
      modelId: leaderModelId,
      system,
      prompt,
      maxTokens: 1024,
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<LeaderEvaluation>;

      const citationCount = countCitations(exchangeText);
      const claimCount = estimateClaims(exchangeText);
      const evidenceDensity = citationCount / claimCount;
      const disagreementResolved = citationCount;

      let needsResearch = parsed.needsResearch ?? false;
      let researchQuery = parsed.researchQuery;
      if (!needsResearch && round >= 2 && evidenceDensity < 0.3) {
        needsResearch = true;
        researchQuery = `Verify claims from debate round ${round} on: ${spec.problemStatement.slice(0, 80)}`;
      }

      return {
        allCriteriaMet: parsed.allCriteriaMet ?? false,
        criteriaStatus: parsed.criteriaStatus ?? [],
        unresolvedPoints: parsed.unresolvedPoints ?? [],
        needsResearch,
        researchQuery,
        shouldContinue: parsed.shouldContinue ?? true,
        reason: parsed.reason ?? "",
        evidenceDensity,
        disagreementResolved,
      };
    }
  } catch {
    // Continue debate if evaluation fails
  }
  return null;
}

function countCitations(text: string): number {
  const matches = text.match(/\[(REFUTED|CONFIRMED) via [^\]]+\]/g);
  return matches?.length ?? 0;
}

function estimateClaims(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10);
  return Math.max(sentences.length, 1);
}
