/**
 * src/pil/pipeline.ts
 *
 * runPipeline() entry point: orchestrates 6 sequential layers with an
 * adaptive timeout. Fail-open: any unhandled error or timeout returns the
 * original fallback context.
 *
 * Timeout budget:
 *   - 200ms when EE is disabled / not reachable (fast regex-only path).
 *   - 3000ms when EE thin/thin-degraded mode is active so Layer 1 can hit
 *     the remote `/api/brain` endpoint and Layer 6 can refine output style.
 *
 * CRITICAL: fallback is captured BEFORE runLayers() starts to ensure the timeout
 * path returns a pristine context (Pitfall 4 from RESEARCH.md).
 */

import { getCachedServerBaseUrl } from "../ee/auth.js";
import { getCachedEEClientMode } from "../ee/client-mode.js";
import { classifyEeError, logEeFailure } from "../utils/ee-logger.js";
import { DEFAULT_TOKEN_BUDGET } from "./budget.js";
import { appendPilLog } from "./budget-log.js";
import { isDiscoveryEnabled } from "./config.js";
import { scoreComplexitySize } from "./layer1_5-complexity-size.js";
import { layer1Intent } from "./layer1-intent.js";
import { layer2Personality } from "./layer2-personality.js";
import { layer3EeInjection, surfaceCompactionArtifacts } from "./layer3-ee-injection.js";
import { layer4Gsd } from "./layer4-gsd.js";
import { layer5Context } from "./layer5-context.js";
import { isMetaAnalysisPrompt, layer6Output } from "./layer6-output.js";
import { PipelineContextSchema } from "./schema.js";
import { bumpSessionTurn } from "./session-state.js";
import { setPilLastResult } from "./store.js";
import { resolveAfter } from "./timeout.js";
import type { PipelineContext } from "./types.js";

const PIPELINE_TIMEOUT_FAST_MS = 1500;
// Sized from measured /api/pil-context distribution after server-side
// classify+embed parallelization (commit 5b77bab in experience-engine).
// 120-call sample: p50=1155ms, p95=2171ms, p99=2734ms, max=3105ms. 3500ms
// gives ~800ms margin over p99. Raised FAST from 200→1500 for agent comfort
// on turns where no EE serverBaseUrl is configured (brain path already uses 3500
// via getCachedServerBaseUrl() or getCachedEEClientMode()).
const PIPELINE_TIMEOUT_BRAIN_MS = 3500;

function pipelineTimeoutMs(): number {
  // Allow test environments to override the timeout to avoid flaky races when
  // the test process is under load (e.g., running 1600+ tests concurrently).
  const envOverride = process.env.MUONROI_TEST_PIPELINE_TIMEOUT_MS;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const mode = getCachedEEClientMode();
  if (mode && (mode.mode === "thin" || mode.mode === "thin-degraded" || mode.mode === "fat")) {
    return PIPELINE_TIMEOUT_BRAIN_MS;
  }
  // Boot race fallback: detectEEClientMode() is fire-and-forget at startup
  // (src/index.ts) and its /health probe can take up to 1500ms. Any prompt
  // submitted before the probe resolves saw mode=null and fell through to the
  // 200ms FAST budget, killing the brain call. loadEEAuthToken() IS awaited
  // at boot, so a configured serverBaseUrl is a reliable signal that the user
  // intends thin mode — use BRAIN budget optimistically. If the probe later
  // fails, mode becomes "thin-degraded" which the branch above also covers.
  if (getCachedServerBaseUrl()) {
    return PIPELINE_TIMEOUT_BRAIN_MS;
  }
  return PIPELINE_TIMEOUT_FAST_MS;
}

const SKIPPED_LAYERS: Array<{ timingName: string; deltaName: string }> = [
  { timingName: "layer2-personality", deltaName: "personality-adaptation" },
  { timingName: "layer3-ee-injection", deltaName: "ee-experience-injection" },
  { timingName: "layer4-gsd-structuring", deltaName: "gsd-workflow-structuring" },
  { timingName: "layer5-context-enrichment", deltaName: "context-enrichment" },
];

