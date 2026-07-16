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
 * Debate/council TUI two-pane redesign — scroll-lock. Default ON (baked). When
 * ON, forced `scrollToBottom()` calls respect the user's manual scroll position
 * (OpenTUI `_hasManualScroll`) so streaming renders don't yank the view back to
 * the latest line while the user is reading history. A jump-to-latest pill
 * re-pins on demand. Opt out: MUONROI_SCROLL_LOCK=0.
 */
export function isScrollLockEnabled(): boolean {
  const raw = process.env.MUONROI_SCROLL_LOCK;
  return raw !== "0" && raw?.toLowerCase() !== "false";
}

/**
 * Debate/council TUI two-pane redesign — right Context Rail for metadata-heavy
 * modes (debate/council, ideal). Default ON (baked). When ON,
 * session/leader/panel/budget metadata and info-cards move out of the scrolling
 * transcript into a right-hand panel. Requires ≥100 terminal columns; below
 * that the rail is hidden and metadata falls back inline. Opt out:
 * MUONROI_CONTEXT_RAIL=0.
 */
export function isContextRailEnabled(): boolean {
  const raw = process.env.MUONROI_CONTEXT_RAIL;
  return raw !== "0" && raw?.toLowerCase() !== "false";
}

/**
 * Debate/council TUI two-pane redesign — round-grouped transcript. Default ON
 * (baked). When ON, debate turns are grouped by round; only the running round
 * streams live while done rounds render an expanded summary (input, outcome,
 * leader decision, metrics). Opt out: MUONROI_ROUND_GROUPS=0.
 */
export function isRoundGroupsEnabled(): boolean {
  const raw = process.env.MUONROI_ROUND_GROUPS;
  return raw !== "0" && raw?.toLowerCase() !== "false";
}

/**
 * U3 — task-aware debate panel. Default ON. When ON, the leader reads the task
 * and selects which reachable models should debate it (via selectTaskAwarePanel)
 * instead of the prompt-blind capability roster from resolveParticipants. Always
 * fails open to the default roster on any provider/parse failure. Opt out:
 * MUONROI_TASK_AWARE_PANEL=0.
 */
export function isTaskAwarePanelEnabled(): boolean {
  const raw = process.env.MUONROI_TASK_AWARE_PANEL;
  return raw !== "0" && raw?.toLowerCase() !== "false";
}

/**
 * Plan-review debate retry budget. The council debate can return an EMPTY
 * synthesis on any of its fail-open paths (provider unreachable, sub-phase
 * catch, user/watchdog abort) — a silent null that plan-council previously
 * collapsed into a permanent forced-`revise`, bricking an autonomous /ideal
 * heavy run (0 code, no human to re-trigger plan-review). On empty synthesis
 * we retry the debate up to this many times before falling back to the
 * perspective path. Default 1 (up to 2 debate attempts). Env override:
 * MUONROI_PLAN_REVIEW_DEBATE_RETRIES. Clamped to [0, 5].
 */
export function getPlanReviewDebateRetries(): number {
  const raw = process.env.MUONROI_PLAN_REVIEW_DEBATE_RETRIES;
  if (raw === undefined) return 1;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 1;
  return Math.min(n, 5);
}
