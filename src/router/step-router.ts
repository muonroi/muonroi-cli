/**
 * Step-Aware Model Routing (SAMR)
 *
 * Downgrades the model for tool-execution steps within a single turn.
 * The insight: once the premium model decides WHAT to do (expressed as
 * tool calls in step 0), the remaining work is mechanical — reading
 * tool results, calling more tools, producing the final response.
 * A fast model handles this equally well at a fraction of the cost.
 *
 * Architecture:
 *   Phase 1 (Reasoning): Premium/balanced model, max 1 step
 *     → model thinks, plans, decides on tool calls
 *   Phase 2 (Execution): Fast model, remaining steps
 *     → reads tool results, calls more tools if needed, produces final output
 *
 * DISABLED BY DEFAULT until Phase1→Phase2 transition has soak time + an
 * integration test covering: (a) SDK does not re-emit pending tool_calls on
 * Phase 2 entry, (b) provider-switch keeps tool schema compatible,
 * (c) abort/error during Phase 1 does not strand pending tool_calls.
 * Opt-in via user-settings.json:
 *   "stepRouter": {
 *     "enabled": true,
 *     "toolExecutionTier": "fast",     // "fast" | "balanced"
 *     "premiumSynthesis": false        // switch back to premium for final response
 *   }
 */

import { getModelByTier } from "../models/registry.js";
import { detectProviderForModel } from "../providers/runtime.js";
import type { ProviderId } from "../providers/types.js";
import type { ModelInfo } from "../types/index.js";
import { isModelDisabled, isProviderDisabled, loadUserSettings } from "../utils/settings.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StepRouterConfig {
  /** Whether step-aware routing is enabled. Default: true. */
  enabled: boolean;
  /** Tier to use for tool-execution steps (1..N). Default: "fast". */
  toolExecutionTier: "fast" | "balanced";
  /** If true, switch back to the original premium model for the very last
   *  synthesis step (after all tool calls complete). Default: false.
   *  When false, the fast model produces the final response — which is
   *  usually good enough and saves an extra API call. */
  premiumSynthesis: boolean;
}

export interface StepRouterDecision {
  /** Model ID for Phase 1 (reasoning / step 0). */
  phase1ModelId: string;
  /** Model ID for Phase 2 (execution / steps 1..N).
   *  null means step routing is not applicable — fall back to single-model. */
  phase2ModelId: string | null;
  /** Human-readable reason for the decision. */
  reason: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: StepRouterConfig = {
  enabled: false,
  toolExecutionTier: "fast",
  premiumSynthesis: false,
};

// ─── Config loader ───────────────────────────────────────────────────────────

/**
 * Double-opt-in: SAMR requires BOTH `stepRouter.enabled=true` in user-settings
 * AND the env var `MUONROI_STEP_ROUTER_ACK=1`. The env var is the user's
 * acknowledgement that they've read the SDK-compatibility caveats in the
 * module docstring (a/b/c conditions). Without it, enabled silently degrades
 * to false and a one-time warning is printed.
 */
const SAMR_ACK_ENV = "MUONROI_STEP_ROUTER_ACK";
let _samrWarnedOnce = false;

export function getStepRouterConfig(): StepRouterConfig {
  const raw = loadUserSettings().stepRouter;
  if (!raw) return { ...DEFAULT_CONFIG };
  const userWantsEnabled = raw.enabled ?? DEFAULT_CONFIG.enabled;
  const ack = process.env[SAMR_ACK_ENV] === "1";
  if (userWantsEnabled && !ack && !_samrWarnedOnce) {
    _samrWarnedOnce = true;
    console.warn(
      `[step-router] stepRouter.enabled=true ignored: set ${SAMR_ACK_ENV}=1 to acknowledge SDK-compatibility caveats (see src/router/step-router.ts header).`,
    );
  }
  return {
    enabled: userWantsEnabled && ack,
    toolExecutionTier: raw.toolExecutionTier ?? DEFAULT_CONFIG.toolExecutionTier,
    premiumSynthesis: raw.premiumSynthesis ?? DEFAULT_CONFIG.premiumSynthesis,
  };
}

// ─── Decision engine ─────────────────────────────────────────────────────────

/**
 * Decide whether to split the turn into two model phases.
 *
 * Returns phase2ModelId=null when step routing is NOT applicable:
 *   - Config disabled
 *   - Execution model is the same as phase 1 model (no benefit)
 *   - No fast model available for the provider
 *   - Execution model's provider is disabled or unreachable
 */
export function decideStepRouting(
  phase1ModelId: string,
  defaultProvider: string,
  config?: StepRouterConfig,
): StepRouterDecision {
  const cfg = config ?? getStepRouterConfig();
  const phase1Provider = detectProviderForModel(phase1ModelId);

  if (!cfg.enabled) {
    return {
      phase1ModelId,
      phase2ModelId: null,
      reason: "step-router disabled",
    };
  }

  // Find the cheapest model for the execution provider.
  // Prefer same provider as phase 1 to keep keychain simple.
  const execModel = resolveExecutionModel(defaultProvider, cfg.toolExecutionTier, phase1ModelId);

  if (!execModel) {
    return {
      phase1ModelId,
      phase2ModelId: null,
      reason: `no ${cfg.toolExecutionTier} model available for provider ${defaultProvider}`,
    };
  }

  if (execModel.id === phase1ModelId) {
    return {
      phase1ModelId,
      phase2ModelId: null,
      reason: `phase 1 model is already ${cfg.toolExecutionTier} tier — no downgrade needed`,
    };
  }

  // Verify the execution model's provider is reachable
  const execProvider = execModel.provider as ProviderId;
  if (isProviderDisabled(execProvider)) {
    return {
      phase1ModelId,
      phase2ModelId: null,
      reason: `execution model provider ${execProvider} is disabled`,
    };
  }

  return {
    phase1ModelId,
    phase2ModelId: execModel.id,
    reason: `${phase1ModelId} (${getModelTier(phase1ModelId)}) → ${execModel.id} (${cfg.toolExecutionTier}) for tool execution steps`,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function resolveExecutionModel(
  provider: string,
  tier: "fast" | "balanced",
  excludeModelId: string,
): ModelInfo | undefined {
  // Try same provider first
  const sameProvider = getModelByTier(tier, provider);
  if (sameProvider && sameProvider.id !== excludeModelId) {
    // Guard: check provider-disabled and model-disabled (mirrors cross-provider branch)
    if (!isProviderDisabled(sameProvider.provider as ProviderId) && !isModelDisabled(sameProvider.id)) {
      return sameProvider;
    }
  }
  // If no same-provider model in this tier, try any provider
  const anyProvider = getModelByTier(tier);
  if (anyProvider && anyProvider.id !== excludeModelId) {
    // Only use cross-provider if the provider and model aren't disabled
    if (!isProviderDisabled(anyProvider.provider as ProviderId) && !isModelDisabled(anyProvider.id)) {
      return anyProvider;
    }
  }
  return undefined;
}

function getModelTier(modelId: string): string {
  return getModelByTier("fast")?.id === modelId
    ? "fast"
    : getModelByTier("balanced")?.id === modelId
      ? "balanced"
      : getModelByTier("premium")?.id === modelId
        ? "premium"
        : "unknown";
}
