/**
 * src/ui/components/sprint-stage.ts
 *
 * Pure helpers for the stage-aware Context Rail + main-panel sprint status
 * strip. No JSX — everything here is unit-testable without a renderer.
 *
 * Data source: the `sprint_stage` CouncilPhaseEvents that sprint-runner emits
 * for every stage (phaseStart/phaseDone/phaseError with label
 * "Sprint N — Planning|Implementation|Verification|Judgment"), plus the
 * SprintProgressSegment the status bar already tracks. Nothing is invented:
 * this module only re-shapes signals that already flow through the UI.
 */

import type { SprintProgressSegment } from "../../state/status-bar-store.js";
import type { CouncilPhaseEvent } from "../../types/index.js";
import type { ContextRailRow } from "./context-rail.js";

/** Short display keys for the known sprint stages. */
export type SprintStageKey = "planning" | "implementation" | "verification" | "judgment" | "other";

export interface SprintStageInfo {
  /** Sprint number parsed from the phase label ("Sprint 3 — …"), if present. */
  sprintN: number | null;
  stage: SprintStageKey;
  /** Compact stage tag for dividers/status lines: plan | impl | verify | judge. */
  stageShort: string;
  /** Present-progressive verb for the live strip: "implementing (41s)". */
  verb: string;
  label: string;
  detail?: string;
  startedAt?: number;
  state: CouncilPhaseEvent["state"];
  phaseId: string;
}

const STAGE_MAP: Record<string, { key: SprintStageKey; short: string; verb: string }> = {
  planning: { key: "planning", short: "plan", verb: "planning" },
  implementation: { key: "implementation", short: "impl", verb: "implementing" },
  verification: { key: "verification", short: "verify", verb: "verifying" },
  judgment: { key: "judgment", short: "judge", verb: "judging" },
};

/**
 * Derive the current sprint stage from the phase timeline. Returns the most
 * recent `sprint_stage` phase that is still ACTIVE, or null when no sprint
 * stage is running (pure council / idle sessions keep the classic rail).
 */
export function deriveSprintStage(phases: readonly CouncilPhaseEvent[]): SprintStageInfo | null {
  for (let i = phases.length - 1; i >= 0; i--) {
    const p = phases[i];
    if (!p || p.kind !== "sprint_stage") continue;
    if (p.state !== "active") continue;
    return toStageInfo(p);
  }
  return null;
}

function toStageInfo(p: CouncilPhaseEvent): SprintStageInfo {
  // Label shape: "Sprint N — Planning". Em-dash separator with tolerant fallback.
  const m = /^Sprint\s+(\d+)\s*[—–-]+\s*(.+)$/.exec(p.label.trim());
  const sprintN = m ? Number.parseInt(m[1] ?? "", 10) : null;
  const stageWord = (m?.[2] ?? p.label).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const mapped = STAGE_MAP[stageWord] ?? {
    key: "other" as const,
    short: stageWord || "stage",
    verb: stageWord ? `${stageWord}…` : "working",
  };
  return {
    sprintN: Number.isFinite(sprintN as number) ? sprintN : null,
    stage: mapped.key,
    stageShort: mapped.short,
    verb: mapped.verb,
    label: p.label,
    detail: p.detail,
    startedAt: p.startedAt,
    state: p.state,
    phaseId: p.phaseId,
  };
}

/** "41s" under a minute, "3m12s" above. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function elapsedFor(info: SprintStageInfo, now: number): string | null {
  if (typeof info.startedAt !== "number") return null;
  return formatElapsed(now - info.startedAt);
}

/**
 * Divider title for the rail stage block: "SPRINT 1/4 · impl". Falls back to
 * the parsed sprint number when the status-bar segment is not (yet) present,
 * and to a bare stage tag on greenfield edge cases.
 */
export function buildStageDividerTitle(info: SprintStageInfo, sprint?: SprintProgressSegment): string {
  const n = sprint?.activeSprintNumber ?? info.sprintN;
  const total = sprint?.totalSprints;
  if (n != null && total != null) return `SPRINT ${n}/${total} · ${info.stageShort}`;
  if (n != null) return `SPRINT ${n} · ${info.stageShort}`;
  return `SPRINT · ${info.stageShort}`;
}

