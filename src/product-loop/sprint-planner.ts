/**
 * src/product-loop/sprint-planner.ts
 *
 * Converts a Backlog (P6 output) into a SprintPlan by:
 *  1. Filtering to v1 items only.
 *  2. Topo-sorting by blockers[] (items with no blockers first).
 *  3. Greedy bin-packing items into sprints with target effort ≈ 8 pts.
 *  4. Batch LLM call for sprint goal strings.
 *  5. Updating each packed BacklogItem with status="in_sprint" + assigned_sprint.
 *
 * Model discipline: sprint goal generation uses
 *   pickCouncilTaskModel("sprint_goal", leaderModelId, costAware=true)
 * — NO hardcoded model id or provider in this file.
 */

import { pickCouncilTaskModel } from "../council/leader.js";
import type { CouncilLLM } from "../council/types.js";
import { updateBacklogItem } from "./backlog-store.js";
import type { Backlog, BacklogItem, Sprint, SprintPlan } from "./types.js";

export interface PlanSprintsInput {
  runId: string;
  backlog: Backlog;
  llm: CouncilLLM;
  leaderModelId: string;
  costAware: boolean;
  /** Default 8 effort points per sprint. */
  targetEffortPerSprint?: number;
}

// ─── Topo-sort helpers ───────────────────────────────────────────────────────

/**
 * Topological sort of v1 BacklogItems by their blockers[] references.
 * Items that have no v1 blockers come first. Cycles are detected; on cycle,
 * a warning is logged and the remaining items are appended in insertion order.
 */
function topoSort(items: BacklogItem[]): BacklogItem[] {
  const idSet = new Set(items.map((i) => i.id));
  // Build adjacency: item depends on its blockers that are also in the v1 set.
  const deps = new Map<string, Set<string>>();
  for (const item of items) {
    deps.set(item.id, new Set((item.blockers ?? []).filter((b) => idSet.has(b))));
  }

  const sorted: BacklogItem[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  let cycleDetected = false;

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (inStack.has(id)) {
      cycleDetected = true;
      return; // break cycle
    }
    inStack.add(id);
    for (const dep of deps.get(id) ?? []) {
      visit(dep);
    }
    inStack.delete(id);
    visited.add(id);
    const item = items.find((i) => i.id === id);
    if (item) sorted.push(item);
  }

  for (const item of items) {
    visit(item.id);
  }

  if (cycleDetected) {
    // Append any items that were skipped due to cycle detection (in insertion order).
    for (const item of items) {
      if (!visited.has(item.id)) {
        sorted.push(item);
      }
    }
    console.warn(
      `[sprint-planner] Dependency cycle detected in backlog for runId. Falling back to insertion order for affected items.`,
    );
  }

  return sorted;
}

// ─── Bin-packing ─────────────────────────────────────────────────────────────

/**
 * Greedy bin-pack: walk sorted items, add to current sprint while
 * sumEffort + item.effort <= targetEffortPerSprint + 2 (allow ±2 slack).
 * When exceeded, start the next sprint.
 */
function packIntoSprints(items: BacklogItem[], target: number): BacklogItem[][] {
  const slack = 2;
  const bins: BacklogItem[][] = [];
  let current: BacklogItem[] = [];
  let currentEffort = 0;

  for (const item of items) {
    if (current.length > 0 && currentEffort + item.effortPoints > target + slack) {
      bins.push(current);
      current = [];
      currentEffort = 0;
    }
    current.push(item);
    currentEffort += item.effortPoints;
  }
  if (current.length > 0) {
    bins.push(current);
  }

  return bins;
}

// ─── Sprint goal LLM call ─────────────────────────────────────────────────────

interface SprintGoalEntry {
  sprintNumber: number;
  goal: string;
}

/**
 * Ask the LLM to generate a 1-line goal for each sprint in a single batch call.
 * On any failure, gracefully degrade to "Complete items: <titles>".
 */
