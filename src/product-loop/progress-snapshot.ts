/**
 * src/product-loop/progress-snapshot.ts
 *
 * Pure projection: reads Backlog + SprintPlan + interaction_logs and returns
 * a ProgressSnapshot. No LLM, no external writes.
 *
 * Both /status and the P8 reporter consume this module.
 * renderSnapshotMarkdown() is a pure string function — no I/O — so tests and
 * the reporter can call it without a live sprint-runner.
 */

import { getDatabase } from "../storage/db.js";
import { readBacklog } from "./backlog-store.js";
import { readSprintPlan } from "./sprint-store.js";
import type { BacklogItemStatus, ProgressSnapshot, ProgressSnapshotBlocker, ProgressSnapshotItem } from "./types.js";

export interface ComputeSnapshotInput {
  flowDir: string;
  runId: string;
  productSlug: string;
}

// ─── interaction_logs read helper ────────────────────────────────────────────

interface SprintStageRow {
  metadata_json: string | null;
  created_at: string;
}

/**
 * Read the latest sprint_stage interaction log row for a runId.
 * Queries via the DB directly (no read helper exists in storage/ for this query).
 * Returns null on any error or if no row exists.
 */
function readLatestSprintStage(runId: string): { sprintIndex: number; stage: string; createdAt: string } | null {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT metadata_json, created_at
         FROM interaction_logs
         WHERE session_id = ? AND event_type = 'ui_interaction' AND event_subtype = 'sprint_stage'
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(runId) as SprintStageRow | undefined;

    if (!row) return null;
    const meta = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null;
    if (!meta) return null;

    const sprintIndex = typeof meta.sprintIndex === "number" ? meta.sprintIndex : null;
    const stage = typeof meta.stage === "string" ? meta.stage : null;
    if (sprintIndex === null || !stage) return null;

    return { sprintIndex, stage, createdAt: row.created_at };
  } catch {
    return null;
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute a ProgressSnapshot from disk + DB. Pure I/O — no LLM.
 */
export async function computeProgressSnapshot(input: ComputeSnapshotInput): Promise<ProgressSnapshot> {
  const { flowDir, runId, productSlug } = input;

  // 1. Read Backlog
  const backlog = await readBacklog(flowDir, runId);

  // 2. Read SprintPlan
  const sprintPlan = await readSprintPlan(flowDir, runId);

  // 3. Read latest sprint stage from interaction_logs
  const stageRow = readLatestSprintStage(runId);
  const workerCurrentStage = stageRow ? `Sprint ${stageRow.sprintIndex} — ${capitalize(stageRow.stage)}` : null;
  const workerLastEventUtc = stageRow ? stageRow.createdAt : null;

  // 4. Clarify status — P5 persists clarified-spec.json; best-effort read.
  // TODO: read clarified-spec.json from flowDir/runs/runId/ when P5 persists it to disk.
  //       For now, assume ready=true with no gaps if backlog exists (backlog can only
  //       be built after clarification is complete).
  const clarifyReady = backlog !== null;
  const clarifyGaps: string[] = [];

  // 5. Backlog metrics
  const backlogTotal = backlog?.items.length ?? 0;
  const backlogV1Count = backlog?.items.filter((i) => i.mvp_priority === "v1").length ?? 0;
  const backlogDeferredCount =
    backlog?.items.filter((i) => i.mvp_priority === "v2" || i.mvp_priority === "later").length ?? 0;

  // 6. Sprint metrics
  const sprintTotal = sprintPlan?.sprints.length ?? 0;
  const activeSprint = sprintPlan?.sprints.find((s) => s.id === sprintPlan.activeSprintId) ?? null;
  const activeSprintNumber = activeSprint?.number ?? null;
  const activeSprintGoal = activeSprint?.goal ?? null;

  // 7. Active sprint items
  const activeSprintItems: ProgressSnapshotItem[] = [];
  if (activeSprint && backlog) {
    for (const itemId of activeSprint.itemIds) {
      const item = backlog.items.find((i) => i.id === itemId);
      if (!item) continue;
      activeSprintItems.push({
        id: item.id,
        title: item.title,
        status: item.status,
        // v1 heuristic: count done items as fully met; others as 0%.
        // Per-criterion tracking is P8+ work.
        criteriaMet: item.status === "done" ? item.acceptance_criteria.length : 0,
        criteriaTotal: item.acceptance_criteria.length,
      });
    }
  }

  // 8. Percent done — count completed items / total in sprint × 100
  const totalItems = activeSprintItems.length;
  const doneItems = activeSprintItems.filter((i) => i.status === "done").length;
  const activeSprintPercentDone = totalItems > 0 ? Math.round((doneItems / totalItems) * 1000) / 10 : 0;

  // 9. Blockers: backlog items with status="blocked" in the active sprint
  const blockers: ProgressSnapshotBlocker[] = [];
  if (activeSprint && backlog) {
    for (const itemId of activeSprint.itemIds) {
      const item = backlog.items.find((i) => i.id === itemId);
      if (!item || item.status !== "blocked") continue;
      const reason = item.blockers && item.blockers.length > 0 ? `blocked by ${item.blockers[0]}` : "blocked";
      blockers.push({ itemId: item.id, title: item.title, reason });
    }
  }

  return {
    runId,
    productSlug,
    capturedAtUtc: new Date().toISOString(),
    clarifyReady,
    clarifyGaps,
    backlogTotal,
    backlogV1Count,
    backlogDeferredCount,
    sprintTotal,
    activeSprintNumber,
    activeSprintGoal,
    activeSprintPercentDone,
    activeSprintItems,
    blockers,
    workerLastEventUtc,
    workerCurrentStage,
  };
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function statusIcon(status: BacklogItemStatus): string {
  if (status === "done") return "[x]";
  if (status === "in_progress") return "[~]";
  return "[ ]";
}

/**
 * Render a ProgressSnapshot as a markdown progress card.
 * Pure function — no I/O. Both /status and sprint-runner use this.
 */
export function renderSnapshotMarkdown(snapshot: ProgressSnapshot): string {
  const lines: string[] = [];

  lines.push(`## Progress — ${snapshot.productSlug}`);
  lines.push("");
  lines.push(
    `**Backlog:** ${snapshot.backlogTotal} total · ${snapshot.backlogV1Count} v1 · ${snapshot.backlogDeferredCount} deferred`,
  );

  const activeLabel = snapshot.activeSprintNumber !== null ? `Sprint ${snapshot.activeSprintNumber}` : "none";
  lines.push(`**Sprints:** ${snapshot.sprintTotal} planned · active: ${activeLabel}`);
  lines.push("");

  if (snapshot.activeSprintNumber === null) {
    lines.push("No active sprint.");
  } else {
    const totalItems = snapshot.activeSprintItems.length;
    const doneItems = snapshot.activeSprintItems.filter((i) => i.status === "done").length;

    lines.push(`### Sprint ${snapshot.activeSprintNumber} — ${snapshot.activeSprintGoal ?? ""}`);
    lines.push(`Progress: ${snapshot.activeSprintPercentDone}% (${doneItems}/${totalItems} items done)`);
    lines.push("");

    for (const item of snapshot.activeSprintItems) {
      const icon = statusIcon(item.status);
      lines.push(`- ${icon} ${item.title} — ${item.status} · ${item.criteriaMet}/${item.criteriaTotal}`);
    }
  }

  lines.push("");
  lines.push("### Blockers");
  if (snapshot.blockers.length === 0) {
    lines.push("_None_");
  } else {
    for (const b of snapshot.blockers) {
      lines.push(`- ${b.title}: ${b.reason}`);
    }
  }

  lines.push("");
  lines.push("### Worker");
  lines.push(`Stage: ${snapshot.workerCurrentStage ?? "(idle)"}`);
  lines.push(`Last event: ${snapshot.workerLastEventUtc ?? "(none)"}`);

  return lines.join("\n");
}
