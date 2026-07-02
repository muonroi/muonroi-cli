// CouncilManager — extracted from orchestrator.ts as part of Phase 12.1-02.
//
// Owns council state (resolvers + buffers + stats + synthesis/continuation
// flags) and helper logic (_councilGenerate, _councilResearch, prompt builders,
// outcome parser/executor, candidate resolution). The public council generators
// (runCouncilV2, runCouncilRound, runProductLoopV1) remain on Agent because
// they invoke Agent-private methods (processMessage, appendCompletedTurn,
// runTask) heavily — those methods delegate INTO this manager for sub-pieces.
//
// Zero behavioral changes — every method body is copied verbatim from the
// original orchestrator.ts (see commit history), only `this.xxx` → `this.deps.xxx()`
// transposition where the field/method originally lived on Agent.

import { generateText, type ModelMessage, stepCountIs } from "ai";
import { getModelsForProvider } from "../models/registry.js";
import { loadKeyForProvider } from "../providers/keychain.js";
import {
  createProviderFactory,
  detectProviderForModel,
  resolveModelRuntime,
  shouldDropParam,
} from "../providers/runtime.js";
import { ALL_PROVIDER_IDS, type ProviderId } from "../providers/types.js";
import { getRoutedModelByTier } from "../router/peak-hour.js";
import { appendSystemMessage } from "../storage/index.js";
import type { BashTool } from "../tools/bash";
import { createBuiltinTools } from "../tools/registry.js";
import type { AgentMode, StreamChunk } from "../types/index";
import { isProviderDisabled, type ModelRole } from "../utils/settings";
import {
  COUNCIL_COLOR_BG,
  COUNCIL_COLOR_RESET,
  COUNCIL_ROLE_COLORS,
  type CouncilOutcome,
  type LegacyProvider,
} from "./agent-options";
import { extractUserContent, getCompactionSummaryText, isCompactionSummaryMessage } from "./compaction";

/**
 * Dependency callbacks the CouncilManager needs to reach back into Agent state
 * without holding a circular reference.
 */
export interface CouncilManagerDeps {
  /** Current session model id. */
  getModelId(): string;
  /** Current session id (for appendSystemMessage / memory). */
  getSessionId(): string | null;
  /** Whether a SessionStore is attached (gates memory writes). */
  hasSessionStore(): boolean;
  /** Read-only view of current conversation messages (for context builder). */
  getMessages(): ReadonlyArray<ModelMessage>;
  /** Current bash tool — needed for research-tool createBuiltinTools wiring. */
  getBash(): BashTool;
  /** Current agent mode — needed for createBuiltinTools. */
  getMode(): AgentMode;
}

/**
 * CouncilManager — extracted council subsystem.
 *
 * Owns: resolver/buffer maps, stats, synthesis/continuation flags, and helper
 * generators (_councilGenerate, _councilResearch, prompt builders, outcome
 * parser/executor, candidate resolution).
 *
 * The legacy generator entrypoints (runCouncilV2/runCouncilRound/runProductLoopV1)
 * remain on Agent because they touch Agent-private methods (processMessage,
 * appendCompletedTurn) — they delegate inwards via this manager for helpers.
 */
export class CouncilManager {
  // ---- Mutable state (was Agent private fields) ----
  private _lastSynthesis: string | null = null;
  private _isContinuation = false;
  private _questionResolvers = new Map<string, (answer: string) => void>();
  private _preflightResolvers = new Map<string, (approved: boolean) => void>();
  private _bufferedQuestionAnswers = new Map<string, string>();
  private _bufferedPreflightApprovals = new Map<string, boolean>();
  /** Council telemetry — counts API calls and tracks debate start time. */
  public stats: { calls: number; startMs: number } = { calls: 0, startMs: 0 };

  constructor(private deps: CouncilManagerDeps) {}

  // ---- State accessors (replace direct field reads from Agent inline sites) ----
  get lastSynthesis(): string | null {
    return this._lastSynthesis;
  }
  setLastSynthesis(v: string | null): void {
    this._lastSynthesis = v;
  }
  get isContinuation(): boolean {
    return this._isContinuation;
  }
  setContinuation(v: boolean): void {
    this._isContinuation = v;
  }
  resetStats(startMs?: number): void {
    this.stats = { calls: 0, startMs: startMs ?? 0 };
  }

