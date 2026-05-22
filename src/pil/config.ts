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
