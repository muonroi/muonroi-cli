import * as path from "node:path";
import { runDebate } from "../council/debate.js";
import {
  deleteDebateInputs,
  readDebateCheckpoint,
  readDebateInputs,
  writeDebateInputs,
} from "../council/debate-checkpoint.js";
import { resolveDebateSummary } from "../council/debate-summary.js";
import { resolveLeaderModelDetailed, resolveParticipants } from "../council/leader.js";
import { phaseStart } from "../council/phase-events.js";
import { runPreflight } from "../council/preflight.js";
import { makeStanceRecall } from "../council/stance-recall.js";
import type { ClarifiedSpec, CouncilLLM, CouncilParticipant, DebateState } from "../council/types.js";
import { fetchBBContext, inferBBFromPrompt, renderBBContextBlock } from "../ee/bb-retrieval.js";
import { getDefaultEEClient } from "../ee/intercept.js";
import { fireAndForgetWorkflowEvent } from "../ee/workflow-event.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { ensureRunScoped } from "../flow/hierarchy.js";
import { renderResumeDigest, writeContextDoc, writeResearchDoc } from "../flow/run-artifacts.js";
import { logInteraction } from "../storage/index.js";
import type { CouncilInfoCard, StreamChunk } from "../types/index.js";
import { isCouncilMultiProviderPreferred } from "../utils/settings.js";
import { extractAssumptionsFromDebate, mergeAssumptions, renderLedgerSummary } from "./assumption-ledger.js";
import { buildPriorContext } from "./cross-run-memory.js";
import { type DiscoveryResult, discoverProject } from "./discover.js";
import { formatProjectContextForPrompt } from "./discovery-context-format.js";
import { readProjectContext } from "./discovery-persistence.js";
import { clarifiedSpecFromContext, runGatherPhase } from "./gather.js";
import { recordPhaseEnd, recordPhaseStart } from "./phase-budget.js";
import { additionalPrefills, auditAsContextBlock, auditRepo, type RepoAudit } from "./repo-audit.js";
import { SEED_DIMENSIONS } from "./seed-questions.js";
import { deriveTasksFromSpec, writeTasks } from "./typed-artifacts.js";
import type { DriverContext, DriverResult, ProductSpec, ProductStatusCardData, Stage } from "./types.js";

// Council usage_events recording (source="council") now happens at the single
// source of truth inside createCouncilLLM (src/council/llm.ts → recordCouncilUsage),
// so it covers EVERY council entry point — the /council slash path, auto-council,
// and all /ideal phases (clarifier, research, generate, sprint) — not just this
// driver's runDebate call site. The former loop-driver-local wrapper only wrapped
// the debate llm and double-counted nothing else; recording at the source removes
// both the leak and the risk of a double count here.

/**
 * Best-effort interaction_logs writer for the loop-driver. Swallows failures
 * so a broken DB never blocks the FSM. `ctx.sessionId` falls back to runId
 * for legacy callers that don't pass a chat session id.
 */
function logLoopEvent(ctx: DriverContext, subtype: string, data: Record<string, unknown>): void {
  try {
    const sid = ctx.sessionId ?? ctx.runId;
    // Stamp runId on every row so multi-run sessions can be demuxed during
    // forensics — previously only route_decision carried this field. Caller
    // overrides win if the payload already contained a runId.
    const enriched = "runId" in data ? data : { ...data, runId: ctx.runId };
    logInteraction(sid, "council", { eventSubtype: subtype, data: enriched });
  } catch {
    /* non-critical — audit trail only */
  }
}

function buildWorkspaceDiscoveryCard(d: DiscoveryResult, a: RepoAudit, priorRunCount: number): CouncilInfoCard | null {
  const sections: CouncilInfoCard["sections"] = [];

  if (!d.hasProject) {
    sections.push({ heading: "Project", body: "Greenfield — no existing project manifest detected." });
  } else if (d.prefilled.size === 0) {
    sections.push({ heading: "Project", body: "Existing project detected; no dimensions auto-filled." });
  } else {
    const lines = d.evidence.map((ev) => `- ${ev.dim} ← ${ev.value} (from ${ev.source})`);
    sections.push({ heading: "Auto-filled dimensions", body: lines.join("\n") });
    sections.push({
      heading: "Coverage",
      body: `Skipping ${d.prefilled.size} clarification question${d.prefilled.size === 1 ? "" : "s"}.`,
    });
  }

  if (a.hasProject) {
    const bits: string[] = [`mode=${a.mode}`];
    if (a.packageMeta?.name) bits.push(`pkg ${a.packageMeta.name}`);
    bits.push(`src=${a.srcFileCount}`);
    bits.push(`tests=${a.testFileCount}`);
    if (a.testFramework) bits.push(`runner=${a.testFramework}`);
    if (a.hasDocs) bits.push("docs ✓");
    sections.push({ heading: "Repo audit", body: bits.join(" · ") });
  }

  if (priorRunCount > 0) {
    sections.push({
      heading: "Prior context",
      body: `Loaded decisions from ${priorRunCount} earlier run${priorRunCount === 1 ? "" : "s"} on this workspace.`,
    });
  }

  if (sections.length === 0) return null;
  return { title: "Workspace Discovery", sections };
}

