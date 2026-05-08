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

import { getCachedEEClientMode } from "../ee/client-mode.js";
import { DEFAULT_TOKEN_BUDGET } from "./budget.js";
import { layer1Intent } from "./layer1-intent.js";
import { layer2Personality } from "./layer2-personality.js";
import { layer3EeInjection } from "./layer3-ee-injection.js";
import { layer4Gsd } from "./layer4-gsd.js";
import { layer5Context } from "./layer5-context.js";
import { layer6Output } from "./layer6-output.js";
import { PipelineContextSchema } from "./schema.js";
import { setPilLastResult } from "./store.js";
import { resolveAfter } from "./timeout.js";
import type { PipelineContext } from "./types.js";

const PIPELINE_TIMEOUT_FAST_MS = 200;
const PIPELINE_TIMEOUT_BRAIN_MS = 3000;

function pipelineTimeoutMs(): number {
  const mode = getCachedEEClientMode();
  if (mode && (mode.mode === "thin" || mode.mode === "thin-degraded" || mode.mode === "fat")) {
    return PIPELINE_TIMEOUT_BRAIN_MS;
  }
  return PIPELINE_TIMEOUT_FAST_MS;
}

const SKIPPED_LAYERS = [
  "personality-adaptation",
  "ee-experience-injection",
  "gsd-workflow-structuring",
  "context-enrichment",
];

async function runLayers(ctx: PipelineContext): Promise<PipelineContext> {
  const pipelineStart = Date.now();
  const timings: Array<{ name: string; ms: number }> = [];

  async function timed(name: string, fn: (c: PipelineContext) => Promise<PipelineContext>): Promise<void> {
    const start = Date.now();
    ctx = await fn(ctx);
    timings.push({ name, ms: Date.now() - start });
  }

  await timed("layer1-intent", layer1Intent);

  if (ctx.taskType !== null) {
    await timed("layer2-personality", layer2Personality);
    await timed("layer3-ee-injection", layer3EeInjection);
    await timed("layer4-gsd-structuring", layer4Gsd);
    await timed("layer5-context-enrichment", layer5Context);
  } else {
    for (const name of SKIPPED_LAYERS) {
      timings.push({ name: `layer-${name}`, ms: 0 });
    }
    ctx = {
      ...ctx,
      layers: [
        ...ctx.layers,
        ...SKIPPED_LAYERS.map((name) => ({ name, applied: false, delta: "skipped:null-taskType" })),
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
      estimatedTokensSaved: Math.round(suffixChars / 4),
      enrichmentTokensAdded: Math.round(enrichmentCharsAdded / 4),
    },
  };

  return ctx;
}

export interface PipelineOptions {
  gsdPhase?: string | null;
  resumeDigest?: string | null;
  activeRunId?: string | null;
  sessionId?: string | null;
}

export async function runPipeline(raw: string, options?: PipelineOptions): Promise<PipelineContext> {
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
    const result = await Promise.race([
      runLayers({ ...fallback }),
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
