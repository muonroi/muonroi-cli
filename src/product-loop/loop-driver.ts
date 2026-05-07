import * as path from "node:path";
import type { StreamChunk } from "../types/index.js";
import { runClarification } from "../council/clarifier.js";
import { runDebate } from "../council/debate.js";
import { runPreflight } from "../council/preflight.js";
import { phaseStart } from "../council/phase-events.js";
import { resolveLeaderModelDetailed, resolveParticipants } from "../council/leader.js";
import { isCouncilMultiProviderPreferred } from "../utils/settings.js";
import { SEED_DIMENSIONS } from "./seed-questions.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { discoverProject, formatDiscoverySummary, type DiscoveryResult } from "./discover.js";
import type { DriverContext, DriverResult, Stage, ProductSpec } from "./types.js";
import type { ClarifiedSpec, DebateState, CouncilParticipant } from "../council/types.js";

export async function* runLoopDriver(ctx: DriverContext): AsyncGenerator<StreamChunk, DriverResult, unknown> {
  let state: Stage = "idle";
  let clarifiedSpec: ClarifiedSpec | undefined;
  let debateState: DebateState | undefined;
  let discovery: DiscoveryResult | undefined;

  const runDir = path.join(ctx.flowDir, "runs", ctx.runId);

  // Resolve real model IDs from the session's provider. Without this, every
  // LLM call below would receive the literal string "leader" as a model id
  // and the provider would reject the request.
  const leaderResolution = await resolveLeaderModelDetailed(ctx.sessionModelId);
  const leaderModelId = leaderResolution.modelId;
  const councilParticipants = await resolveParticipants(
    ctx.sessionModelId,
    isCouncilMultiProviderPreferred(),
  );

  while (true) {
    switch (state) {
      case "idle": {
        state = "discover";
        break;
      }

      case "discover": {
        yield phaseStart({
          phaseId: "loop:discover",
          kind: "research",
          label: "Project discovery",
        });

        discovery = await discoverProject(ctx.cwd);

        const summary = formatDiscoverySummary(discovery);
        if (summary) {
          yield { type: "content", content: `\n${summary}\n` } as StreamChunk;
        }

        // Persist discovery evidence so resume can replay decisions.
        if (discovery.evidence.length > 0) {
          const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
          stateMap.sections.set(
            "Discovery",
            discovery.evidence.map((e) => `- ${e.dim}: ${e.value} (source: ${e.source})`).join("\n"),
          );
          await writeArtifact(runDir, "state.md", stateMap);
        }

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
          leaderModelId,
          "",
          ctx.respondToQuestion,
          ctx.llm,
          undefined,
          SEED_DIMENSIONS,
          6, // maxRounds
          discovery?.prefilled,
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

        // Map 4 stances onto resolved council participants. If we have fewer
        // resolved participants than stances, repeat the leader model so every
        // stance has a valid model id. runCouncil uses the same trim-or-repeat
        // pattern (council/index.ts:166-173).
        const participants: CouncilParticipant[] = stances.map((s, i) => {
          const cp = councilParticipants[i % Math.max(1, councilParticipants.length)];
          return {
            role: (s.name === "Researcher" ? "research" : (cp?.role ?? "implement")) as any,
            model: cp?.model ?? leaderModelId,
            position: "",
            stance: s,
          };
        });

        const debateGen = runDebate(
          clarifiedSpec,
          {
            topic: ctx.idea,
            conversationContext: "",
            leaderModelId,
            participants,
          },
          ctx.llm
        );

        // Suppress raw debate content so the user is not confused by inter-role
        // monologue ("Researcher → Architect ... Question back to you?") which
        // is NOT addressed to them. We still pass through phase/status events
        // so the UI keeps a live progress indicator. After the debate completes
        // we emit a single condensed summary.
        while (true) {
          const { value, done } = await debateGen.next();
          if (done) {
            debateState = value as DebateState;
            break;
          }
          const chunk = value as StreamChunk;
          if (chunk.type === "content") continue;
          yield chunk;
        }

        const summaryText =
          (debateState?.runningSummary && debateState.runningSummary.trim()) ||
          "(debate produced no summary — using empty research findings)";
        yield {
          type: "content",
          content: `\n### Research summary\n${summaryText}\n`,
        } as StreamChunk;

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
        const rawSpec = await ctx.llm.generate(leaderModelId, "You are a Product Owner synthesizing a technical specification.", synthesisPrompt);
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

        // runPreflight — show resolved participants on the brief card. These
        // strings are display-only (no LLM call), but using real model ids
        // gives the user useful context.
        const preflightParticipants = councilParticipants.length > 0
          ? councilParticipants.map((p) => ({ role: p.role as string, model: p.model }))
          : [{ role: "leader", model: leaderModelId }];
        const preflightGen = runPreflight(
          clarifiedSpec,
          preflightParticipants,
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
