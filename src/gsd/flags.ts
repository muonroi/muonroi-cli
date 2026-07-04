/**
 * Native GSD workflow engine — default ON.
 * Agent chooses when to call gsd_* tools; gates are soft except plan-review → execute.
 * Opt out: MUONROI_GSD_NATIVE=0 (legacy playbook rubric, no gsd_* tools).
 */
export function isGsdNativeEnabled(): boolean {
  const raw = process.env.MUONROI_GSD_NATIVE;
  if (raw === "0" || raw?.toLowerCase() === "false") return false;
  return true;
}

/**
 * Leader-tier complexity assessor over the native depth slot — default ON
 * when native GSD is on. Opt out: MUONROI_GSD_ASSESSOR=0.
 */
export function isComplexityAssessorEnabled(): boolean {
  if (!isGsdNativeEnabled()) return false;
  return process.env.MUONROI_GSD_ASSESSOR !== "0";
}
