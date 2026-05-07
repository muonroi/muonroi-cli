import * as path from "node:path";
import type { StreamChunk } from "../types/index.js";
import { runClarification } from "../council/clarifier.js";
import { runDebate } from "../council/debate.js";
import { runPreflight } from "../council/preflight.js";
import { phaseStart } from "../council/phase-events.js";
import { SEED_DIMENSIONS } from "./seed-questions.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import type { DriverContext, DriverResult, Stage, ProductSpec } from "./types.js";
import type { ClarifiedSpec, DebateState } from "../council/types.js";

export async function* runLoopDriver(ctx: DriverContext): AsyncGenerator<StreamChunk, DriverResult, unknown> {
  let state: Stage = "idle";
  let clarifiedSpec: ClarifiedSpec | undefined;
  let debateState: DebateState | undefined;
  
  const runDir = path.join(ctx.flowDir, "runs", ctx.runId);

  while (true) {
    switch (state) {
      case "idle": {
        state = "gather";
        break;
      }

      case "gather": {
        yield phaseStart({
          phaseId: "loop:gather",
          kind: "clarification",
          label: "Gathering Product Context",
        });

        // Write Resume Digest to state.md
        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        stateMap.sections.set("Resume Digest", "Stage: Gather - Defining product dimensions");
        await writeArtifact(runDir, "state.md", stateMap);

        const clarifierGen = runClarification(
          ctx.idea,
          "leader", 
          "",
          ctx.respondToQuestion,
          ctx.llm,
          undefined,
          SEED_DIMENSIONS,
          6 // maxRounds
        );
        
        while (true) {
           const { value, done } = await clarifierGen.next();
           if (done) {
             clarifiedSpec = value as ClarifiedSpec;
             break;
           }
           yield value as StreamChunk;
        }

        // Confidence metric: unresolvedDimensions.length
        const unresolvedDimensionsCount = SEED_DIMENSIONS.filter(
          d => clarifiedSpec?.resolved?.[d.id] !== "answered"
        ).length;

        if (unresolvedDimensionsCount <= 1) {
          // Write resolved dimensions to gray-areas.md
          const grayMap = (await readArtifact(runDir, "gray-areas.md")) ?? { preamble: "", sections: new Map() };
          for (const qa of clarifiedSpec.rawQA) {
            grayMap.sections.set(qa.question, qa.answer);
          }
          await writeArtifact(runDir, "gray-areas.md", grayMap);
          
          state = "research";
        } else {
          yield {
            type: "council_question",
            content: "Insufficient resolution. Please provide manual answers for the missing dimensions.",
            councilQuestion: {
              questionId: "manual-answers",
              phase: "clarify",
              question: "Please provide manual answers for the missing dimensions.",
              isRequired: true,
              options: [],
            }
          } as StreamChunk;
          return { runId: ctx.runId, stage: "halted", success: false, reason: "insufficient_resolution" };
        }
        break;
      }

      case "research": {
        if (!clarifiedSpec) {
          return { runId: ctx.runId, stage: "error", success: false, reason: "missing_spec_for_research" };
        }

        yield phaseStart({
          phaseId: "loop:research",
          kind: "research",
          label: "Research & Debate",
        });

        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        stateMap.sections.set("Resume Digest", "Stage: Research - Multi-expert debate");
        await writeArtifact(runDir, "state.md", stateMap);

        const stances = [
          { name: "Researcher", lens: "Focus on technical implementation details and codebase constraints" },
          { name: "Cost-Controller", lens: "Focus on budget, resources, and complexity trade-offs" },
          { name: "Skeptic", lens: "Focus on identifying risks, edge cases, and potential points of failure" },
          { name: "Architect", lens: "Focus on high-level structure, scalability, and long-term maintainability" },
        ];

        const participants = stances.map(s => ({
          role: (s.name === "Researcher" ? "research" : "leader") as any,
          model: "leader", // TODO: resolve real model
          position: "",
          stance: s
        }));

        const debateGen = runDebate(
          clarifiedSpec,
          {
            topic: ctx.idea,
            conversationContext: "",
            leaderModelId: "leader",
            participants,
          },
          ctx.llm
        );

        while (true) {
          const { value, done } = await debateGen.next();
          if (done) {
            debateState = value as DebateState;
            break;
          }
          yield value as StreamChunk;
        }

        // Append research summary to delegations.md
        const delegationsMap = (await readArtifact(runDir, "delegations.md")) ?? { preamble: "", sections: new Map() };
        delegationsMap.sections.set("Research Summary", debateState.runningSummary);
        if (debateState.researchFindings) {
          delegationsMap.sections.set("Research Findings", debateState.researchFindings);
        }
        await writeArtifact(runDir, "delegations.md", delegationsMap);

        state = "scoping";
        break;
      }
      
      case "scoping": {
        if (!clarifiedSpec || !debateState) {
          return { runId: ctx.runId, stage: "error", success: false, reason: "missing_state_for_scoping" };
        }

        yield phaseStart({
          phaseId: "loop:scoping",
          kind: "synthesis",
          label: "Scoping & Synthesis",
        });

        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        stateMap.sections.set("Resume Digest", "Stage: Scoping - Synthesizing product roadmap");
        await writeArtifact(runDir, "state.md", stateMap);

        // Synthesize ProductSpec
        const synthesisPrompt = `Synthesize a ProductSpec JSON based on the following:
Idea: ${ctx.idea}
Clarified Spec: ${JSON.stringify(clarifiedSpec)}
Debate Summary: ${debateState.runningSummary}
Research Findings: ${debateState.researchFindings ?? "N/A"}

Output ONLY a JSON object matching this interface:
interface ProductSpec {
  idea: string;
  persona: string;
  mvp: string[];
  phase2: string[];
  architecture: string;
  ioContract: string;
  folderStructure: string;
  sprintEstimate: number;
  costEstimate: number;
}
`;
        const rawSpec = await ctx.llm.generate("leader", "You are a Product Owner synthesizing a technical specification.", synthesisPrompt);
        let productSpec: ProductSpec;
        try {
          const match = rawSpec.match(/\{[\s\S]*\}/);
          productSpec = match ? JSON.parse(match[0]) : ({} as ProductSpec);
          productSpec.createdAt = new Date();
        } catch (err) {
          return { runId: ctx.runId, stage: "error", success: false, reason: "failed_to_synthesize_spec" };
        }

        // Write ProductSpec to roadmap.md
        const roadmapMap = (await readArtifact(runDir, "roadmap.md")) ?? { preamble: "", sections: new Map() };
        roadmapMap.sections.set("Product Specification", JSON.stringify(productSpec, null, 2));
        await writeArtifact(runDir, "roadmap.md", roadmapMap);

        // runPreflight
        const participants = debateState.spec.rawQA.length > 0 ? [{ role: "PO", model: "leader" }] : []; // Mocking
        const preflightGen = runPreflight(
          clarifiedSpec,
          debateState.spec.rawQA.map(() => ({ role: "expert", model: "leader" })), // Mocking
          !!debateState.researchFindings,
          ctx.respondToPreflight
        );

        let approved = false;
        while (true) {
          const { value, done } = await preflightGen.next();
          if (done) {
            approved = value as boolean;
            break;
          }
          yield value as StreamChunk;
        }

        if (approved) {
          state = "approved";
        } else {
          state = "halted";
          return { runId: ctx.runId, stage: "halted", success: false, reason: "user_rejected_spec" };
        }
        break;
      }

      case "approved": {
        yield { type: "content", content: "Ready to sprint!" } as StreamChunk;
        return { runId: ctx.runId, stage: "approved", success: true };
      }
      
      default:
        return { runId: ctx.runId, stage: "error", success: false, reason: "unknown_state" };
    }
  }
}

export type { DriverContext, DriverResult, Stage };