async function runLayers(ctx: PipelineContext, options?: PipelineOptions): Promise<PipelineContext> {
  const pipelineStart = Date.now();
  const timings: Array<{ name: string; ms: number }> = [];
  // Track each layer's contribution to the enriched-prompt size so the
  // PIL budget log can attribute system-prompt bloat to a specific layer.
  const layerSnapshots: Array<{
    name: string;
    charsBefore: number;
    charsAfter: number;
    charsDelta: number;
    durationMs: number;
  }> = [];

  async function timed(name: string, fn: (c: PipelineContext) => Promise<PipelineContext>): Promise<void> {
    const start = Date.now();
    const charsBefore = ctx.enriched.length;
    ctx = await fn(ctx);
    const ms = Date.now() - start;
    const charsAfter = ctx.enriched.length;
    timings.push({ name, ms });
    layerSnapshots.push({ name, charsBefore, charsAfter, charsDelta: charsAfter - charsBefore, durationMs: ms });
  }

  await timed("layer1-intent", (c) => layer1Intent(c, { llmFallback: options?.llmFallback }));

  // Layer 1.5: deterministic complexity-size classification. Pure heuristic,
  // no LLM call, no network. Consumed by 4B (step ceiling matrix) and 4A
  // (scope-reminder cadence K). Mirrored into _intentTrace for forensics.
  {
    const sizeResult = scoreComplexitySize({
      rawText: ctx.raw,
      taskType: ctx.taskType ?? "general",
    });
    ctx = {
      ...ctx,
      complexitySize: sizeResult,
      _intentTrace: ctx._intentTrace
        ? {
            ...ctx._intentTrace,
            complexitySize: sizeResult.size,
            complexitySizeScore: sizeResult.score,
          }
        : ctx._intentTrace,
    };
  }

  // Phase 1 discovery: L1.5–L1.8 (interactive, no hard timeout)
  if (isDiscoveryEnabled() && ctx.intentKind !== "chitchat") {
    const { runDiscovery } = await import("./discovery.js");
    const discoveryStart = Date.now();
    try {
      const l1Result = {
        taskType: ctx.taskType,
        confidence: ctx.confidence,
        complexity: (ctx._intentTrace?.complexity ?? "low") as "low" | "medium" | "high",
        domain: ctx.domain,
        outputStyle: ctx.outputStyle,
        intentKind: ctx.intentKind ?? null,
      };
      const discovery = await runDiscovery(
        ctx.raw,
        l1Result,
        process.cwd(),
        options?.interactionHandler ?? null,
        ctx.sessionId ?? null,
        options?.clarificationProposer ?? null,
        options?.recentTurnsSummary ?? null,
      );
      ctx = { ...ctx, _discoveryResult: discovery };
      if (discovery.interviewed && discovery.accepted) {
        const discoveryPrefix = [
          `[Discovery] Intent: ${discovery.intentStatement}`,
          `[Discovery] Outcome: ${discovery.outcome}`,
          discovery.scope.length > 0 ? `[Discovery] Scope: ${discovery.scope.join(", ")}` : "",
          discovery.feasibilityWarnings.length > 0
            ? `[Discovery] Warnings: ${discovery.feasibilityWarnings.join("; ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        ctx = { ...ctx, enriched: `${discoveryPrefix}\n\n${ctx.enriched}` };
      }
      if (!discovery.accepted) {
        return { ...ctx, enriched: ctx.raw, fallbackReason: "discovery-cancelled" };
      }
    } catch (err) {
      console.error("[Agent:discovery] runDiscovery failed — continuing with L1 result only", err);
    }
    timings.push({ name: "discovery", ms: Date.now() - discoveryStart });
  }

  if (ctx.taskType !== null) {
    await timed("layer2-personality", layer2Personality);
    if (isMetaAnalysisPrompt(ctx.raw)) {
      // FIX: skip heavy EE (layer3) + context (layer5) for meta-analysis turns
      // to reduce PIL overhead on evaluation/improvement questions (as intended).
      await timed("layer4-gsd-structuring", layer4Gsd);
      // Issue #4: full Layer 3 is skipped here, but a self-evaluating agent still
      // needs the elided high-value tool-artifacts surfaced so it doesn't have to
      // guess one exists and hand-call ee_query. One cheap, fail-open EE arm.
      await timed("ee-meta-artifacts", surfaceCompactionArtifacts);
    } else {
      await timed("layer3-ee-injection", layer3EeInjection);
      await timed("layer4-gsd-structuring", layer4Gsd);
      await timed("layer5-context-enrichment", layer5Context);
    }
  } else {
    for (const { timingName } of SKIPPED_LAYERS) {
      timings.push({ name: timingName, ms: 0 });
    }
    ctx = {
      ...ctx,
      layers: [
        ...ctx.layers,
        ...SKIPPED_LAYERS.map(({ deltaName }) => ({
          name: deltaName,
          applied: false,
          delta: "skipped:null-taskType",
        })),
      ],
    };
  }

  await timed("layer6-output", layer6Output);

  const suffixCharsMatch = ctx.layers.find((l) => l.name === "output-optimization")?.delta?.match(/chars=(\d+)/);
  const suffixChars = suffixCharsMatch ? parseInt(suffixCharsMatch[1], 10) : 0;

  const enrichmentCharsAdded = Math.max(0, ctx.enriched.length - ctx.raw.length);

  ctx = {
    ...ctx,
    metrics: {
      totalMs: Date.now() - pipelineStart,
      layerTimings: timings,
      inputChars: ctx.raw.length,
      outputChars: ctx.enriched.length,
      suffixInstructionTokens: Math.round(suffixChars / 4),
      enrichmentTokensAdded: Math.round(enrichmentCharsAdded / 4),
    },
  };

  // Best-effort PIL budget log — attributes prompt-size growth to each layer.
  // Fire-and-forget; never await on the hot path.
  appendPilLog({
    ts: pipelineStart,
    sessionId: ctx.sessionId ?? null,
    taskType: ctx.taskType ?? null,
    domain: ctx.domain ?? null,
    confidence: ctx.confidence ?? 0,
    rawChars: ctx.raw.length,
    enrichedChars: ctx.enriched.length,
    totalDeltaChars: ctx.enriched.length - ctx.raw.length,
    totalMs: Date.now() - pipelineStart,
    layers: layerSnapshots,
    fallbackReason: ctx.fallbackReason ?? null,
    intentDetection: ctx._intentTrace ?? null,
  }).catch((err) => {
    logEeFailure("pil.pipeline.logInteraction", classifyEeError(err), err);
    return undefined;
  });

  return ctx;
}

export interface PipelineOptions {
  gsdPhase?: string | null;
  resumeDigest?: string | null;
  activeRunId?: string | null;
  sessionId?: string | null;
  interactionHandler?: import("./discovery-types.js").DiscoveryInteractionHandler | null;
  /**
   * Optional LLM classifier fallback used by Layer 1 Pass 4 when the EE brain
   * (pilContext) returns null or low confidence. Caller constructs this with
   * `createLlmClassifier(providerFactory, modelId)` from `llm-classify.ts` so
   * PIL stays ignorant of provider-factory wiring.
   */
  llmFallback?: import("./llm-classify.js").LlmClassifyFn;
  /**
   * Optional model-driven clarification proposer for interactive discovery.
   * When provided (by orchestrator), runDiscovery will ask the actual task model
   * to generate the interview questions based on raw + CLI enrichment so far.
   * Mirrors the llmFallback closure pattern so PIL stays ignorant of provider wiring.
   */
  clarificationProposer?: import("./discovery-types.js").ModelClarificationProposer;
  /**
   * Summary of recent conversation history. Passed to the model-driven clarification
   * proposer so it can semantically detect follow-up intents and avoid asking for
   * context that was already established in prior turns.
   */
  recentTurnsSummary?: string | null;
}

export async function runPipeline(raw: string, options?: PipelineOptions): Promise<PipelineContext> {
  // Bump the per-session turn counter BEFORE any pipeline work so discovery
  // can distinguish first-turn (full interview) from follow-ups (skip).
  // Safe to call with null sessionId — bumpSessionTurn no-ops in that case.
  bumpSessionTurn(options?.sessionId ?? null);

  const fallback: PipelineContext = {
    raw,
    enriched: raw,
    taskType: null,
    domain: null,
    confidence: 0,
    outputStyle: null,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    metrics: null,
    layers: [],
    gsdPhase: options?.gsdPhase ?? null,
    resumeDigest: options?.resumeDigest ?? null,
    activeRunId: options?.activeRunId ?? null,
    sessionId: options?.sessionId ?? null,
    fallbackReason: null,
  };
  try {
    const hasInteractiveDiscovery = !!options?.interactionHandler && isDiscoveryEnabled();
    const result = hasInteractiveDiscovery
      ? await runLayers({ ...fallback }, options)
      : await Promise.race([
          runLayers({ ...fallback }, options),
          resolveAfter(pipelineTimeoutMs(), { ...fallback, fallbackReason: "pipeline-timeout" } as PipelineContext),
        ]);
    const parse = PipelineContextSchema.safeParse(result);
    if (!parse.success) {
      const validated: PipelineContext = {
        ...fallback,
        fallbackReason: `schema-reject:${parse.error.issues[0]?.path?.join(".") ?? "unknown"}`,
      } as PipelineContext;
      setPilLastResult(validated);
      return validated;
    }
    setPilLastResult(result);
    return result;
  } catch (err) {
    const reason = err instanceof Error ? `exception:${err.name}` : "exception:unknown";
    const failed = { ...fallback, fallbackReason: reason } as PipelineContext;
    setPilLastResult(failed);
    return failed;
  }
}