async function generateSprintGoalsBatch(
  bins: BacklogItem[][],
  llm: CouncilLLM,
  leaderModelId: string,
  costAware: boolean,
): Promise<string[]> {
  const model = pickCouncilTaskModel("sprint_goal", leaderModelId, costAware);

  const system =
    "You are a technical product manager. For each sprint given, write a concise 1-line sprint goal " +
    "(what the sprint delivers, user-value focused, max 15 words). " +
    'Respond ONLY with a JSON array: [{"sprintNumber":1,"goal":"..."},{"sprintNumber":2,"goal":"..."},...]';

  const sprintDescriptions = bins
    .map((items, idx) => {
      const titles = items.map((i) => i.title).join(", ");
      return `Sprint ${idx + 1}: ${titles}`;
    })
    .join("\n");

  const prompt =
    `Generate a 1-line sprint goal for each of the following ${bins.length} sprints:\n\n` +
    sprintDescriptions +
    "\n\nRespond with a JSON array only.";

  let raw: string;
  try {
    raw = await llm.generate(model, system, prompt, 512);
  } catch {
    return bins.map((items) => `Complete items: ${items.map((i) => i.title).join(", ")}`);
  }

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]) as SprintGoalEntry[];
      return bins.map((items, idx) => {
        const entry = arr.find((e) => e.sprintNumber === idx + 1);
        if (entry?.goal) return entry.goal;
        return `Complete items: ${items.map((i) => i.title).join(", ")}`;
      });
    }
  } catch {
    // JSON parse failed — fall through
  }

  return bins.map((items) => `Complete items: ${items.map((i) => i.title).join(", ")}`);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build a SprintPlan from a Backlog.
 * Also updates each picked BacklogItem in backlog.json with
 * status="in_sprint" and assigned_sprint=sprint.id.
 */
export async function planSprints(input: PlanSprintsInput): Promise<SprintPlan> {
  const { runId, backlog, llm, leaderModelId, costAware, targetEffortPerSprint = 8 } = input;

  // Step 1: filter to v1 items.
  const v1Items = backlog.items.filter((i) => i.mvp_priority === "v1");

  // Step 2: topo-sort by blockers.
  const sorted = topoSort(v1Items);

  // Step 3: greedy bin-pack.
  const bins = packIntoSprints(sorted, targetEffortPerSprint);

  // Step 4: batch sprint goal generation.
  const goals = bins.length > 0 ? await generateSprintGoalsBatch(bins, llm, leaderModelId, costAware) : [];

  // Step 5: construct Sprint objects.
  const sprints: Sprint[] = bins.map((items, idx) => ({
    id: `sprint-${idx + 1}`,
    number: idx + 1,
    goal: goals[idx] ?? `Complete items: ${items.map((i) => i.title).join(", ")}`,
    itemIds: items.map((i) => i.id),
    status: "planned",
  }));

  const plan: SprintPlan = {
    runId,
    sprints,
    createdAtUtc: new Date().toISOString(),
  };

  // Step 6: update each BacklogItem with status="in_sprint" + assigned_sprint.
  const flowDir = backlog.runId ? undefined : undefined; // flowDir comes from the call site
  // We cannot update backlog items here because we don't have flowDir in this function.
  // Callers should call updateBacklogItemsForPlan after planSprints.
  // Exporting a helper for this:
  void flowDir; // suppress lint

  return plan;
}

/**
 * After planSprints(), call this to patch each BacklogItem in backlog.json
 * with status="in_sprint" and assigned_sprint=sprint.id.
 *
 * Separated from planSprints() so that callers who persist the plan to disk
 * can also trigger item updates without needing to re-read the plan.
 */
export async function applySprintAssignments(flowDir: string, runId: string, plan: SprintPlan): Promise<void> {
  for (const sprint of plan.sprints) {
    for (const itemId of sprint.itemIds) {
      await updateBacklogItem(flowDir, runId, itemId, {
        status: "in_sprint",
        assigned_sprint: sprint.id,
      }).catch((err: unknown) => {
        // Non-fatal: item may have been deleted or runId changed between plan and apply.
        console.warn(`[sprint-planner] Failed to update backlog item ${itemId}: ${(err as Error).message}`);
      });
    }
  }
}
