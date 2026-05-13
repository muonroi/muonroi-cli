// src/product-loop/discovery-recommender.ts

import type { LeaderLike } from "./discovery-prompt-parser.js";
import type { DiscoveryQuestion } from "./discovery-schema.js";
import type { DiscoveryContext, ExistingProjectSignals, RecommendationEntry } from "./types.js";

export interface RecommendInput {
  question: DiscoveryQuestion;
  context: Partial<DiscoveryContext>;
  detection: ExistingProjectSignals;
  priorRunsDigest?: string;
}

export interface RecommendOutput {
  primary: { value: any; rationale: string };
  alternatives: { value: any; rationale: string }[];
  source: "leader" | "council" | "user-only";
  costUsd: number;
  debateRef?: string;
  tiebreakUsed?: boolean;
  synthFailed?: boolean;
}

const LEADER_SYSTEM =
  "You are a product context recommender. Output ONE JSON object with shape: " +
  '{"primary":{"value":<any>,"rationale":"<short>"},"alternatives":[{"value":<any>,"rationale":"<short>"}]} ' +
  "with up to 2 alternatives. No prose, no fences.";

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
}

function parseLeaderResponse(raw: string): { primary: any; alternatives: any[] } | null {
  try {
    const parsed = JSON.parse(stripFences(raw));
    if (!parsed?.primary?.value || typeof parsed.primary.rationale !== "string") return null;
    const alts = Array.isArray(parsed.alternatives) ? parsed.alternatives.slice(0, 2) : [];
    return { primary: parsed.primary, alternatives: alts };
  } catch {
    return null;
  }
}

export async function leaderRecommend(input: RecommendInput, leader: LeaderLike): Promise<RecommendOutput> {
  const prompt = buildLeaderPrompt(input);
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await leader.generate({ system: LEADER_SYSTEM, prompt, maxTokens: 1024 });
      cost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "leader",
          costUsd: cost,
        };
      }
    } catch {
      /* retry */
    }
  }
  return {
    primary: { value: null, rationale: "leader unavailable; awaiting user" },
    alternatives: [],
    source: "user-only",
    costUsd: cost,
  };
}

function buildLeaderPrompt(input: RecommendInput): string {
  return [
    `Question: ${input.question.prompt}`,
    `Field id: ${input.question.id}`,
    `Detected project: ${input.detection.classification} (${input.detection.languages?.join(", ") || "no languages"})`,
    `Context so far: ${JSON.stringify(input.context)}`,
    input.priorRunsDigest ? `Prior similar runs: ${input.priorRunsDigest}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function toEntry(out: RecommendOutput): RecommendationEntry {
  return {
    chosen: out.primary.value,
    alternatives: out.alternatives.map((a) => a.value),
    rationale: out.primary.rationale,
    source: out.source,
    debateRef: out.debateRef,
    tiebreakUsed: out.tiebreakUsed,
    synthFailed: out.synthFailed,
  };
}