  // ---- Public responder API (delegated from Agent.respondToCouncilQuestion etc) ----
  respondToQuestion(questionId: string, answer: string, questionText?: string): void {
    if (process.env.MUONROI_DEBUG_LEADER === "1") {
      process.stderr.write(
        `[responder] respondToCouncilQuestion: ${JSON.stringify({
          questionId,
          answerPreview: answer.slice(0, 40),
          hadResolver: this._questionResolvers.has(questionId),
          pendingResolverCount: this._questionResolvers.size,
        })}\n`,
      );
    }
    const resolver = this._questionResolvers.get(questionId);
    if (resolver) {
      resolver(answer);
      this._questionResolvers.delete(questionId);
      if (questionText) {
        import("../gsd/phase-sync.js")
          .then(({ appendClarificationToContext }) => {
            const cwd = this.deps.getBash().getCwd();
            appendClarificationToContext(cwd, questionText, answer);
          })
          .catch(() => {});
      }
    } else {
      // Headless auto-answer: response arrived before the generator registered
      // its resolver. Buffer it; `createQuestionResponder` will drain it.
      this._bufferedQuestionAnswers.set(questionId, answer);
    }
  }

  respondToPreflight(preflightId: string, approved: boolean): void {
    const resolver = this._preflightResolvers.get(preflightId);
    if (resolver) {
      resolver(approved);
      this._preflightResolvers.delete(preflightId);
    } else {
      this._bufferedPreflightApprovals.set(preflightId, approved);
    }
  }

  createQuestionResponder(): (questionId: string) => Promise<string> {
    return (questionId: string) =>
      new Promise<string>((resolve) => {
        const buffered = this._bufferedQuestionAnswers.get(questionId);
        if (buffered !== undefined) {
          if (process.env.MUONROI_DEBUG_LEADER === "1") {
            process.stderr.write(
              `[responder] drain-buffered: ${JSON.stringify({ questionId, bufferedSize: this._bufferedQuestionAnswers.size })}\n`,
            );
          }
          this._bufferedQuestionAnswers.delete(questionId);
          resolve(buffered);
          return;
        }
        if (process.env.MUONROI_DEBUG_LEADER === "1") {
          process.stderr.write(
            `[responder] register-resolver: ${JSON.stringify({ questionId, totalResolvers: this._questionResolvers.size + 1 })}\n`,
          );
        }
        this._questionResolvers.set(questionId, resolve);
      });
  }

  createPreflightResponder(): (preflightId: string) => Promise<boolean> {
    return (preflightId: string) =>
      new Promise<boolean>((resolve) => {
        const buffered = this._bufferedPreflightApprovals.get(preflightId);
        if (buffered !== undefined) {
          this._bufferedPreflightApprovals.delete(preflightId);
          resolve(buffered);
          return;
        }
        this._preflightResolvers.set(preflightId, resolve);
      });
  }

  // ---- Council sub-call helpers ----

  /**
   * Generate a single text completion using the model's runtime — used by
   * round/synthesis/conv-check phases. Increments stats.calls.
   */
  async generate(modelId: string, system: string, prompt: string, maxTokens = 2048): Promise<string> {
    const providerId = detectProviderForModel(modelId);
    const key = await loadKeyForProvider(providerId);
    const provider = createCouncilProvider(providerId, key);
    const runtime = resolveModelRuntime(provider, modelId);
    const { text } = await generateText({
      model: runtime.model,
      system,
      prompt,
      ...(shouldDropParam(runtime, "maxOutputTokens") ? {} : { maxOutputTokens: maxTokens }),
      ...(shouldDropParam(runtime, "temperature") ? {} : { temperature: 0.7 }),
      ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
    });
    this.stats.calls++;
    return text;
  }

