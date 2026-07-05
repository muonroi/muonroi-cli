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

/**
 * Native mutation gate — default ON when native GSD is on. Delegates to the SDK's
 * own `canExecute(cwd, depth)` at the write-mutex wrapper so mutation tools are
 * blocked until plan-review passes at standard/heavy depth. Opt out: MUONROI_GSD_HARD_GATE=0.
 */
export function isGsdHardGateEnabled(): boolean {
  if (!isGsdNativeEnabled()) return false;
  return process.env.MUONROI_GSD_HARD_GATE !== "0";
}

/**
 * PIL prompt-gate full-context enrichment (conversation digest, EE recall,
 * prior PLAN.md excerpt) — default ON when native GSD is on. Opt out:
 * MUONROI_PIL_GATE_ENRICH=0.
 */
export function isPilGateEnrichEnabled(): boolean {
  return isGsdNativeEnabled() && process.env.MUONROI_PIL_GATE_ENRICH !== "0";
}

/**
 * Debate/council TUI two-pane redesign — scroll-lock. Default OFF (opt-in during
 * bake). When ON, forced `scrollToBottom()` calls respect the user's manual
 * scroll position (OpenTUI `_hasManualScroll`) so streaming renders don't yank
 * the view back to the latest line while the user is reading history. A
 * jump-to-latest pill re-pins on demand. Opt in: MUONROI_SCROLL_LOCK=1.
 */
export function isScrollLockEnabled(): boolean {
  const raw = process.env.MUONROI_SCROLL_LOCK;
  return raw === "1" || raw?.toLowerCase() === "true";
}

/**
 * Debate/council TUI two-pane redesign — right Context Rail for metadata-heavy
 * modes (debate/council, ideal). Default OFF (opt-in during bake). When ON,
 * session/leader/panel/budget metadata and info-cards move out of the scrolling
 * transcript into a right-hand panel. Requires ≥100 terminal columns; below
 * that the rail is hidden and metadata falls back inline. Opt in:
 * MUONROI_CONTEXT_RAIL=1.
 */
export function isContextRailEnabled(): boolean {
  const raw = process.env.MUONROI_CONTEXT_RAIL;
  return raw === "1" || raw?.toLowerCase() === "true";
}

/**
 * Debate/council TUI two-pane redesign — round-grouped transcript. Default OFF
 * (opt-in during bake). When ON, debate turns are grouped by round; only the
 * running round streams live while done rounds render an expanded summary
 * (input, outcome, leader decision, metrics). Opt in: MUONROI_ROUND_GROUPS=1.
 */
export function isRoundGroupsEnabled(): boolean {
  const raw = process.env.MUONROI_ROUND_GROUPS;
  return raw === "1" || raw?.toLowerCase() === "true";
}
