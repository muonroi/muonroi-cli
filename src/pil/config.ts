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

export function getAutoPassThreshold(): number {
  const v = Number(process.env.MUONROI_PIL_AUTOPASS_THRESHOLD);
  return Number.isFinite(v) && v >= 0.5 && v <= 1.0 ? v : 0.85;
}

export function getMaxInterviewQuestions(): number {
  const v = Number(process.env.MUONROI_PIL_MAX_QUESTIONS);
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 3;
}