  /**
   * Research phase: runs a model with tools (bash, grep, read_file, search_web)
   * to gather real data about the topic before discussion. Returns a structured
   * research findings string. Errors are caught and rendered as a fallback report.
   */
  async research(modelId: string, topic: string, conversationContext: string, signal?: AbortSignal): Promise<string> {
    const providerId = detectProviderForModel(modelId);
    const key = await loadKeyForProvider(providerId);
    const provider = createCouncilProvider(providerId, key);
    const runtime = resolveModelRuntime(provider, modelId);

    // Build tool set with bash, grep, read_file for codebase research
    const researchTools = createBuiltinTools(this.deps.getBash(), this.deps.getMode(), {
      // research phase intentionally has no runTask/runDelegation handlers
      sessionId: this.deps.getSessionId() ?? undefined,
    });

    const systemPrompt =
      `You are a research specialist. Your job is to gather FACTS about the topic below.\n\n` +
      `## Instructions\n` +
      `- Use available tools (bash, read_file, grep) to investigate the codebase and find relevant files, code, or configurations\n` +
      `- Search for existing patterns, implementations, or decisions related to the topic\n` +
      `- Report EXACT findings: file paths, function names, error messages, code snippets\n` +
      `- Do NOT make assumptions or speculate — only report what you find\n` +
      `- If you can't find anything relevant, say so explicitly\n\n` +
      `## Output Format\n` +
      `After your investigation, produce a research report with:\n` +
      `## Research Findings\n` +
      `- [fact 1 with source]\n` +
      `- [fact 2 with source]\n\n` +
      `## Key Evidence\n` +
      `- [code snippets or file paths that are most relevant]\n\n` +
      `## Gaps\n` +
      `- [what we don't know yet or couldn't verify]\n`;

    const userPrompt = conversationContext
      ? `## Context\n${conversationContext}\n\n---\n\n## Research Topic\n${topic}\n\nInvestigate the codebase and report your findings.`
      : `## Research Topic\n${topic}\n\nInvestigate the codebase and report your findings.`;

    try {
      const { text } = await generateText({
        model: runtime.model,
        system: systemPrompt,
        prompt: userPrompt,
        tools: researchTools,
        stopWhen: stepCountIs(10),
        ...(shouldDropParam(runtime, "maxOutputTokens") ? {} : { maxOutputTokens: 4096 }),
        ...(shouldDropParam(runtime, "temperature") ? {} : { temperature: 0.3 }),
        ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      });
      this.stats.calls++;
      return text;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `## Research Findings\n[Research failed: ${errMsg}]\n\n## Gaps\n- Could not complete research due to error`;
    }
  }

  buildDiscussPrompt(
    phase: "open" | "respond" | "followup" | "convergence-check",
    ctx: {
      speakerRole: string;
      partnerRole: string;
      topic: string;
      speakerPosition?: string;
      partnerPosition?: string;
      exchangeHistory?: string;
      round?: number;
      conversationContext?: string;
      runningSummary?: string;
    },
  ): { system: string; prompt: string } {
    switch (phase) {
      case "open":
        return {
          system:
            `You are a ${ctx.speakerRole} specialist. You are entering a discussion with a ${ctx.partnerRole} specialist about a technical topic.\n\n` +
            (ctx.conversationContext
              ? `## Conversation Context (before this discussion)\n${ctx.conversationContext}\n\n---\n\n`
              : "") +
            `Share your analysis naturally — explain your reasoning, the trade-offs you see, and what concerns you.\n` +
            `End by asking the ${ctx.partnerRole} for their perspective on your analysis. What do they see differently?`,
          prompt: `Topic for discussion:\n${ctx.topic}`,
        };

      case "respond":
        return {
          system:
            `You are a ${ctx.speakerRole} specialist in a discussion with a ${ctx.partnerRole} specialist.\n\n` +
            `A colleague shared their analysis below. Give your honest take:\n` +
            `- Where you agree, say so briefly and build on it\n` +
            `- Where you disagree, explain why with your own reasoning — not to attack, but to offer a different lens\n` +
            `- Share what you think they might be missing from your ${ctx.speakerRole} perspective\n\n` +
            `End with a question back to them: based on your analysis, what's their view? Do they agree, or do they see it differently?`,
          prompt:
            `Their analysis (${ctx.partnerRole}):\n${ctx.partnerPosition}\n\n` +
            `Your own analysis for context:\n${ctx.speakerPosition}`,
        };

      case "followup":
        return {
          system:
            `You are a ${ctx.speakerRole} specialist continuing a discussion (round ${ctx.round}) with a ${ctx.partnerRole} specialist.\n\n` +
            (ctx.runningSummary
              ? `## Discussion State So Far\n${ctx.runningSummary}\n\n` +
                `Focus on UNRESOLVED points only. Do not repeat agreed positions.\n\n`
              : "") +
            `Read their latest response and the exchange so far. Then:\n` +
            `- If they raised valid points, acknowledge them and update your thinking\n` +
            `- If you still disagree on something, explain why — bring new evidence or a different angle, not the same argument again\n` +
            `- If you've changed your mind on something, say so explicitly\n\n` +
            `Be concise. End with: do you agree with where we've landed? Or is there something we're still seeing differently?`,
          prompt:
            `Discussion so far:\n${ctx.exchangeHistory}\n\n` +
            `Their latest response (${ctx.partnerRole}):\n${ctx.partnerPosition}`,
        };

      case "convergence-check":
        return {
          system:
            `Analyze this discussion between a ${ctx.speakerRole} and a ${ctx.partnerRole}. ` +
            `Respond with ONLY a JSON object, no other text:\n` +
            `{"converged": true/false, "reason": "one sentence explaining why"}`,
          prompt: `Discussion:\n${ctx.exchangeHistory}`,
        };
    }
  }

