import type { StreamChunk } from "../types/index.js";
import { COUNCIL_ROLE_COLORS, COUNCIL_COLOR_RESET, COUNCIL_COLOR_BG } from "../orchestrator/agent-options.js";
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

const ABSOLUTE_MAX_ROUNDS = 8;

export async function* runDebate(
  spec: ClarifiedSpec,
  config: CouncilConfig,
  llm: CouncilLLM,
): AsyncGenerator<StreamChunk, DebateState, unknown> {
  const { leaderModelId, participants, conversationContext, signal } = config;
  const active: CouncilParticipant[] = [];
  const exchangeLogs: Map<string, string[]> = new Map();
  let runningSummary = "";
  let researchFindings: string | undefined;

  // ── Leader decides: research needed? ───────────────────────────────────────
  const needsResearch = await evaluateResearchNeed(spec, leaderModelId, conversationContext, llm);

  if (needsResearch) {
    const p0Start = Date.now();
    yield { type: "content", content: "\n## Research Phase\n" };
    const researchCandidate = participants.find((c) => c.role === "research") ?? participants[0];
    yield { type: "content", content: `\n### \x1b[35m[research]\x1b[0m ${researchCandidate.model}\n` };

    researchFindings = await llm.research(
      researchCandidate.model,
      spec.problemStatement,
      conversationContext,
      signal,
    );
    yield { type: "content", content: `${researchFindings}\n` };
    yield { type: "content", content: `\n> Research: ${((Date.now() - p0Start) / 1000).toFixed(1)}s\n` };
  }

  const enrichedContext = researchFindings
    ? `${conversationContext}\n\n---\n\n## Research Findings\n${researchFindings}`
    : conversationContext;

  // ── Phase 1: Parallel opening statements ───────────────────────────────────
  const p1Start = Date.now();
  yield { type: "content", content: "\n## Opening Analysis\n" };

  const openingPromises = participants.map(({ role, model }) => {
    const partner = participants.find((c) => c.role !== role)?.role ?? "colleague";
    const { system, prompt } = buildOpeningPrompt({
      speakerRole: role,
      partnerRole: partner,
      spec,
      conversationContext: enrichedContext,
    });
    return llm
      .generate(model, system, prompt)
      .then((text) => ({ role, model, position: text, error: null as string | null }))
      .catch((err: unknown) => ({
        role,
        model,
        position: "",
        error: err instanceof Error ? err.message : String(err),
      }));
  });

  const openings = await Promise.all(openingPromises);

  for (const o of openings) {
    const roleColor = COUNCIL_ROLE_COLORS[o.role] ?? "";
    yield { type: "content", content: `\n### ${roleColor}[${o.role}]${COUNCIL_COLOR_RESET} ${o.model}\n` };
    if (o.error) {
      yield { type: "content", content: `[Error: ${o.error}]\n` };
    } else {
      active.push({ role: o.role as any, model: o.model, position: o.position });
      const bgColor = COUNCIL_COLOR_BG[o.role] ?? "";
      yield { type: "content", content: `${bgColor} ${o.role.toUpperCase()} ${COUNCIL_COLOR_RESET} ${o.position}\n` };
    }
  }

  yield { type: "content", content: `\n> Openings: ${active.length} participants, ${((Date.now() - p1Start) / 1000).toFixed(1)}s (parallel)\n` };

  if (active.length < 2) {
    yield { type: "content", content: "\nNot enough successful openings for discussion.\n" };
    return { spec, exchangeLogs, runningSummary: "", roundCount: 0, researchFindings };
  }

  // ── Phase 2: Dynamic discussion rounds ─────────────────────────────────────
  let roundCount = 0;

  for (let round = 1; round <= ABSOLUTE_MAX_ROUNDS; round++) {
    roundCount = round;
    const p2Start = Date.now();
    yield { type: "content", content: `\n## Discussion Round ${round}\n` };

    const pairs: Array<{ a: CouncilParticipant; b: CouncilParticipant; key: string }> = [];
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      const b = active[(i + 1) % active.length];
      const key = `${a.role}<>${b.role}`;
      if (!exchangeLogs.has(key)) exchangeLogs.set(key, []);
      pairs.push({ a, b, key });
    }

    const pairResults = await Promise.all(
      pairs.map(async ({ a, b, key }) => {
        const log = exchangeLogs.get(key)!;
        const chunks: Array<{ label: string; text: string }> = [];

        try {
          let aResponse: string;
          let bResponse: string;

          if (round === 1) {
            const aPrompt = buildResponsePrompt({
              speakerRole: a.role, partnerRole: b.role,
              speakerPosition: a.position, partnerPosition: b.position,
              spec,
            });
            aResponse = await llm.generate(a.model, aPrompt.system, aPrompt.prompt);
            log.push(`[${a.role}]: ${aResponse}`);
            chunks.push({ label: `[${a.role}] → [${b.role}]`, text: aResponse });

            const bPrompt = buildResponsePrompt({
              speakerRole: b.role, partnerRole: a.role,
              speakerPosition: b.position, partnerPosition: aResponse,
              spec,
            });
            bResponse = await llm.generate(b.model, bPrompt.system, bPrompt.prompt);
            log.push(`[${b.role}]: ${bResponse}`);
            chunks.push({ label: `[${b.role}] → [${a.role}]`, text: bResponse });
          } else {
            const historyText = log.join("\n\n");
            const aPrompt = buildFollowupPrompt({
              speakerRole: a.role, partnerRole: b.role,
              partnerPosition: b.position, exchangeHistory: historyText, round,
              runningSummary, spec,
            });
            aResponse = await llm.generate(a.model, aPrompt.system, aPrompt.prompt, 1536);
            log.push(`[${a.role}] (round ${round}): ${aResponse}`);
            chunks.push({ label: `[${a.role}] → [${b.role}]`, text: aResponse });

            const bPrompt = buildFollowupPrompt({
              speakerRole: b.role, partnerRole: a.role,
              partnerPosition: aResponse, exchangeHistory: historyText, round,
              runningSummary, spec,
            });
            bResponse = await llm.generate(b.model, bPrompt.system, bPrompt.prompt, 1536);
            log.push(`[${b.role}] (round ${round}): ${bResponse}`);
            chunks.push({ label: `[${b.role}] → [${a.role}]`, text: bResponse });
          }

          b.position = bResponse;
          a.position = aResponse;
          return { key, chunks, error: null as string | null };
        } catch (err: unknown) {
          return { key, chunks, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );

    for (const pr of pairResults) {
      for (const chunk of pr.chunks) {
        const labelParts = chunk.label.match(/\[(\w+)\] → \[(\w+)\]/);
        let coloredLabel = chunk.label;
        if (labelParts) {
          const fromColor = COUNCIL_ROLE_COLORS[labelParts[1]] ?? "";
          const toColor = COUNCIL_ROLE_COLORS[labelParts[2]] ?? "";
          coloredLabel = `${fromColor}[${labelParts[1]}]${COUNCIL_COLOR_RESET} → ${toColor}[${labelParts[2]}]${COUNCIL_COLOR_RESET}`;
        }
        yield { type: "content", content: `\n### ${coloredLabel}\n${chunk.text}\n` };
      }
      if (pr.error) {
        yield { type: "content", content: `[Discussion error: ${pr.error}]\n` };
      }
    }

    yield { type: "content", content: `\n> Round ${round}: ${((Date.now() - p2Start) / 1000).toFixed(1)}s (${pairs.length} pairs)\n` };

    // ── Leader evaluation (replaces self-evaluated convergence) ──────────────
    const allExchangeText = [...exchangeLogs.values()].flat().slice(-8).join("\n\n");
    const evaluation = await evaluateDebate(spec, allExchangeText, round, leaderModelId, llm);

    if (evaluation) {
      const metCount = evaluation.criteriaStatus.filter((c) => c.met).length;
      const total = evaluation.criteriaStatus.length;
      yield { type: "content", content: `\n> **Leader evaluation:** ${metCount}/${total} criteria met — ${evaluation.reason}\n` };

      if (evaluation.needsResearch && evaluation.researchQuery) {
        yield { type: "content", content: `\n> Leader requested mid-debate research: ${evaluation.researchQuery}\n` };
        const researchCandidate = participants.find((c) => c.role === "research") ?? participants[0];
        const findings = await llm.research(researchCandidate.model, evaluation.researchQuery, enrichedContext, signal);
        yield { type: "content", content: `\n### Mid-debate Research\n${findings}\n` };
        for (const log of exchangeLogs.values()) {
          log.push(`[research findings]: ${findings}`);
        }
      }

      if (!evaluation.shouldContinue) {
        yield { type: "content", content: `\n> Leader decided: debate sufficient at round ${round}.\n` };
        break;
      }
    }

    // Generate inter-round summary
    if (round < ABSOLUTE_MAX_ROUNDS) {
      try {
        const allEx = [...exchangeLogs.values()].flat().slice(-6).join("\n\n");
        const { system, prompt } = buildRoundSummaryPrompt(allEx, spec.problemStatement, round);
        runningSummary = await llm.generate(active[0].model, system, prompt, 512);
        yield { type: "content", content: `\n> **Discussion state:** ${runningSummary.split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ")}\n` };
      } catch {
        // Non-critical
      }
    }
  }

  return { spec, exchangeLogs, runningSummary, roundCount, researchFindings };
}

async function evaluateResearchNeed(
  spec: ClarifiedSpec,
  leaderModelId: string,
  conversationContext: string,
  llm: CouncilLLM,
): Promise<boolean> {
  try {
    const raw = await llm.generate(
      leaderModelId,
      `You are deciding whether a codebase research phase is needed before a multi-expert discussion.\n` +
        `If the discussion topic requires knowledge of specific files, functions, errors, or configurations in the codebase, answer true.\n` +
        `If the discussion is about general strategy, architecture concepts, or trade-offs that don't need codebase data, answer false.\n` +
        `Output ONLY: {"needsResearch": true/false, "reason": "one sentence"}`,
      `Topic: ${spec.problemStatement}\nConstraints: ${spec.constraints.join("; ")}\nContext: ${conversationContext.slice(0, 3000)}`,
      256,
    );
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

async function evaluateDebate(
  spec: ClarifiedSpec,
  exchangeText: string,
  round: number,
  leaderModelId: string,
  llm: CouncilLLM,
): Promise<LeaderEvaluation | null> {
  try {
    const { system, prompt } = buildLeaderEvaluationPrompt({ spec, exchangeLogs: exchangeText, round });
    const raw = await llm.generate(leaderModelId, system, prompt, 1024);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Partial<LeaderEvaluation>;
      return {
        allCriteriaMet: parsed.allCriteriaMet ?? false,
        criteriaStatus: parsed.criteriaStatus ?? [],
        unresolvedPoints: parsed.unresolvedPoints ?? [],
        needsResearch: parsed.needsResearch ?? false,
        researchQuery: parsed.researchQuery,
        shouldContinue: parsed.shouldContinue ?? true,
        reason: parsed.reason ?? "",
      };
    }
  } catch {
    // Continue debate if evaluation fails
  }
  return null;
}