function buildGatherCompleteCard(fieldCount: number, unresolvedCount: number): CouncilInfoCard {
  return {
    title: "Project Context Captured",
    sections: [
      { heading: "Fields", body: `${fieldCount} dimension${fieldCount === 1 ? "" : "s"} captured.` },
      {
        heading: "Resolution",
        body:
          unresolvedCount === 0
            ? "All seed dimensions resolved."
            : `${unresolvedCount} dimension${unresolvedCount === 1 ? "" : "s"} still unresolved.`,
      },
    ],
  };
}

function buildResearchSummaryCard(summaryText: string, findings?: string): CouncilInfoCard {
  const sections: CouncilInfoCard["sections"] = [{ heading: "Summary", body: summaryText }];
  if (findings?.trim()) {
    sections.push({ heading: "Findings", body: findings.trim() });
  }
  return { title: "Research Summary", sections };
}

function buildAssumptionsCard(count: number, ledgerSummary: string): CouncilInfoCard {
  return {
    title: "Assumptions Recorded",
    sections: [
      { heading: "From research debate", body: `${count} assumption${count === 1 ? "" : "s"} extracted.` },
      { heading: "Ledger", body: ledgerSummary },
    ],
  };
}

function buildReadyToSprintCard(productSpec: ProductSpec): CouncilInfoCard {
  const mvp = (productSpec.mvp ?? []).map((m) => `- ${m}`).join("\n") || "- (none)";
  return {
    title: "Ready to Sprint",
    sections: [
      { heading: "Persona", body: productSpec.persona || "(unspecified)" },
      { heading: "MVP", body: mvp },
      {
        heading: "Estimate",
        body: `Sprints: ${productSpec.sprintEstimate ?? "?"}  ·  Cost: $${productSpec.costEstimate ?? "?"}`,
      },
    ],
  };
}

