/**
 * PIL feature flags.
 * - MUONROI_PIL_UNIFIED: "1" enables the new /api/pil-context single-call path
 *   in Layer 1. "0" or unset disables it (legacy multi-call path).
 *   Default OFF during rollout; flip to ON after dual-run validation.
 */
export function isUnifiedPilEnabled(): boolean {
  if (process.env.MUONROI_PIL_UNIFIED === "0") return false;
  if (process.env.MUONROI_PIL_UNIFIED === "1") return true;
  return false;
}

/**
 * MUONROI_LLM_FIRST_CLASSIFY: model-first Layer-1 classification. When enabled
 * (default), the configured model classifies taskType/intentKind/style at the
 * top of the turn and the brittle keyword-regex cascade becomes the OFFLINE
 * fallback (used only when the model call fails / is not wired). Set to "0" to
 * revert to the regex-first cascade. Requires opts.llmFallback to be wired
 * (the orchestrator does this on the main path); without it, the cascade runs.
 */
export function isLlmFirstClassifyEnabled(): boolean {
  return process.env.MUONROI_LLM_FIRST_CLASSIFY !== "0";
}

export function isDiscoveryEnabled(): boolean {
  return process.env.MUONROI_PIL_DISCOVERY !== "0";
}

// Phase 2 (2026-06-16): getAutoPassThreshold() was removed with the regex
// auto-pass gate (shouldAutoPass). The model now decides whether a turn needs
// clarification, so there is no confidence threshold to tune. The
// MUONROI_PIL_AUTOPASS_THRESHOLD env var is therefore inert.

export function getMaxInterviewQuestions(): number {
  const v = Number(process.env.MUONROI_PIL_MAX_QUESTIONS);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
}