  async generateRoundSummary(
    exchangeLogs: Map<string, string[]>,
    topic: string,
    round: number,
    modelId: string,
  ): Promise<string> {
    const allExchanges = [...exchangeLogs.values()].flat().slice(-6).join("\n\n");
    return this.generate(
      modelId,
      "Summarize this discussion in 3-5 bullet points. Focus on:\n" +
        "1. Points where participants AGREE\n" +
        "2. Points still in DISPUTE (with each side's core argument)\n" +
        "3. New EVIDENCE or perspectives raised this round\n" +
        "Be concise — one line per bullet. No preamble.",
      `Round ${round} discussion on: ${topic}\n\n${allExchanges}`,
      512,
    );
  }

  /**
   * Build conversation context for council discussion from current session messages.
   * Extracts: compaction summary, recent user messages, key decisions.
   * Limited to ~3000 tokens to avoid excessive cost.
   */
  buildContext(): string {
    const messages = this.deps.getMessages();
    const parts: string[] = [];

    // 1. Compaction summary (first message if it's a summary)
    if (messages.length > 0) {
      const first = messages[0];
      if (isCompactionSummaryMessage(first)) {
        const summary = getCompactionSummaryText(first);
        if (summary) {
          parts.push(`## Session Context (from compaction summary)\n${summary}`);
        }
      }
    }

    // 2. Recent user messages (last 3-5 user turns)
    const userMessages: string[] = [];
    for (let i = messages.length - 1; i >= 0 && userMessages.length < 5; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractUserContent(msg.content);
        if (text.trim()) {
          userMessages.unshift(`- ${text.slice(0, 2000).trim()}`);
        }
      }
    }
    if (userMessages.length > 0) {
      parts.push(`## Recent User Messages\n${userMessages.join("\n")}`);
    }

    // 3. Key decisions from council memory if available
    const councilMemories: string[] = [];
    for (const msg of messages) {
      if (msg.role === "system" && typeof msg.content === "string" && msg.content.includes("[Council Memory]")) {
        councilMemories.push(msg.content);
      }
    }
    if (councilMemories.length > 0) {
      parts.push(`## Previous Council Outcomes\n${councilMemories.slice(-2).join("\n\n")}`);
    }