export async function* runLoopDriver(ctx: DriverContext): AsyncGenerator<StreamChunk, DriverResult, unknown> {
  let state: Stage = "idle";
  let clarifiedSpec: ClarifiedSpec | undefined;
  let debateState: DebateState | undefined;
  // Resolved once the research debate completes (F9): runningSummary, or a
  // faithful fallback synthesized from participant positions when the debate
  // returned after openings without a running summary. Reused across the
  // research artifacts AND the scoping synthesis prompt so neither loses the
  // debate. Empty until the research phase runs.
  let resolvedDebateSummary = "";
  let discovery: DiscoveryResult | undefined;
  let audit: RepoAudit | undefined;
  let productSpec: ProductSpec | undefined;
  let conversationContext = "";

  const runDir = path.join(ctx.flowDir, "runs", ctx.runId);

  // Resolve real model IDs from the session's provider. Without this, every
  // LLM call below would receive the literal string "leader" as a model id
  // and the provider would reject the request.
  const leaderResolution = await resolveLeaderModelDetailed(ctx.sessionModelId);
  const leaderModelId = leaderResolution.modelId;
  const councilParticipants = await resolveParticipants(ctx.sessionModelId, isCouncilMultiProviderPreferred());

  // C-v2 cross-session resume — a persisted debate checkpoint means the council
  // debate was interrupted in a PRIOR session (the process died mid-round; the
  // in-process C-v1 retry only covers same-session throws). Skip the already-
  // completed + persisted discovery + interview and jump straight to the
  // research/debate stage with the restored gather outputs; the `research` case
  // reads the checkpoint and resumes the debate from its last completed round.
  const priorCheckpoint = await readDebateCheckpoint(runDir);
  if (priorCheckpoint) {
    const inputs = await readDebateInputs(runDir);
    if (inputs) {
      clarifiedSpec = inputs.clarifiedSpec;
      conversationContext = inputs.conversationContext;
      state = "research";
      yield {
        type: "content",
        content: `\n> Resuming an interrupted council debate (round ${priorCheckpoint.roundCount + 1}) — skipping discovery + interview.\n`,
      };
    } else {
      console.error(
        `[loop-driver] debate checkpoint present but debate-inputs.json missing (run ${ctx.runId}); running the council FSM fresh.`,
      );
    }
  }

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
        const phaseMarker_discover = await recordPhaseStart({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          phase: "discover",
        });

        // Run shallow manifest probe and deep repo audit in parallel.
        const [discoveryResult, auditResult] = await Promise.all([discoverProject(ctx.cwd), auditRepo(ctx.cwd)]);
        discovery = discoveryResult;
        audit = auditResult;

        // Merge audit-derived prefills into discovery (manifest wins on conflict).
        for (const [dim, value] of additionalPrefills(audit).entries()) {
          if (!discovery.prefilled.has(dim)) {
            discovery.prefilled.set(dim, value);
            discovery.evidence.push({ dim, source: "repo-audit", value });
            discovery.notes.push(`Inferred from audit: ${dim}=${value}`);
          }
        }

        // Build conversationContext for clarifier + debate so prompts are
        // grounded in real repo state, not generic boilerplate.
        conversationContext = auditAsContextBlock(audit);

        // P5 — cross-run workspace memory. prior.runs.length is still used
        // for the discovery card below to show how many prior runs were found.
        // The digest is no longer appended to conversationContext: PIL Layer 3
        // already does semantic T0/T1 injection on every LLM call via
        // /api/search, so the static digest was duplicating work and growing
        // the system prompt unbounded.
        const prior = await buildPriorContext({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          idea: ctx.idea,
          leaderModelId,
          llm: ctx.llm,
          optOut: ctx.skipPriorContext === true,
        });

        const discoveryCard = buildWorkspaceDiscoveryCard(discovery, audit, prior.runs.length);
        if (discoveryCard) {
          yield { type: "council_info_card", councilInfoCard: discoveryCard } as StreamChunk;
        }

        // Part A — persist prior-run context as a first-class context.md. The
        // digest is intentionally NOT re-injected into the live system prompt
        // (PIL Layer 3 already does semantic injection), but writing it to disk
        // makes it a reviewable, resumable surface — the run's inherited memory.
        try {
          const ctxParts = [`Prior runs on this workspace: ${prior.runs.length}`];
          if (prior.digest?.trim()) ctxParts.push("", prior.digest.trim());
          if (audit.hasProject) ctxParts.push("", "## Repo audit", conversationContext);
          await writeContextDoc(ctx.flowDir, ctx.runId, ctxParts.join("\n"));
        } catch {
          /* non-critical — context.md is a review surface, never blocks the FSM */
        }

        // Persist discovery evidence + repo audit so resume can replay.
        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        if (discovery.evidence.length > 0) {
          stateMap.sections.set(
            "Discovery",
            discovery.evidence.map((e) => `- ${e.dim}: ${e.value} (source: ${e.source})`).join("\n"),
          );
        }
        if (audit.hasProject) {
          stateMap.sections.set("Repo Audit", conversationContext);
        }
        await writeArtifact(runDir, "state.md", stateMap);

        const discoverWarn = await recordPhaseEnd({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          capUsd: ctx.flags.maxCost,
          marker: phaseMarker_discover,
        });
        if (discoverWarn) {
          yield { type: "content", content: `\n> [budget] ${discoverWarn}\n` } as StreamChunk;
        }

        // Emit an initial product_status_card so the UI shows the status panel
        // immediately after discovery completes — before gather/research blocks
        // on user interaction. The card is updated again after each sprint.
        const initStatusCard: ProductStatusCardData = {
          sprintN: 0,
          totalSprints: ctx.flags.maxSprints,
          costSpent: 0,
          costCap: ctx.flags.maxCost,
          criteriaMet: 0,
          criteriaPartial: 0,
          criteriaUnmet: 0,
          currentStage: "gather",
        };
        yield { type: "product_status_card", productStatusCard: initStatusCard } as StreamChunk;

        state = "gather";
        break;
      }

      case "gather": {
        yield phaseStart({
          phaseId: "loop:gather",
          kind: "clarification",
          label: "Gathering Product Context",
        });
        const phaseMarker_gather = await recordPhaseStart({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          phase: "gather",
        });

        // Write Resume Digest to state.md
        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        stateMap.sections.set(
          "Resume Digest",
          renderResumeDigest({
            stage: "gather",
            lastCompleted: "discover",
            nextAction: "Answer clarification questions to define product dimensions",
            updatedAt: new Date().toISOString(),
          }),
        );
        await writeArtifact(runDir, "state.md", stateMap);

        // runGatherPhase is async (not a generator), but the discovery
        // interview emits askcard chunks via the io.emit callback. We collect
        // them into a queue and drain after each yield so the UI sees each
        // question and the user (or harness) can answer via
        // respondToCouncilQuestion → ctx.respondToQuestion.
        const gatherEmitted: StreamChunk[] = [];
        const gatherDone = { value: false };
        let gatherError: unknown;
        let gatherResult: Awaited<ReturnType<typeof runGatherPhase>> | undefined;
        const gatherTask = (async () => {
          try {
            gatherResult = await runGatherPhase(
              ctx.flowDir,
              ctx.runId,
              ctx.idea,
              ctx.flags.maxCost,
              ctx.llm,
              ctx.sessionModelId,
              {
                emit: (chunk) => gatherEmitted.push(chunk),
                respondToQuestion: ctx.respondToQuestion,
              },
            );
          } catch (err) {
            gatherError = err;
          } finally {
            gatherDone.value = true;
          }
        })();

        // Drain emitted chunks while waiting for gatherTask to finish.
        const _drainDbg = process.env.MUONROI_DEBUG_LEADER === "1";
        let _drainTick = 0;
        let _emptyTicks = 0;
        while (!gatherDone.value) {
          while (gatherEmitted.length > 0) {
            const c = gatherEmitted.shift() as StreamChunk;
            if (_drainDbg) {
              const cq = (c as { councilQuestion?: { questionId?: string } }).councilQuestion;
              process.stderr.write(`[drain] yield-chunk: type=${c.type}, questionId=${cq?.questionId ?? "n/a"}\n`);
            }
            yield c;
            if (_drainDbg) {
              process.stderr.write(`[drain] post-yield, queue=${gatherEmitted.length}\n`);
            }
            _emptyTicks = 0;
          }
          // Queue empty — wait for gatherTask to push the next chunk or to
          // complete. setImmediate runs in the check phase of Node's event
          // loop, between poll phases where HTTP responses are handled, and
          // does NOT compete with OpenTUI's setInterval(16ms) macrotask queue
          // (which is what starved the original setTimeout(50) poll).
          // Adaptive backoff: hot setImmediate spinning at 30k ticks/sec was
          // starving CPU from network I/O on the leader fetch, blocking the
          // response for hundreds of seconds. After 100 empty ticks, escalate
          // to setTimeout(1) to give the OS scheduler and I/O subsystems room
          // to make progress. Resets to setImmediate the moment a chunk arrives.
          _drainTick++;
          _emptyTicks++;
          if (_emptyTicks > 100) {
            await new Promise<void>((r) => setTimeout(r, 1));
          } else {
            await new Promise<void>((r) => setImmediate(r));
          }
          if (_drainDbg && _drainTick % 200 === 0) {
            process.stderr.write(
              `[drain] tick=${_drainTick}, empty=${_emptyTicks}, queue=${gatherEmitted.length}, done=${gatherDone.value}\n`,
            );
          }
        }
        if (_drainDbg) {
          process.stderr.write(`[drain] gather-done, flushing ${gatherEmitted.length} chunks\n`);
        }
        while (gatherEmitted.length > 0) {
          const c = gatherEmitted.shift() as StreamChunk;
          if (_drainDbg) {
            const cq = (c as { councilQuestion?: { questionId?: string } }).councilQuestion;
            process.stderr.write(`[drain] final-flush: type=${c.type}, questionId=${cq?.questionId ?? "n/a"}\n`);
          }
          yield c;
        }
        await gatherTask;
        if (gatherError) throw gatherError;
        const projectContext = gatherResult as Awaited<ReturnType<typeof runGatherPhase>>;
        clarifiedSpec = clarifiedSpecFromContext(projectContext);

        // Confidence metric: unresolvedDimensions.length
        const unresolvedDimensionsCount = SEED_DIMENSIONS.filter(
          (d) => clarifiedSpec?.resolved?.[d.id] !== "answered",
        ).length;

        yield {
          type: "council_info_card",
          councilInfoCard: buildGatherCompleteCard(
            Object.keys(projectContext.context ?? {}).length,
            unresolvedDimensionsCount,
          ),
        } as StreamChunk;

        if (unresolvedDimensionsCount <= 1) {
          // Write resolved dimensions to gray-areas.md
          const grayMap = (await readArtifact(runDir, "gray-areas.md")) ?? { preamble: "", sections: new Map() };
          for (const qa of clarifiedSpec.rawQA) {
            grayMap.sections.set(qa.question, qa.answer);
          }
          await writeArtifact(runDir, "gray-areas.md", grayMap);

          const gatherWarn = await recordPhaseEnd({
            flowDir: ctx.flowDir,
            runId: ctx.runId,
            capUsd: ctx.flags.maxCost,
            marker: phaseMarker_gather,
          });
          if (gatherWarn) {
            yield { type: "content", content: `\n> [budget] ${gatherWarn}\n` } as StreamChunk;
          }

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
            },
          } as StreamChunk;
          return { runId: ctx.runId, stage: "halted", success: false, reason: "insufficient_resolution" };
        }
        break;
      }

      case "research": {
        if (!clarifiedSpec) {
          return { runId: ctx.runId, stage: "error", success: false, reason: "missing_spec_for_research" };
        }

        // Part E — web-research confidence for this run, filled when the
        // Researcher stance is (re)assigned to a web-capable model below.
        let researchWebConfidence: { confidence: "native" | "degraded"; model?: string } | undefined;
        const researchPhaseStartMs = Date.now();
        yield phaseStart({
          phaseId: "loop:research",
          kind: "research",
          label: "Research & Debate",
        });
        const phaseMarker_research = await recordPhaseStart({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          phase: "research",
        });

        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        stateMap.sections.set(
          "Resume Digest",
          renderResumeDigest({
            stage: "research",
            lastCompleted: "gather",
            nextAction: "Run / resume the multi-expert council debate",
            updatedAt: new Date().toISOString(),
          }),
        );
        await writeArtifact(runDir, "state.md", stateMap);

        // inside research phase, before building councilTopic:
        const projectCtx = await readProjectContext(ctx.flowDir, ctx.runId);
        if (projectCtx) {
          conversationContext += `\n\nProject Context:\n${formatProjectContextForPrompt(projectCtx)}`;
        }

        // Build stances. When ecosystem bias is enabled (default), augment the
        // Researcher/Architect/Skeptic lenses so the debate prioritizes
        // muonroi-docs MCP queries + existing BB package composition over
        // greenfield reasoning.
        let stances: Array<{ name: string; lens: string }> = [
          { name: "Researcher", lens: "Focus on technical implementation details and codebase constraints" },
          { name: "Cost-Controller", lens: "Focus on budget, resources, and complexity trade-offs" },
          { name: "Skeptic", lens: "Focus on identifying risks, edge cases, and potential points of failure" },
          { name: "Architect", lens: "Focus on high-level structure, scalability, and long-term maintainability" },
        ];
        try {
          const { shouldApplyEcosystemBias, buildEcosystemResearchSeed } = await import("./discovery-ecosystem.js");
          if (shouldApplyEcosystemBias({ cwd: process.cwd() })) {
            const seed = buildEcosystemResearchSeed();
            stances = stances.map((s) => {
              if (s.name === "Researcher") return { ...s, lens: seed.researcherLens };
              if (s.name === "Architect") return { ...s, lens: seed.architectLens };
              if (s.name === "Skeptic") return { ...s, lens: seed.skepticLens };
              return s;
            });
          }
        } catch (err) {
          logLoopEvent(ctx, "council_error", {
            phase: "research",
            stage: "ecosystem-bias",
            error: err instanceof Error ? err.message : String(err),
            severity: "warn",
          });
          /* graceful — fallback to generic stances */
        }

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

        // Part E — the Researcher stance MUST prefer a model with NATIVE online
        // web research (its own web_search/browsing), so the research phase gets
        // real online facts rather than codebase-only reasoning. If a web-capable
        // model is reachable this session, route the Researcher to it; otherwise
        // record degraded confidence into research.md (the fallback add-in path
        // — Tavily/MCP — is untrusted per the owner's Part E principle).
        const { modelHasNativeWebResearch, getWebResearchModel } = await import("../models/registry.js");
        const reachableIds = new Set<string>(
          [...councilParticipants.map((p) => p.model), leaderModelId].filter(Boolean),
        );
        const researcherIdx = participants.findIndex((p) => p.stance?.name === "Researcher");
        if (researcherIdx >= 0) {
          const current = participants[researcherIdx]!.model;
          if (!modelHasNativeWebResearch(current)) {
            // ONLY reroute to a web-native model that is actually REACHABLE this
            // session. A model whose provider has no factory wired (e.g. grok/xai
            // when only opencode-go is authed) would fail council participant
            // creation ("no factory for model's provider") and wedge the debate —
            // so if no reachable web-native model exists, degrade gracefully and
            // KEEP the current reachable model rather than swap in a dead id.
            const webModel = getWebResearchModel(reachableIds);
            if (webModel) {
              participants[researcherIdx]!.model = webModel.id;
              researchWebConfidence = { confidence: "native", model: webModel.id };
            } else {
              researchWebConfidence = { confidence: "degraded" };
              logLoopEvent(ctx, "research_web_degraded", {
                phase: "research",
                reason: "no reachable native_web_research model",
                researcherModel: current,
              });
            }
          } else {
            researchWebConfidence = { confidence: "native", model: current };
          }
        }

        // CB-1 — BB-aware context injection. Runs before council debate fires so
        // the research stances have access to relevant BB recipes and rules.
        //
        // Two activation paths:
        //   1. Filesystem-based: IntentDetectionTrace.targetFramework set by
        //      detectBBFramework() (point-to-existing on an existing BB tree).
        //   2. Prompt-based fallback: when targetFramework is undefined (empty
        //      cwd / fresh init-new), infer from the user's idea against the
        //      bb-recipes collection. Threshold 0.60 catches canonical BB
        //      intents ("fraud detection", "loan approval", "multi-tenant",
        //      "decision table FEEL") while rejecting generic prompts.
        let bbActive = ctx._intentTrace?.targetFramework === "muonroi-building-block";
        if (!bbActive) {
          try {
            bbActive = await inferBBFromPrompt(ctx.idea);
            if (bbActive && ctx._intentTrace) {
              ctx._intentTrace.targetFramework = "muonroi-building-block";
            }
          } catch (err) {
            logLoopEvent(ctx, "council_error", {
              phase: "research",
              stage: "bb-infer",
              error: err instanceof Error ? err.message : String(err),
              severity: "warn",
            });
            /* graceful degrade — never block the research phase */
          }
        }
        if (bbActive) {
          try {
            const bbCtx = await fetchBBContext(ctx.idea);
            const bbBlock = renderBBContextBlock(bbCtx);
            if (bbBlock) {
              conversationContext = `${bbBlock}\n\n${conversationContext}`;
            }
          } catch (err) {
            logLoopEvent(ctx, "council_error", {
              phase: "research",
              stage: "bb-context",
              error: err instanceof Error ? err.message : String(err),
              severity: "warn",
            });
            /* graceful degrade — never block the research phase */
          }
        }

        // C-v2 — persist the minimal gather outputs so a fresh session can
        // re-enter the debate (loop-driver resume entry above) without re-running
        // the interactive discovery + interview. Written once here at debate start,
        // captures the final conversationContext (after project + BB context).
        // Deleted after scoping writes the spec. Non-fatal on failure.
        await writeDebateInputs(runDir, {
          version: 1,
          problemStatement: clarifiedSpec.problemStatement,
          clarifiedSpec,
          conversationContext,
          savedAt: new Date().toISOString(),
        });

        // C (mid-debate checkpoint) — runDebate snapshots its per-round state to
        // `<runDir>/debate-checkpoint.json` after each completed round and deletes
        // it on normal completion. If a prior attempt (this process, or a crashed
        // earlier run of the SAME runId) left a checkpoint, seed it so the debate
        // resumes from the last completed round instead of re-running rounds 1..N.
        let resumeCheckpoint = (await readDebateCheckpoint(runDir)) ?? undefined;
        // In-process resilience: a mid-debate throw (provider 5xx after the
        // fallback budget, transient network) re-runs runDebate ONCE (default)
        // from the freshly-written checkpoint, so a round-5 break loses one round,
        // not five. Only retried when a checkpoint exists (≥1 round completed) —
        // a pre-round-1 failure has nothing to resume and rethrows immediately.
        const maxDebateRetries = (() => {
          const raw = process.env.MUONROI_DEBATE_RESUME_RETRIES;
          const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
          return Number.isFinite(n) && n >= 0 ? n : 1;
        })();

        for (let attempt = 0; ; attempt++) {
          const debateGen = runDebate(
            clarifiedSpec,
            {
              topic: ctx.idea,
              conversationContext,
              leaderModelId,
              participants,
              runId: ctx.sessionId ?? ctx.runId,
              checkpointDir: runDir,
              resumeCheckpoint,
              // Item 3 — per-stance recall: each participant opens grounded in the
              // stance-weighted slice of the brain its lens cares about. Bounded +
              // failure-tolerant; unavailable EE leaves openings unchanged.
              stanceRecall: makeStanceRecall(getDefaultEEClient(), {
                cwd: ctx.flowDir,
                sourceSession: ctx.sessionId ?? ctx.runId,
              }),
            },
            ctx.llm,
          );

          // Suppress raw debate content so the user is not confused by inter-role
          // monologue ("Researcher → Architect ... Question back to you?") which
          // is NOT addressed to them. We still pass through phase/status events
          // so the UI keeps a live progress indicator. After the debate completes
          // we emit a single condensed summary.
          try {
            while (true) {
              const { value, done } = await debateGen.next();
              if (done) {
                debateState = value as DebateState;
                break;
              }
              const chunk = value as StreamChunk;
              if (chunk.type === "content") continue;
              // Persist debate speaker turns to interaction_logs so forensics
              // can replay the debate text without relying on TUI scrollback
              // (which currently holds the only copy — messages/usage_events
              // tables stay empty for the debate path).
              if (chunk.type === "council_message" && chunk.councilMessage) {
                const cm = chunk.councilMessage;
                logLoopEvent(ctx, "council_message", {
                  phase: "research",
                  kind: cm.kind,
                  speakerRole: cm.speaker.role,
                  speakerModel: cm.speaker.model,
                  partnerRole: cm.partner?.role ?? null,
                  round: cm.round ?? null,
                  attempts: cm.attempts ?? 1,
                  failureReason: cm.failureReason ?? null,
                  toolCalls: cm.toolCalls?.map((tc) => tc.name) ?? [],
                  // Cap at 4000 chars so a single row stays well under SQLite
                  // text limits even for the most verbose speaker turn.
                  textExcerpt: cm.text.slice(0, 4000),
                  textLength: cm.text.length,
                });
              }
              yield chunk;
            }
            break; // debate completed — exit the retry loop.
          } catch (err) {
            // The debate iterator hit an exception (e.g. provider 5xx after the
            // retry budget). Persist an audit row so we have a forensics trail —
            // without it the FSM unwinds silently and the session looks like
            // "research = 0 word" in the DB.
            const freshCp = (await readDebateCheckpoint(runDir)) ?? undefined;
            logLoopEvent(ctx, "council_error", {
              phase: "research",
              stage: "debate",
              error: err instanceof Error ? err.message : String(err),
              roundCount: debateState?.roundCount ?? freshCp?.roundCount ?? 0,
              participantCount: participants.length,
              elapsedMs: Date.now() - researchPhaseStartMs,
            });
            // C — resume-from-checkpoint retry: only when a completed round was
            // checkpointed and retries remain. Otherwise rethrow unchanged.
            if (attempt < maxDebateRetries && freshCp && freshCp.roundCount >= 1) {
              resumeCheckpoint = freshCp;
              yield {
                type: "content",
                content: `\n> Debate interrupted (${err instanceof Error ? err.message : String(err)}); resuming from round ${freshCp.roundCount + 1}…\n`,
              };
              continue;
            }
            throw err;
          }
        }

        // F9 — resolve the debate summary once (runningSummary or a fallback
        // synthesized from participant positions) for reuse across the research
        // artifacts + scoping synthesis.
        if (debateState) resolvedDebateSummary = resolveDebateSummary(debateState);

        // Forensics row mirrors the council/index.ts council_summary record
        // (which only fires for sprint planning via runCouncil). The /ideal
        // initial debate goes through runDebate here and was previously
        // invisible to `usage forensics`. Excerpts are capped at 4000 chars
        // to match council_message rows so the summary captures the full
        // final stance, not just the first paragraph. metadata_json stays
        // bounded (~16-20KB per debate with 4 stances).
        if (debateState) {
          const stancesForLog = participants.slice(0, 8).map((p, i) => {
            const finalPosition = debateState!.active?.[i]?.position ?? "";
            return {
              role: p.role,
              model: p.model,
              stanceName: p.stance?.name,
              finalPositionExcerpt: finalPosition.slice(0, 4000),
            };
          });
          logLoopEvent(ctx, "council_summary", {
            phase: "research",
            topic: ctx.idea,
            roundCount: debateState.roundCount ?? 0,
            participantCount: participants.length,
            stances: stancesForLog,
            summaryExcerpt: (debateState.runningSummary ?? "").slice(0, 4000),
            researchFindingsExcerpt: (debateState.researchFindings ?? "").slice(0, 4000),
            durationMs: Date.now() - researchPhaseStartMs,
          });
        }

        const summaryText = resolvedDebateSummary || "(debate produced no summary — using empty research findings)";
        yield {
          type: "council_info_card",
          councilInfoCard: buildResearchSummaryCard(summaryText, debateState?.researchFindings),
        } as StreamChunk;

        // Append research summary to delegations.md (kept for back-compat: the
        // EE transcript extractor + legacy readers still read these sections).
        // A debate that returns after openings (leader routes straight to the
        // preflight gate) leaves runningSummary empty — synthesize a faithful
        // fallback from the participants' positions so the canonical research
        // artifacts never silently drop the whole debate.
        const delegationsMap = (await readArtifact(runDir, "delegations.md")) ?? { preamble: "", sections: new Map() };
        delegationsMap.sections.set("Research Summary", resolvedDebateSummary);
        if (debateState.researchFindings) {
          delegationsMap.sections.set("Research Findings", debateState.researchFindings);
        }
        await writeArtifact(runDir, "delegations.md", delegationsMap);

        // Part A — promote the debate output to a first-class research.md. This
        // is the canonical, reviewable surface (`/ideal review`) and the home
        // for the EE recall seed once per-turn grounding lands (deferred).
        try {
          await writeResearchDoc(ctx.flowDir, ctx.runId, {
            summary: resolvedDebateSummary,
            findings: debateState.researchFindings ?? undefined,
            webResearch: researchWebConfidence,
          });
          // Part C — persist the debate as a workflow_debate experience so a
          // future run on a similar topic can seed its stances with what this
          // council concluded (gate-on-outcome: fired after the debate produced
          // a summary, not per-turn — Kill #4/#5).
          fireAndForgetWorkflowEvent({
            kind: "council-debate",
            phaseRef: `runs/${ctx.runId}#research`,
            sessionId: ctx.sessionId ?? ctx.runId,
            text: (debateState.runningSummary ?? "").slice(0, 2000) || `debate on: ${ctx.idea.slice(0, 200)}`,
            payload: { topic: ctx.idea.slice(0, 200), roundCount: debateState.roundCount ?? 0 },
          });
        } catch {
          /* non-critical — research.md is a review surface, never blocks the FSM */
        }

        // P6 - extract assumptions from the research debate so foundational
        // claims (perf budgets, SDK contracts, etc.) become trackable across
        // sprints rather than buried in stance prose. Silent skip on
        // extraction failure: sprint-feedback can still populate the ledger
        // retroactively, and the done-gate only blocks when high-confidence
        // assumptions remain unverified — never on absence.
        try {
          const extracted = await extractAssumptionsFromDebate({
            debateState,
            leaderModelId,
            llm: ctx.llm,
            phase: "research",
          });
          if (extracted.length > 0) {
            const ledger = await mergeAssumptions(ctx.flowDir, ctx.runId, extracted);
            yield {
              type: "council_info_card",
              councilInfoCard: buildAssumptionsCard(extracted.length, renderLedgerSummary(ledger)),
            } as StreamChunk;
          }
        } catch (err) {
          logLoopEvent(ctx, "council_error", {
            phase: "research",
            stage: "assumption-extract",
            error: err instanceof Error ? err.message : String(err),
            severity: "warn",
          });
          /* non-critical */
        }

        const researchWarn = await recordPhaseEnd({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          capUsd: ctx.flags.maxCost,
          marker: phaseMarker_research,
        });
        if (researchWarn) {
          yield { type: "content", content: `\n> [budget] ${researchWarn}\n` } as StreamChunk;
        }

        state = "scoping";
        break;
      }

      case "scoping": {
        if (!clarifiedSpec || !debateState) {
          return { runId: ctx.runId, stage: "error", success: false, reason: "missing_state_for_scoping" };
        }

        const scopingPhaseStartMs = Date.now();
        // Mark phase entry in interaction_logs so a hung synthesis is
        // detectable from outside the process (session 8a35be9891bd hit this
        // exact silent stall — DB had council_summary but no row for the
        // next 25+ minutes while the synthesis llm.generate call hung).
        logLoopEvent(ctx, "phase_start", { phase: "scoping" });

        yield phaseStart({
          phaseId: "loop:scoping",
          kind: "synthesis",
          label: "Scoping & Synthesis",
        });
        const phaseMarker_scoping = await recordPhaseStart({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          phase: "scoping",
        });

        const stateMap = (await readArtifact(runDir, "state.md")) ?? { preamble: "", sections: new Map() };
        stateMap.sections.set(
          "Resume Digest",
          renderResumeDigest({
            stage: "scoping",
            lastCompleted: "research",
            nextAction: "Synthesize the ProductSpec and confirm the roadmap at the preflight gate",
            updatedAt: new Date().toISOString(),
          }),
        );
        await writeArtifact(runDir, "state.md", stateMap);

        // Visible progress indicator — without this the TUI sits silent for
        // 30-60s while ctx.llm.generate runs the synthesis call. Users read
        // that as "đơ". The status chunk renders in CouncilStatusList; the
        // tick interval keeps a heartbeat going until the call returns.
        yield {
          type: "council_status",
          councilStatus: {
            statusId: `scoping-${ctx.runId}`,
            state: "start",
            phase: "synthesis",
            label: "Synthesizing product spec",
            detail: "Drafting roadmap from clarified spec + debate summary…",
          },
        } as StreamChunk;

        // Synthesize ProductSpec
        const synthesisPrompt = `Synthesize a ProductSpec JSON based on the following:
Idea: ${ctx.idea}
Clarified Spec: ${JSON.stringify(clarifiedSpec)}
Debate Summary: ${resolvedDebateSummary || debateState.runningSummary}
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
        // The scoping phase's only LLM call. Wrapped so a provider hang/
        // timeout leaves a council_error audit row instead of swallowing the
        // session into silence (the failure mode session 8a35be hit).
        let rawSpec: string;
        try {
          rawSpec = await ctx.llm.generate(
            leaderModelId,
            "You are a Product Owner synthesizing a technical specification.",
            synthesisPrompt,
          );
          yield {
            type: "council_status",
            councilStatus: {
              statusId: `scoping-${ctx.runId}`,
              state: "done",
              phase: "synthesis",
              label: "Spec synthesized",
              elapsedMs: Date.now() - scopingPhaseStartMs,
            },
          } as StreamChunk;
        } catch (err) {
          yield {
            type: "council_status",
            councilStatus: {
              statusId: `scoping-${ctx.runId}`,
              state: "error",
              phase: "synthesis",
              label: "Spec synthesis failed",
              elapsedMs: Date.now() - scopingPhaseStartMs,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          } as StreamChunk;
          logLoopEvent(ctx, "council_error", {
            phase: "scoping",
            stage: "synthesis-llm",
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - scopingPhaseStartMs,
          });
          throw err;
        }
        try {
          const match = rawSpec.match(/\{[\s\S]*\}/);
          productSpec = match ? JSON.parse(match[0]) : ({} as ProductSpec);
          productSpec!.createdAt = new Date();
        } catch (err) {
          logLoopEvent(ctx, "council_error", {
            phase: "scoping",
            stage: "synthesis-parse",
            error: err instanceof Error ? err.message : String(err),
            rawSpecExcerpt: rawSpec.slice(0, 800),
          });
          return { runId: ctx.runId, stage: "error", success: false, reason: "failed_to_synthesize_spec" };
        }

        // Write ProductSpec to roadmap.md (human-readable surface).
        const roadmapMap = (await readArtifact(runDir, "roadmap.md")) ?? { preamble: "", sections: new Map() };
        roadmapMap.sections.set("Product Specification", JSON.stringify(productSpec, null, 2));
        await writeArtifact(runDir, "roadmap.md", roadmapMap);

        // Part C — the synthesized spec IS the council's decision. Persist it as
        // a workflow_decision experience so future runs don't re-litigate a
        // settled architectural/scoping choice.
        fireAndForgetWorkflowEvent({
          kind: "decision",
          phaseRef: `runs/${ctx.runId}#scoping`,
          sessionId: ctx.sessionId ?? ctx.runId,
          text: `Scoped "${ctx.idea.slice(0, 120)}": ${(productSpec?.architecture ?? "").slice(0, 400)}`,
          payload: {
            persona: productSpec?.persona ?? null,
            mvp: productSpec?.mvp ?? [],
            sprintEstimate: productSpec?.sprintEstimate ?? null,
          },
        });

        // C-v2 — debate + scoping are done and the spec is persisted, so the
        // cross-session resume inputs are obsolete (the checkpoint was already
        // deleted by runDebate on completion). Clean them up so a later
        // `/ideal resume` of this run does not re-enter the debate FSM.
        await deleteDebateInputs(runDir);

        // Hierarchy index — place this run under a milestone (the product idea)
        // and a phase (this scoped iteration). Idempotent across resume; purely
        // an index over runs/, never rewrites run artifacts or ROADMAP phases.
        try {
          const mvpHead = Array.isArray(productSpec?.mvp) && productSpec!.mvp.length > 0 ? productSpec!.mvp[0] : "";
          await ensureRunScoped(
            ctx.flowDir,
            {
              runId: ctx.runId,
              milestoneTitle: ctx.idea.slice(0, 60),
              milestoneGoal: (productSpec?.architecture ?? "").slice(0, 200),
              phaseTitle: (mvpHead || ctx.idea).slice(0, 50),
              phaseGoal: (productSpec?.persona ?? "").slice(0, 200),
            },
            new Date().toISOString(),
          );
        } catch {
          /* non-critical — hierarchy is an index; failure must not block scoping */
        }

        // P8 - derive tasks.json from the spec (canonical machine-readable
        // surface for downstream /execute consumption). MVP items get
        // sprint=1, phase2 gets sprint=2. Re-deriving the same spec is
        // idempotent — ids are hash-stable across runs.
        try {
          const tasks = deriveTasksFromSpec(productSpec!);
          await writeTasks(ctx.flowDir, ctx.runId, tasks);
        } catch {
          /* non-critical */
        }

        // runPreflight — show resolved participants on the brief card. These
        // strings are display-only (no LLM call), but using real model ids
        // gives the user useful context.
        const preflightParticipants =
          councilParticipants.length > 0
            ? councilParticipants.map((p) => ({ role: p.role as string, model: p.model }))
            : [{ role: "leader", model: leaderModelId }];
        const preflightGen = runPreflight(
          clarifiedSpec,
          preflightParticipants,
          !!debateState.researchFindings,
          ctx.respondToPreflight,
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

        const scopingWarn = await recordPhaseEnd({
          flowDir: ctx.flowDir,
          runId: ctx.runId,
          capUsd: ctx.flags.maxCost,
          marker: phaseMarker_scoping,
        });
        if (scopingWarn) {
          yield { type: "content", content: `\n> [budget] ${scopingWarn}\n` } as StreamChunk;
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
        if (productSpec) {
          yield {
            type: "council_info_card",
            councilInfoCard: buildReadyToSprintCard(productSpec),
          } as StreamChunk;
        } else {
          yield { type: "content", content: "Ready to sprint!" } as StreamChunk;
        }
        return { runId: ctx.runId, stage: "approved", success: true };
      }

      default:
        return { runId: ctx.runId, stage: "error", success: false, reason: "unknown_state" };
    }
  }
}

export type { DriverContext, DriverResult, Stage };
