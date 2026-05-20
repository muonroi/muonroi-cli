import * as path from "node:path";
import { runDebate } from "../council/debate.js";
import { resolveLeaderModelDetailed, resolveParticipants } from "../council/leader.js";
import { phaseStart } from "../council/phase-events.js";
import { runPreflight } from "../council/preflight.js";
import type { ClarifiedSpec, CouncilCallUsage, CouncilLLM, CouncilParticipant, DebateState } from "../council/types.js";
import { fetchBBContext, inferBBFromPrompt, renderBBContextBlock } from "../ee/bb-retrieval.js";
import { readArtifact, writeArtifact } from "../flow/artifact-io.js";
import { logInteraction, recordUsageEvent } from "../storage/index.js";
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

/**
 * Wraps a CouncilLLM so every debate/research/generate call records a
 * usage_events row with source="council". debate.ts callers don't pass an
 * onUsage callback today, so the only place we can intercept is here, by
 * injecting our recorder into each method invocation before forwarding.
 * The original onUsage (if any) is still called.
 */
function wrapLLMForUsageTracking(llm: CouncilLLM, ctx: DriverContext): CouncilLLM {
  const sid = ctx.sessionId ?? ctx.runId;
  const recorder = (modelId: string) => (usage: CouncilCallUsage) => {
    try {
      recordUsageEvent(sid, "council", modelId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cachedInputTokens,
      });
    } catch {
      /* best-effort — never block the debate */
    }
  };
  return {
    generate: (modelId, system, prompt, maxTokens, onUsage) =>
      llm.generate(modelId, system, prompt, maxTokens, (u) => {
        recorder(modelId)(u);
        onUsage?.(u);
      }),
    debate: (modelId, system, prompt, signal, persistTrace, options, onUsage) =>
      llm.debate(modelId, system, prompt, signal, persistTrace, options, (u) => {
        recorder(modelId)(u);
        onUsage?.(u);
      }),
    research: (modelId, topic, conversationContext, signal, persistTrace, options, onUsage) =>
      llm.research(modelId, topic, conversationContext, signal, persistTrace, options, (u) => {
        recorder(modelId)(u);
        onUsage?.(u);
      }),
  };
}

/**
 * Best-effort interaction_logs writer for the loop-driver. Swallows failures
 * so a broken DB never blocks the FSM. `ctx.sessionId` falls back to runId
 * for legacy callers that don't pass a chat session id.
 */
function logLoopEvent(ctx: DriverContext, subtype: string, data: Record<string, unknown>): void {
  try {
    const sid = ctx.sessionId ?? ctx.runId;
    logInteraction(sid, "council", { eventSubtype: subtype, data });
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
  if (findings && findings.trim()) {
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
          yield { type: "content", content: "\n> [budget] " + discoverWarn + "\n" } as StreamChunk;
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
        stateMap.sections.set("Resume Digest", "Stage: Gather - Defining product dimensions");
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
            yield { type: "content", content: "\n> [budget] " + gatherWarn + "\n" } as StreamChunk;
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
        stateMap.sections.set("Resume Digest", "Stage: Research - Multi-expert debate");
        await writeArtifact(runDir, "state.md", stateMap);

        // inside research phase, before building councilTopic:
        const projectCtx = await readProjectContext(ctx.flowDir, ctx.runId);
        if (projectCtx) {
          conversationContext += "\n\nProject Context:\n" + formatProjectContextForPrompt(projectCtx);
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
          const { isEcosystemBiasEnabled, buildEcosystemResearchSeed } = await import("./discovery-ecosystem.js");
          if (isEcosystemBiasEnabled()) {
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

        const debateGen = runDebate(
          clarifiedSpec,
          {
            topic: ctx.idea,
            conversationContext,
            leaderModelId,
            participants,
          },
          wrapLLMForUsageTracking(ctx.llm, ctx),
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
        } catch (err) {
          // The debate iterator hit an exception (e.g. provider 5xx after the
          // retry budget). Persist an audit row before re-throwing so we have
          // a forensics trail — without it the FSM unwinds silently and the
          // session looks like "research = 0 word" in the DB.
          logLoopEvent(ctx, "council_error", {
            phase: "research",
            stage: "debate",
            error: err instanceof Error ? err.message : String(err),
            roundCount: debateState?.roundCount ?? 0,
            participantCount: participants.length,
            elapsedMs: Date.now() - researchPhaseStartMs,
          });
          throw err;
        }

        // Forensics row mirrors the council/index.ts council_summary record
        // (which only fires for sprint planning via runCouncil). The /ideal
        // initial debate goes through runDebate here and was previously
        // invisible to `usage forensics`. Excerpts are capped to keep
        // metadata_json bounded (~2-4KB per debate).
        if (debateState) {
          const stancesForLog = participants.slice(0, 8).map((p, i) => {
            const finalPosition = debateState!.active?.[i]?.position ?? "";
            return {
              role: p.role,
              model: p.model,
              stanceName: p.stance?.name,
              finalPositionExcerpt: finalPosition.slice(0, 400),
            };
          });
          logLoopEvent(ctx, "council_summary", {
            phase: "research",
            topic: ctx.idea,
            roundCount: debateState.roundCount ?? 0,
            participantCount: participants.length,
            stances: stancesForLog,
            summaryExcerpt: (debateState.runningSummary ?? "").slice(0, 1500),
            researchFindingsExcerpt: (debateState.researchFindings ?? "").slice(0, 1500),
            durationMs: Date.now() - researchPhaseStartMs,
          });
        }

        const summaryText =
          (debateState?.runningSummary && debateState.runningSummary.trim()) ||
          "(debate produced no summary — using empty research findings)";
        yield {
          type: "council_info_card",
          councilInfoCard: buildResearchSummaryCard(summaryText, debateState?.researchFindings),
        } as StreamChunk;

        // Append research summary to delegations.md
        const delegationsMap = (await readArtifact(runDir, "delegations.md")) ?? { preamble: "", sections: new Map() };
        delegationsMap.sections.set("Research Summary", debateState.runningSummary);
        if (debateState.researchFindings) {
          delegationsMap.sections.set("Research Findings", debateState.researchFindings);
        }
        await writeArtifact(runDir, "delegations.md", delegationsMap);

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
          yield { type: "content", content: "\n> [budget] " + researchWarn + "\n" } as StreamChunk;
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
        } catch (err) {
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
          yield { type: "content", content: "\n> [budget] " + scopingWarn + "\n" } as StreamChunk;
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