    const combined = parts.join("\n\n---\n\n");
    // Rough token estimate: char/4
    if (combined.length > 12000) {
      return `${combined.slice(0, 12000)}\n\n[... context truncated to fit token budget]`;
    }
    return combined;
  }

  parseOutcome(synthesisText: string, _topic: string): CouncilOutcome | null {
    try {
      const jsonMatch = synthesisText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as Partial<CouncilOutcome>;
      if (!parsed.type || !parsed.summary) return null;
      return {
        type: parsed.type,
        summary: parsed.summary,
        agreed: parsed.agreed ?? [],
        tradeoffs: parsed.tradeoffs ?? [],
        recommendation: parsed.recommendation ?? "",
        actionItems: parsed.actionItems,
        planUpdate: parsed.planUpdate,
        resolvedQuestion: parsed.resolvedQuestion,
      };
    } catch {
      return null;
    }
  }

  async *executeOutcome(outcome: CouncilOutcome, topic: string): AsyncGenerator<StreamChunk, void, unknown> {
    const sessionId = this.deps.getSessionId();
    switch (outcome.type) {
      case "decision":
        if (sessionId) {
          try {
            appendSystemMessage(
              sessionId,
              `[Council Decision]\nTopic: ${topic}\n${outcome.summary}\nAgreed: ${outcome.agreed.join("; ")}\nRecommendation: ${outcome.recommendation}`,
            );
          } catch {
            /* non-critical */
          }
        }
        yield { type: "content", content: `\n> Decision recorded.\n` };
        break;

      case "action_items":
        if (outcome.actionItems?.length) {
          const itemsText = outcome.actionItems.map((item, i) => `${i + 1}. ${item}`).join("\n");
          yield { type: "content", content: `\n### Action Items\n${itemsText}\n` };
          if (sessionId) {
            try {
              appendSystemMessage(sessionId, `[Council Action Items]\nTopic: ${topic}\n${itemsText}`);
            } catch {
              /* non-critical */
            }
          }
        }
        break;

      case "plan_update":
        if (outcome.planUpdate) {
          try {
            const { ensureFlowDir } = await import("../flow/scaffold.js");
            const { getActiveRunId, updateRunFile } = await import("../flow/run-manager.js");
            const { readArtifact } = await import("../flow/artifact-io.js");
            const nodePath = await import("node:path");
            const flowDir = await ensureFlowDir(this.deps.getBash().getCwd());
            const runId = await getActiveRunId(flowDir);
            if (runId) {
              const currentPlan = await readArtifact(nodePath.join(flowDir, "runs", runId), "roadmap.md");
              if (currentPlan) {
                currentPlan.sections.set("Council Update", outcome.planUpdate);
                await updateRunFile(flowDir, runId, "roadmap.md", currentPlan);
                yield { type: "content", content: `\n> Plan updated with council recommendations.\n` };
              }
            }
          } catch {
            /* flow dir may not exist — non-critical */
          }
          if (sessionId) {
            try {
              appendSystemMessage(sessionId, `[Council Plan Update]\nTopic: ${topic}\n${outcome.planUpdate}`);
            } catch {
              /* non-critical */
            }
          }
        }
        break;

      case "resolve_question":
        if (outcome.resolvedQuestion) {
          yield { type: "content", content: `\n> Question resolved: ${outcome.resolvedQuestion.question}\n` };
          if (sessionId) {
            try {
              appendSystemMessage(
                sessionId,
                `[Council Resolution]\nQ: ${outcome.resolvedQuestion.question}\nA: ${outcome.resolvedQuestion.answer}`,
              );
            } catch {
              /* non-critical */
            }
          }
        }
        break;
    }
  }

  hasMultiProviderConfig(roleModels: Partial<Record<ModelRole, string>>): boolean {
    const providers = new Set<string>();
    for (const modelId of Object.values(roleModels)) {
      if (modelId) providers.add(detectProviderForModel(modelId));
    }
    return providers.size >= 2;
  }

  /**
   * When the session's default provider is disabled, find the first
   * non-disabled provider with a reachable key and return its model.
   * Falls back to the session model if no alternative is available.
   */
  async resolveNonDisabledFallback(): Promise<{ modelId: string }> {
    const fallbackProviders: readonly ProviderId[] = ALL_PROVIDER_IDS;
    for (const p of fallbackProviders) {
      if (!isProviderDisabled(p)) {
        const key = await loadKeyForProvider(p).catch(() => null);
        if (key) {
          const m = getRoutedModelByTier("balanced", p);
          // Guard: getModelByTier may return a model from a different provider
          // when the preferred provider has no model for the requested tier.
          if (m && m.provider === p) return { modelId: m.id };
          const models = getModelsForProvider(p);
          if (models.length > 0) return { modelId: models[0].id };
        }
      }
    }
    // All fallback providers also disabled or unreachable — keep session model
    return { modelId: this.deps.getModelId() };
  }

  async resolveSameProviderCandidates(
    providerId: ProviderId,
    roles: ModelRole[],
  ): Promise<Array<{ role: ModelRole; model: string }>> {
    const canReach = await loadKeyForProvider(providerId)
      .then(() => true)
      .catch(() => false);
    if (!canReach) return [];

    const providerModels = getModelsForProvider(providerId);
    if (providerModels.length === 0) {
      return roles.map((role) => ({ role, model: this.deps.getModelId() }));
    }

    const tierPreference: Record<string, Array<"fast" | "balanced" | "premium">> = {
      implement: ["balanced", "premium", "fast"],
      verify: ["premium", "balanced", "fast"],
      research: ["fast", "balanced", "premium"],
    };

    const usedModels = new Set<string>();
    const candidates: Array<{ role: ModelRole; model: string }> = [];

    for (const role of roles) {
      const prefs = tierPreference[role] ?? ["balanced", "fast", "premium"];
      let picked = providerModels.find((m) => prefs.some((t) => m.tier === t) && !usedModels.has(m.id));
      if (!picked) picked = providerModels.find((m) => !usedModels.has(m.id));
      if (!picked) picked = providerModels[0];

      candidates.push({ role, model: picked.id });
      usedModels.add(picked.id);
    }

    return candidates;
  }

  // ---- Color helpers (re-exposed so orchestrator inline sites can stay tight) ----
  static readonly ROLE_COLORS = COUNCIL_ROLE_COLORS;
  static readonly COLOR_BG = COUNCIL_COLOR_BG;
  static readonly COLOR_RESET = COUNCIL_COLOR_RESET;
}

/**
 * Internal: build a provider factory using the shared runtime factory.
 * Mirrors `createProvider` in orchestrator.ts to keep council sub-calls
 * decoupled from Agent state.
 */
function createCouncilProvider(providerId: ProviderId, apiKey: string, baseURL?: string): LegacyProvider {
  return createProviderFactory(providerId, { apiKey, baseURL }).factory;
}