export interface StageRowsInput {
  info: SprintStageInfo;
  sprint?: SprintProgressSegment;
  /** Last live council progress line (planning stage), e.g. "Round 1/3 · running". */
  councilProgress?: string | null;
  /** Truncated debate topic (planning stage only). */
  topic?: string | null;
  /** "x/y criteria met" summary (planning stage only). */
  criteriaSummary?: string | null;
  /** Most recent sub-agent activity detail (implementation stage). */
  lastActivity?: string | null;
  now: number;
}

const RAIL_VALUE_MAX = 64;

function clip(s: string, max = RAIL_VALUE_MAX): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Stage-specific rail rows. Deliberately SMALL: the rail keeps a fixed
 * identity block and this one swappable block — rows irrelevant to the
 * current stage (full criteria list, panel roster, round breakdown during
 * implement) are dropped instead of truncated.
 */
export function buildStageRows(input: StageRowsInput): ContextRailRow[] {
  const { info, sprint, now } = input;
  const rows: ContextRailRow[] = [];
  const elapsed = elapsedFor(info, now);
  const stories =
    sprint && sprint.totalStories > 0 ? `${sprint.completedStories}/${sprint.totalStories} stories` : null;
  const tail = [stories, elapsed].filter(Boolean).join(" · ");

  switch (info.stage) {
    case "planning": {
      if (input.topic) rows.push({ label: "", value: `▸ ${clip(input.topic)}` });
      if (input.councilProgress) rows.push({ label: "", value: `  ${clip(input.councilProgress)}` });
      if (input.criteriaSummary) rows.push({ label: "", value: `  ${clip(input.criteriaSummary)}` });
      if (!input.topic && !input.councilProgress)
        rows.push({ label: "", value: `▸ ${clip(info.detail ?? "drafting sprint plan")}` });
      if (elapsed) rows.push({ label: "", value: `  ${elapsed}` });
      break;
    }
    case "implementation": {
      const activity = input.lastActivity ?? info.detail ?? "executing sprint plan";
      rows.push({ label: "", value: `▸ ${clip(activity)}` });
      if (tail) rows.push({ label: "", value: `  ${tail}` });
      break;
    }
    case "verification": {
      rows.push({ label: "", value: `▸ ${clip(info.detail ?? "running verify recipe")}` });
      if (tail) rows.push({ label: "", value: `  ${tail}` });
      break;
    }
    case "judgment": {
      rows.push({ label: "", value: `▸ ${clip(info.detail ?? "scoring sprint output")}` });
      if (tail) rows.push({ label: "", value: `  ${tail}` });
      break;
    }
    default: {
      rows.push({ label: "", value: `▸ ${clip(info.detail ?? info.label)}` });
      if (elapsed) rows.push({ label: "", value: `  ${elapsed}` });
    }
  }
  return rows;
}

/**
 * One-line summary for the main-panel status strip footer:
 * "Sprint 1/4 · impl · 2/2 · 41s".
 */
export function formatSprintStripLine(
  info: SprintStageInfo,
  sprint: SprintProgressSegment | undefined,
  now: number,
): string {
  const parts: string[] = [];
  const n = sprint?.activeSprintNumber ?? info.sprintN;
  const total = sprint?.totalSprints;
  parts.push(n != null && total != null ? `Sprint ${n}/${total}` : n != null ? `Sprint ${n}` : "Sprint");
  parts.push(info.stageShort);
  if (sprint && sprint.totalStories > 0) parts.push(`${sprint.completedStories}/${sprint.totalStories}`);
  const elapsed = elapsedFor(info, now);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/**
 * Headline for the strip: "▸ implementing (41s)".
 */
export function formatSprintStripHeadline(info: SprintStageInfo, now: number): string {
  const elapsed = elapsedFor(info, now);
  return elapsed ? `▸ ${info.verb} (${elapsed})` : `▸ ${info.verb}`;
}

/**
 * Append an activity detail to a bounded ring (most-recent-last, deduped
 * against the current tail). Pure — returns a new array only on change.
 */
export function pushActivity(ring: readonly string[], detail: string | null | undefined, cap = 3): readonly string[] {
  const d = detail?.trim();
  if (!d) return ring;
  if (ring[ring.length - 1] === d) return ring;
  const next = [...ring, d];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
