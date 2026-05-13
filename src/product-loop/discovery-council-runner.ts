// src/product-loop/discovery-council-runner.ts
import type { CouncilDebateRunner, DebateChunk } from "./discovery-recommender.js";

// NOTE: DebatePlan + CouncilConfig shapes live in src/council/types.ts. We do not import them here
// to keep the discovery module decoupled; we mirror the shape via plain objects passed to runDebate.

export interface Big4PlanInput {
  questionId: string;
  contextSummary: string;
}

export function buildBig4DebatePlan(input: Big4PlanInput) {
  return {
    intentSummary: `Decide ${input.questionId}. Context: ${input.contextSummary}`,
    stances: [
      { name: "pragmatist", lens: "team skill, delivery speed, ecosystem maturity" },
      { name: "scaler", lens: "audience scale, performance, future growth" },
      { name: "cost-optimizer", lens: "infra cost, dev hours, total TCO" },
    ],
    outputShape: {
      primary: "string",
      alternatives: "string[]",
      rationale: "string",
    },
    plannedRounds: 1,
  };
}

export interface RealCouncilDeps {
  runDebate: (spec: any, config: any, llm: any) => AsyncIterable<any>;
  llm: any;
  leaderModelId: string;
  participants: any[];
}

export function buildDiscoveryDebateRunner(deps: RealCouncilDeps): CouncilDebateRunner {
  return {
    runDebate: ({ questionId, intentSummary, context }) => {
      const plan = buildBig4DebatePlan({
        questionId,
        contextSummary: intentSummary,
      });
      const spec = { idea: intentSummary, clarifications: [] };
      const config = {
        topic: questionId,
        conversationContext: JSON.stringify(context),
        leaderModelId: deps.leaderModelId,
        participants: deps.participants,
        debatePlan: plan,
        costAware: true,
      };
      return (async function* () {
        try {
          for await (const chunk of deps.runDebate(spec, config, deps.llm)) {
            // map StreamChunk → DebateChunk
            const mapped = mapStreamChunkToDebateChunk(chunk);
            if (mapped) yield mapped;
          }
        } catch (err) {
          throw err;
        }
      })();
    },
  };
}

function mapStreamChunkToDebateChunk(chunk: any): DebateChunk | null {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.kind === "stance-output" && chunk.stance) {
    return {
      type: "stance",
      name: chunk.stance,
      value: chunk.primary ?? chunk.value,
      rationale: chunk.rationale ?? "",
      confidence: chunk.confidence,
    };
  }
  if (chunk.kind === "cost" && typeof chunk.usd === "number") {
    return { type: "cost", costUsd: chunk.usd };
  }
  return null;
}
