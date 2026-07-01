/**
 * Peak-hour routing for Z.ai (GLM Coding Plan) and DeepSeek.
 *
 * Z.ai official window: 14:00–18:00 UTC+8 — GLM-5.2 / GLM-5-Turbo consume 3×
 * quota during peak (docs.z.ai/devpack/overview). Routine work should stay on
 * glm-4.7; premium GLM-5 family models are downgraded or switched.
 *
 * DeepSeek has no published time window — only concurrency caps (v4-pro 500,
 * v4-flash 2500 per api-docs.deepseek.com). During the same UTC+8 window we
 * downgrade v4-pro → v4-flash to reduce concurrency pressure.
 */
import { getModelByTier, getModelInfo } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import type { ModelInfo } from "../types/index.js";
import { getPeakHourPolicy, isProviderDisabled, type PeakHourPolicy } from "../utils/settings.js";

export type PeakHourMode = "downgrade" | "switch";

export interface PeakHourAdjustment {
  modelId: string;
  provider: ProviderId;
  adjusted: boolean;
  reason?: string;
}

const ZAI_PEAK_SENSITIVE = new Set(["glm-5.2", "glm-5-turbo", "glm-5", "glm-5.1", "glm-5v-turbo"]);
const ZAI_PEAK_ROUTINE = "glm-4.7";

const DEEPSEEK_PEAK_SENSITIVE = new Set(["deepseek-v4-pro"]);
const DEEPSEEK_PEAK_ROUTINE = "deepseek-v4-flash";

/** Fallback provider order when mode=switch (user's primary stack). */
const SWITCH_PROVIDER_ORDER: readonly ProviderId[] = ["deepseek", "zai", "opencode-go", "xai"];

export function hourUtc8(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour ? Number(hour) : 0;
}

export function isPeakHourUtc8(now: Date, policy: PeakHourPolicy): boolean {
  if (policy.enabled === false) return false;
  const start = policy.startHourUtc8 ?? 14;
  const end = policy.endHourUtc8 ?? 18;
  const h = hourUtc8(now);
  return h >= start && h < end;
}

function sameProviderDowngrade(modelId: string, provider: ProviderId): string | null {
  if (provider === "zai" && ZAI_PEAK_SENSITIVE.has(modelId)) return ZAI_PEAK_ROUTINE;
  if (provider === "deepseek" && DEEPSEEK_PEAK_SENSITIVE.has(modelId)) return DEEPSEEK_PEAK_ROUTINE;
  return null;
}

function pickSwitchFallback(excludeProvider: ProviderId): ModelInfo | undefined {
  for (const p of SWITCH_PROVIDER_ORDER) {
    if (p === excludeProvider) continue;
    if (isProviderDisabled(p)) continue;
    const m = getModelByTier("fast", p) ?? getModelByTier("balanced", p);
    if (m && m.provider === p) return m;
  }
  return undefined;
}

/**
 * Adjust a concrete model id for peak-hour policy. No-op outside the window or
 * when policy is disabled.
 */
export function adjustPeakHourModel(
  modelId: string,
  opts?: { now?: Date; policy?: PeakHourPolicy },
): PeakHourAdjustment {
  const policy = opts?.policy ?? getPeakHourPolicy();
  const now = opts?.now ?? new Date();
  const provider = detectProviderForModel(modelId) as ProviderId;

  if (!isPeakHourUtc8(now, policy)) {
    return { modelId, provider, adjusted: false };
  }

  const downgraded = sameProviderDowngrade(modelId, provider);
  if (downgraded) {
    if (policy.mode === "switch") {
      const alt = pickSwitchFallback(provider);
      if (alt && alt.id !== modelId) {
        return {
          modelId: alt.id,
          provider: alt.provider as ProviderId,
          adjusted: true,
          reason: `peak-hour(${provider}→${alt.provider}:${alt.id})`,
        };
      }
    }
    const info = getModelInfo(downgraded);
    if (info?.provider === provider) {
      return {
        modelId: downgraded,
        provider,
        adjusted: true,
        reason: `peak-hour(${modelId}→${downgraded})`,
      };
    }
  }

  return { modelId, provider, adjusted: false };
}

/** Tier lookup with peak-hour adjustment applied to the resolved model. */
export function getRoutedModelByTier(
  tier: "fast" | "balanced" | "premium",
  preferProvider?: string,
  opts?: { now?: Date; policy?: PeakHourPolicy },
): ModelInfo | undefined {
  const base = getModelByTier(tier, preferProvider);
  if (!base) return undefined;
  const adj = adjustPeakHourModel(base.id, opts);
  if (!adj.adjusted) return base;
  const info = getModelInfo(adj.modelId);
  return info ?? base;
}
