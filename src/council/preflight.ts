import type { StreamChunk } from "../types/index.js";
import type { ClarifiedSpec, PreflightResponder } from "./types.js";

export async function* runPreflight(
  spec: ClarifiedSpec,
  participants: Array<{ role: string; model: string }>,
  researchNeeded: boolean,
  respondToPreflight: PreflightResponder,
): AsyncGenerator<StreamChunk, boolean, unknown> {
  const preflightId = crypto.randomUUID();

  yield { type: "content", content: "\n## Phase B — Pre-flight Review\n" };

  const summary =
    `### Discussion Brief\n\n` +
    `**Problem:** ${spec.problemStatement}\n\n` +
    `**Constraints:**\n${spec.constraints.map((c) => `- ${c}`).join("\n") || "- None specified"}\n\n` +
    `**Success Criteria:**\n${spec.successCriteria.map((c) => `- ${c}`).join("\n")}\n\n` +
    `**Scope:** ${spec.scope || "Not specified"}\n\n` +
    `**Participants:**\n${participants.map((p) => `- **${p.role}**: ${p.model}`).join("\n")}\n\n` +
    `**Research phase:** ${researchNeeded ? "Yes — will investigate codebase first" : "No — proceeding directly to debate"}\n`;

  yield { type: "content", content: summary };

  yield {
    type: "council_preflight" as StreamChunk["type"],
    content: "Review the discussion brief above. Approve to start debate, or reject to revise.",
    councilPreflight: {
      preflightId,
      problemStatement: spec.problemStatement,
      constraints: spec.constraints,
      successCriteria: spec.successCriteria,
      scope: spec.scope,
      participants,
      researchNeeded,
    },
  };

  const approved = await respondToPreflight(preflightId);

  if (approved) {
    yield { type: "content", content: "\n> ✓ Pre-flight approved. Starting debate.\n" };
  } else {
    yield { type: "content", content: "\n> ✗ Pre-flight rejected. Returning to clarification.\n" };
  }

  return approved;
}
