/**
 * Peak-hour routing — rules loaded from catalog API `provider_policies.peak_hour`
 * (vendor-sourced metadata). User settings only toggle enabled + switch/downgrade mode.
 */
import { getModelByTier, getModelInfo, getProviderPeakHourRule, SWITCH_PROVIDER_ORDER } from "../models/registry.js";
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

export function hourInTimezone(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour ? Number(hour) : 0;
}

/** @deprecated Use hourInTimezone — kept for tests referencing UTC+8. */
export function hourUtc8(now: Date): number {
  return hourInTimezone(now, "Asia/Shanghai");
}

export function isPeakHourForProvider(
  provider: ProviderId,
  now: Date,
  userPolicy: PeakHourPolicy = getPeakHourPolicy(),
): boolean {
  if (userPolicy.enabled === false) return false;
  const rule = getProviderPeakHourRule(provider);
  if (!rule) return false;
  const h = hourInTimezone(now, rule.timezone);
  return h >= rule.start_hour && h < rule.end_hour;
}

/** @deprecated Use isPeakHourForProvider(provider, ...) — window is per-provider from catalog. */
export function isPeakHourUtc8(now: Date, userPolicy: PeakHourPolicy): boolean {
  return isPeakHourForProvider("zai", now, userPolicy) || isPeakHourForProvider("deepseek", now, userPolicy);
}

function sameProviderDowngrade(modelId: string, provider: ProviderId): string | null {
  const rule = getProviderPeakHourRule(provider);
  if (!rule) return null;
  if (!rule.sensitive_model_ids.includes(modelId)) return null;
  return rule.fallback_model_id;
}

function pickSwitchFallback(excludeProvider: ProviderId): ModelInfo | undefined {
  const rule = getProviderPeakHourRule(excludeProvider);
  const order = (rule?.switch_fallback_providers as ProviderId[] | undefined) ?? SWITCH_PROVIDER_ORDER;
  for (const p of order) {
    if (p === excludeProvider) continue;
    if (isProviderDisabled(p)) continue;
    const m = getModelByTier("fast", p) ?? getModelByTier("balanced", p);
    if (m && m.provider === p) return m;
  }
  return undefined;
}

/**
 * Adjust a concrete model id for peak-hour policy. No-op outside the provider's
 * catalog-defined window or when user policy is disabled.
 */
export function adjustPeakHourModel(
  modelId: string,
  opts?: { now?: Date; policy?: PeakHourPolicy },
): PeakHourAdjustment {
  const userPolicy = opts?.policy ?? getPeakHourPolicy();
  const now = opts?.now ?? new Date();
  const provider = detectProviderForModel(modelId) as ProviderId;

  if (!isPeakHourForProvider(provider, now, userPolicy)) {
    return { modelId, provider, adjusted: false };
  }

  const downgraded = sameProviderDowngrade(modelId, provider);
  if (downgraded) {
    if (userPolicy.mode === "switch") {
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
