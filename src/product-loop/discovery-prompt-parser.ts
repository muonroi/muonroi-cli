// src/product-loop/discovery-prompt-parser.ts
import { validateAnswer } from "./discovery-schema.js";
import type { DiscoveryContext } from "./types.js";

export interface LeaderLike {
  generate: (args: {
    system: string;
    prompt: string;
    maxTokens: number;
  }) => Promise<{ content: string; costUsd: number }>;
}

const KNOWN_FIELDS: Array<keyof DiscoveryContext> = [
  "productType",
  "targetPlatform",
  "audience",
  "backendArchitecture",
  "backendStack",
  "dbStrategy",
  "frontendApproach",
  "baStatus",
  "designStatus",
  "deployment",
];

const SYSTEM_PROMPT =
  "You extract structured product context from a user's free-form idea description. " +
  "Output ONLY a single JSON object. No prose, no markdown. " +
  "Include only fields the idea explicitly states or strongly implies. Omit unknowns.";

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
}

function projectKnownFields(parsed: any): Partial<DiscoveryContext> {
  const out: Partial<DiscoveryContext> = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const field of KNOWN_FIELDS) {
    if (parsed[field] === undefined) continue;
    const check = validateAnswer(field, parsed[field]);
    if (check.ok) {
      (out as any)[field] = parsed[field];
    }
  }
  return out;
}

async function tryParse(
  idea: string,
  leader: LeaderLike,
): Promise<{ partial: Partial<DiscoveryContext>; costUsd: number; ok: boolean }> {
  let costUsd = 0;
  try {
    const res = await leader.generate({
      system: SYSTEM_PROMPT,
      prompt: `Idea: ${idea}\n\nReturn JSON with only the fields supported in DiscoveryContext.`,
      maxTokens: 1024,
    });
    costUsd = res.costUsd;
    const parsed = JSON.parse(stripCodeFences(res.content));
    return { partial: projectKnownFields(parsed), costUsd, ok: true };
  } catch {
    return { partial: {}, costUsd, ok: false };
  }
}

export async function parsePromptForContext(
  idea: string,
  leader: LeaderLike,
): Promise<{ partial: Partial<DiscoveryContext>; costUsd: number }> {
  if (!idea || idea.trim() === "") return { partial: {}, costUsd: 0 };
  const first = await tryParse(idea, leader);
  if (first.ok) return { partial: first.partial, costUsd: first.costUsd };
  // one retry
  const second = await tryParse(idea, leader);
  return { partial: second.partial, costUsd: first.costUsd + second.costUsd };
}
