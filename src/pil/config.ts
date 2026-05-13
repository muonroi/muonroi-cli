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
