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
import { readTimeoutEnv } from "../utils/ee-logger.js";
import { isModelDisabled, isProviderDisabled, loadUserSettings } from "../utils/settings.js";

// ─── EE-guided SAMR override ─────────────────────────────────────────────────
// EE_SAMR_TIMEOUT: per-call budget for consulting the EE brain about SAMR.
// Default 2s, range 500ms..5s. Falls back to heuristics on timeout/error.
const EE_SAMR_TIMEOUT_MS = readTimeoutEnv("MUONROI_EE_SAMR_TIMEOUT_MS", 2000, 500, 5000);

export interface EESamrGuidance {
  overrideConfig: StepRouterConfig | null;
  reason: string;
}

/**
 * Consult the EE brain + local heuristics to decide whether SAMR should be
 * enabled for this turn even when the user config has it disabled.
 *
 * Resolution order:
 *   1. Fast heuristic — mechanical/simple tasks skip EE entirely (zero cost).
 *   2. EE brain — asks classifyViaBrain for a yes/no + execution tier.
 *   3. Heuristic fallback — when EE is unreachable, uses taskType + complexity.
 */
export async function eeSamrGuidance(params: {
  userMessage: string;
  taskType: string | null;
  taskConfidence: number;
  complexitySize?: string;
  taskComplexity?: string;
}): Promise<EESamrGuidance> {
  const { userMessage, taskType, taskConfidence, complexitySize, taskComplexity } = params;

  // Step 1: fast heuristic — mechanical tasks never benefit from SAMR
  const mechanicalTypes = new Set(["general", "documentation", "generate", "build", "chitchat"]);
  if (taskType && mechanicalTypes.has(taskType)) {
    return { overrideConfig: null, reason: `mechanical taskType=${taskType} — no SAMR benefit` };
  }

  // Step 2: fast heuristic — trivial tasks don't need a split
  if (taskComplexity === "low" && (complexitySize === "small" || complexitySize === undefined)) {
    return { overrideConfig: null, reason: "low complexity + small — no SAMR benefit" };
  }

  // Step 3: ask EE brain
  try {
    const { classifyViaBrain } = await import("../ee/bridge.js");
    const eePrompt = [
      `Task: ${userMessage.slice(0, 200)}`,
      `Context: type=${taskType ?? "unknown"} complexity=${taskComplexity ?? "unknown"} size=${complexitySize ?? "unknown"}`,
      `Question: Would splitting the work into (1) premium reasoning then (2) cheap execution save tokens without hurting quality?`,
      `Reply valid JSON: {"samr":true,"executionTier":"balanced"} or {"samr":false}`,
    ].join("\n");

    const response = await classifyViaBrain(eePrompt, EE_SAMR_TIMEOUT_MS, {
      systemPrompt:
        'You are a SAMR (Step-Aware Model Routing) evaluator. Given a task description, context, and question, reply ONLY with valid JSON: {"samr":true,"executionTier":"balanced"} or {"samr":false}. No extra text, no markdown.',
      responseFormat: { type: "json_object" },
      maxTokens: 100,
    });
    if (!response) {
      // Fallback heuristic when EE unreachable
      return samrHeuristicFallback(taskType, taskComplexity, complexitySize);
    }

    const parsed = JSON.parse(response) as { samr?: boolean; executionTier?: string };
    if (parsed.samr === true) {
      const tier = parsed.executionTier === "fast" ? ("fast" as const) : ("balanced" as const);
      return {
        overrideConfig: { enabled: true, toolExecutionTier: tier, premiumSynthesis: false },
        reason: `ee-guided: ${tier} execution phase`,
      };
    }
    return { overrideConfig: null, reason: "ee-declined" };
  } catch {
    return samrHeuristicFallback(taskType, taskComplexity, complexitySize);
  }
}

/**
 * Deterministic fallback when EE brain is unreachable.
 * Reasoning-heavy tasks with high complexity are strong SAMR candidates.
 */
function samrHeuristicFallback(
  taskType: string | null,
  taskComplexity?: string,
  complexitySize?: string,
): EESamrGuidance {
  const reasoningTypes = new Set(["plan", "analyze", "refactor", "debug", "architect"]);
  if (taskType && reasoningTypes.has(taskType)) {
    if (taskComplexity === "high" || complexitySize === "large") {
      return {
        overrideConfig: { enabled: true, toolExecutionTier: "balanced", premiumSynthesis: false },
        reason: `heuristic: ${taskType}/${taskComplexity ?? "?"}/${complexitySize ?? "?"} benefits from SAMR`,
      };
    }
  }
  return { overrideConfig: null, reason: "heuristic: no benefit" };
}

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
  const _phase1Provider = detectProviderForModel(phase1ModelId);

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
