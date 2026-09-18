/**
 * src/product-loop/sprint-plan-artifact.ts
 *
 * S3a — give every `/ideal` sprint one explicit OUTCOME (goal + acceptance) and
 * N structured task plans, persisted as `sprints/<n>-plan.json`.
 *
 * Observability and structure only: this module never drives the implementation
 * turn (that is S3b). It reads the SAME `planSynthesis` text sprint-runner.ts
 * already produces and never mutates it.
 *
 * `planSynthesis` comes from `council/index.ts`'s `runCouncil` in one of two
 * shapes (see `sprint-1-plan.md` / `sprint-2-plan.md` evidence, run
 * mu54vrme4c87):
 *   - Full `runPlanning` path: begins with a JSON block carrying `summary`,
 *     `acceptance_criteria[]` and `actionItems[]` (objects with `step`,
 *     `owner_lens`, `time_estimate`, `depends_on`, `acceptance_criteria`),
 *     followed by `---READABLE---` + prose. The JSON block survives into the
 *     persisted text, so it can be re-parsed here directly.
 *   - Fast path (`pickActionItemsFromOutcome` finds >=3 action items):
 *     `synthesizePlanFromActionItems` (council/index.ts) FLATTENS those same
 *     object fields into one `description` string per step and discards
 *     `depends_on` (kept only as a priority heuristic) — the resulting
 *     `planSynthesis` is plain prose ("Sprint plan locked (N steps): - [prio]
 *     desc — accept: ..."). To recover real structure on this path, the raw
 *     action-item objects are carried out-of-band via
 *     `CouncilStats.structuredActionItems` (see council/types.ts) BEFORE they
 *     get flattened, and passed into `buildSprintPlanArtifact` here.
 */

import { createHash } from "node:crypto";
import { extractAcceptanceCriteria } from "./criteria-seed.js";
import { extractPlanTargetDirs, extractPlanTargetPaths } from "./plan-target-paths.js";

export interface SprintPlanTask {
  /** `step1`..`stepN`, matching the `depends_on` references the plan itself uses. */
  id: string;
  title: string;
  /** The task's own acceptance/done criterion, when the source names one. */
  doneCriterion: string;
  /** Other task ids this one depends on. Unknown references are kept, never dropped. */
  dependsOn: string[];
  /** Repo-relative FILE paths this task's text names (a known dir + a dotted extension). May be empty — never invented. */
  targetFiles: string[];
  /** Repo-relative DIRECTORY paths this task's text names, no extension required. Excludes anything already in `targetFiles`. May be empty — never invented. */
  targetDirs: string[];
  owner?: string;
  estimate?: string;
  priority?: "high" | "medium" | "low";
  /**
   * S3b — a task is "done" only when the plan-adherence reviewer's per-task
   * verdict says so (`applyTaskVerdictsToPlanArtifact` in sprint-runner.ts).
   * Diff-touch of `targetFiles`/`targetDirs` is supplementary evidence only —
   * see `touchedTargets` — and never flips this by itself.
   *
   * C4 — `"dropped"` is set only by `applyItemDebateToPlanArtifact`
   * (`product-loop/item-debate-apply.ts`) when a per-item debate's leader
   * ruled `changeKind: "drop"`. History is kept (the task object stays in
   * `tasks`, with `droppedReason` explaining how) rather than deleting the
   * entry — downstream readers that must not act on a dropped task
   * (`buildTaskChecklistBlock` below, `taskAwareReviewPrompt` /
   * `normalizeTaskVerdicts` in plan-adherence-review.ts) filter it out
   * themselves; nothing here removes it from `tasks`.
   */
  status: "pending" | "done" | "dropped";
  /**
   * C4 — present only when `status === "dropped"`: the leader's bounded
   * reason the task was dropped, carried from the item-debate ruling. Never
   * set for any other status.
   * @testonly — no production consumer yet; wired into a real `/ideal`
   * sprint by a later slice (see debatable-items.ts module doc for the same
   * pattern).
   */
  droppedReason?: string;
  /** S3b — the reviewer's own evidence for the current `status`. Absent until
   * the task-aware plan-adherence review has run at least once. Never invented. */
  evidence?: string;
  /** S3b — the reviewer's own note on what's missing/wrong, when `status` is
   * still "pending". Absent until reviewed, or once the task is "done". */
  deviation?: string;
  /**
   * S3b — whether the diff touched this task's declared targets, per the most
   * recent task-aware review pass. `null` when the task names no targets at
   * all (nothing to check). `undefined` until the task-aware review has run.
   * Supplementary evidence only — see the field-level note on `status`.
   */
  touchedTargets?: boolean | null;
}

export interface SprintPlanArtifact {
  version: 1;
  sprintN: number;
  runId: string;
  /**
   * sha256 hex digest of the `planSynthesis` this artifact was built from.
   * Lets a resumed sprint detect a STALE persisted `sprints/<n>-plan.json`
   * (the on-disk `planSynthesis` text changed since this artifact was built,
   * e.g. a retried non-deterministic council run) and rebuild instead of
   * silently serving mismatched structure.
   */
  planHash: string;
  /**
   * "structured" — built from real action-item objects (side-channel or the
   * plan's own JSON block). "text-derived" — no structured items existed, but
   * the prose text yielded parseable bullet lines. "none" — nothing usable.
   */
  source: "structured" | "text-derived" | "none";
  outcome: {
    /** Empty when the plan carried no summary and no sprint focus was given — never invented. */
    goal: string;
    acceptance: string[];
  };
  tasks: SprintPlanTask[];
  notes: string[];
}

/** sha256 hex digest of a plan's `planSynthesis` text — the staleness key persisted
 * as `SprintPlanArtifact.planHash`. Pure, deterministic, never throws. */
export function computePlanHash(planSynthesis: string): string {
  return createHash("sha256")
    .update(planSynthesis ?? "", "utf8")
    .digest("hex");
}

/** Extract both FILE and DIRECTORY targets from one task's text, sharing the
 * FILE result so `extractPlanTargetDirs` can exclude anything already a file. */
function extractTargetsFromText(text: string, cap = 10): { files: string[]; dirs: string[] } {
  const files = extractPlanTargetPaths(text, cap);
  const dirs = extractPlanTargetDirs(text, files, cap);
  return { files, dirs };
}

/** Parse the JSON block heading `planSynthesis` (before an optional `---READABLE---`
 * separator), mirroring criteria-seed.ts's `extractAcceptanceCriteria` block-finding
 * logic. Returns null on absence or a parse failure — never throws. */
function parsePlanJsonBlock(planSynthesis: string): Record<string, unknown> | null {
  if (!planSynthesis?.trim()) return null;
  const jsonPart = planSynthesis.includes("---READABLE---") ? planSynthesis.split("---READABLE---")[0]! : planSynthesis;
  const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    console.error(`[sprint-plan-artifact] parsePlanJsonBlock failed to parse plan JSON: ${(err as Error).message}`);
    return null;
  }
}

/** Normalise a `depends_on` value (array, comma-separated string, "none"/"") into
 * a clean string[]. Never throws. */
function normalizeDependsOn(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((d) => (typeof d === "string" ? d.trim() : d != null ? String(d).trim() : ""))
      .filter((d) => d.length > 0 && d.toLowerCase() !== "none");
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") return [];
    return trimmed
      .split(/[,;]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Build one SprintPlanTask from a raw action-item (string or object), 1-indexed. */
function buildTaskFromRawItem(raw: unknown, idx: number): SprintPlanTask {
  const id = `step${idx + 1}`;
  if (typeof raw === "string") {
    const { files, dirs } = extractTargetsFromText(raw);
    return {
      id,
      title: raw,
      doneCriterion: "",
      dependsOn: [],
      targetFiles: files,
      targetDirs: dirs,
      status: "pending",
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const step = typeof o.step === "string" ? o.step : "";
    const title = step || JSON.stringify(o).slice(0, 200);
    const doneCriterionRaw = o.acceptance_criteria ?? o.acceptanceCriteria;
    const doneCriterion =
      typeof doneCriterionRaw === "string"
        ? doneCriterionRaw
        : Array.isArray(doneCriterionRaw)
          ? doneCriterionRaw.filter((x) => typeof x === "string").join("; ")
          : "";
    const owner = typeof o.owner_lens === "string" ? o.owner_lens : undefined;
    const estimate = typeof o.time_estimate === "string" ? o.time_estimate : undefined;
    const dependsOn = normalizeDependsOn(o.depends_on);
    const { files: targetFiles, dirs: targetDirs } = extractTargetsFromText(
      `${title} ${doneCriterion} ${JSON.stringify(o)}`,
    );
    return {
      id,
      title,
      doneCriterion,
      dependsOn,
      targetFiles,
      targetDirs,
      ...(owner !== undefined ? { owner } : {}),
      ...(estimate !== undefined ? { estimate } : {}),
      status: "pending",
    };
  }
  return {
    id,
    title: String(raw),
    doneCriterion: "",
    dependsOn: [],
    targetFiles: [],
    targetDirs: [],
    status: "pending",
  };
}

/** Parse the flattened fast-path prose ("Sprint plan locked (N steps): - [prio]
 * desc — accept: ...") into best-effort tasks. Only extracts what the text
 * literally contains — no `dependsOn` (lost in flattening), no invented fields. */
function parseProseTasks(planSynthesis: string): SprintPlanTask[] {
  const tasks: SprintPlanTask[] = [];
  const lines = planSynthesis.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = line.match(/^[-*]\s*(?:\[(\w+)\]\s*)?(.+)$/);
    if (!m) continue;
    const rest = m[2]!.trim();
    if (!rest) continue;
    const priorityRaw = m[1]?.toLowerCase();
    const priority: "high" | "medium" | "low" | undefined =
      priorityRaw === "high" || priorityRaw === "medium" || priorityRaw === "low" ? priorityRaw : undefined;
    const acceptSep = /\s+[—-]\s*accept:\s*/i;
    const parts = rest.split(acceptSep);
    const title = (parts[0] ?? rest).trim();
    const doneCriterion = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
    const { files, dirs } = extractTargetsFromText(rest);
    tasks.push({
      id: `step${tasks.length + 1}`,
      title,
      doneCriterion,
      dependsOn: [],
      targetFiles: files,
      targetDirs: dirs,
      ...(priority !== undefined ? { priority } : {}),
      status: "pending",
    });
  }
  return tasks;
}

/** Build the task list from raw action-item objects/strings, plus a note about
 * any `dependsOn` reference that does not match a known task id in this set. */
function buildTasksFromRawItems(items: unknown[], notes: string[]): SprintPlanTask[] {
  const tasks = items.map((raw, idx) => buildTaskFromRawItem(raw, idx));
  const knownIds = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!knownIds.has(dep)) {
        notes.push(`Task ${t.id} depends on "${dep}", which is not a task id in this sprint's plan.`);
      }
    }
  }
  return tasks;
}

export interface BuildSprintPlanArtifactArgs {
  sprintN: number;
  runId: string;
  /** The exact text sprint-runner.ts persists as `sprints/<n>-plan.md`. Read-only. */
  planSynthesis: string;
  /**
   * Raw action-item objects carried out-of-band from the council's fast path
   * (`CouncilStats.structuredActionItems`), captured BEFORE
   * `synthesizePlanFromActionItems` flattens them. Undefined/empty when this
   * sprint's plan didn't take the fast path, or the field wasn't threaded
   * through (e.g. a mocked council in a test).
   */
  structuredActionItems?: unknown[];
  /** Real, non-invented fallback for `outcome.goal` when the plan carries no summary
   * (e.g. `carryOver?.focus`). Never fabricated by this module. */
  sprintFocus?: string;
}

/**
 * Pure builder — no I/O. Never throws; every extraction step is defensive so a
 * malformed plan degrades to a lesser `source`, never an exception.
 */
export function buildSprintPlanArtifact(args: BuildSprintPlanArtifactArgs): SprintPlanArtifact {
  const { sprintN, runId, planSynthesis, structuredActionItems, sprintFocus } = args;
  const notes: string[] = [];
  const planHash = computePlanHash(planSynthesis ?? "");

  // Acceptance criteria: reuse the same JSON-block-then-markdown extraction the
  // criteria-seed store already uses, so this artifact never disagrees with
  // what actually got seeded as Criterion rows.
  let acceptance: string[] = [];
  try {
    acceptance = extractAcceptanceCriteria(planSynthesis ?? "");
  } catch (err) {
    console.error(`[sprint-plan-artifact] acceptance extraction failed: ${(err as Error).message}`);
  }

  const jsonBlock = parsePlanJsonBlock(planSynthesis ?? "");

  // Goal: plan's own summary, else the given sprint focus, else empty + a note.
  let goal = "";
  const summaryRaw = jsonBlock?.summary;
  if (typeof summaryRaw === "string" && summaryRaw.trim()) {
    goal = summaryRaw.trim();
  } else if (sprintFocus?.trim()) {
    goal = sprintFocus.trim();
  } else {
    notes.push("No goal available: the plan carried no summary and no sprint focus was provided.");
  }

  // Structured items: prefer the side-channel (fast path, pre-flatten), else the
  // plan's own JSON block actionItems (full path — already structured in the text).
  let rawItems: unknown[] | undefined = structuredActionItems?.length ? structuredActionItems : undefined;
  if (!rawItems && jsonBlock) {
    const fromJson = jsonBlock.actionItems ?? jsonBlock.action_items;
    if (Array.isArray(fromJson) && fromJson.length > 0) rawItems = fromJson;
  }

  if (rawItems && rawItems.length > 0) {
    const tasks = buildTasksFromRawItems(rawItems, notes);
    return { version: 1, sprintN, runId, planHash, source: "structured", outcome: { goal, acceptance }, tasks, notes };
  }

  const proseTasks = parseProseTasks(planSynthesis ?? "");
  if (proseTasks.length > 0) {
    return {
      version: 1,
      sprintN,
      runId,
      planHash,
      source: "text-derived",
      outcome: { goal, acceptance },
      tasks: proseTasks,
      notes,
    };
  }

  notes.push("No action items could be derived from the plan text — tasks is empty.");
  return { version: 1, sprintN, runId, planHash, source: "none", outcome: { goal, acceptance }, tasks: [], notes };
}

// ─── S3b — task checklist for the implementation prompt ─────────────────────

/** Cap for task `title`/`doneCriterion` text embedded in a prompt (checklist
 * or reviewer task list) — mirrors `plan-adherence-review.ts`'s `bound()`
 * style so a single runaway task never blows the prompt budget. */
export const MAX_TASK_TEXT_CHARS = 300;

/** Bound a task's free text (title/doneCriterion) to `max` chars. Same shape
 * as `plan-adherence-review.ts`'s private `bound()` — exported here so both
 * the checklist and the reviewer task list truncate identically. */
export function boundTaskText(text: string, max = MAX_TASK_TEXT_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export interface TopologicalTaskOrder {
  /** `tasks`, reordered so every task follows everything it `dependsOn`. Every
   * input task appears exactly once, INCLUDING duplicate ids — see notes. */
  order: SprintPlanTask[];
  /** One note per unknown `dependsOn` reference, per duplicate task id, or per cycle detected. */
  notes: string[];
}

/**
 * Order tasks so every task follows everything it `dependsOn` (Kahn's
 * algorithm), breaking ties by the tasks' original array order so the result
 * is deterministic. Graph bookkeeping is keyed by ARRAY INDEX, not task id —
 * two tasks sharing the same id are two distinct nodes, so neither is ever
 * silently merged or dropped (a duplicate id is possible input: e.g. a
 * council retry that appended rather than replaced a step). Never throws —
 * handles three failure modes a plan's own data can carry:
 *   - an id that names no task in this set: the edge is dropped (treated as
 *     already satisfied) and a note is added.
 *   - a duplicate task id: every occurrence is kept (a dependency on that id
 *     depends on ALL of them), and one note names the id + count.
 *   - a dependency cycle: the tasks still in the cycle once no more
 *     zero-indegree tasks remain are appended in their original order, and a
 *     single note lists them.
 */
export function topologicallyOrderTasks(tasks: SprintPlanTask[]): TopologicalTaskOrder {
  const notes: string[] = [];
  const n = tasks.length;

  // Every index sharing a given id — the id->task Map an earlier version used
  // here collapsed duplicates onto one entry, which silently dropped every
  // occurrence but the last from the resulting order.
  const idToIndices = new Map<string, number[]>();
  tasks.forEach((t, i) => {
    const arr = idToIndices.get(t.id);
    if (arr) arr.push(i);
    else idToIndices.set(t.id, [i]);
  });
  for (const [id, idxs] of idToIndices) {
    if (idxs.length > 1) {
      notes.push(
        `Task id "${id}" appears ${idxs.length} times in this sprint's plan — every occurrence is kept, in original order.`,
      );
    }
  }

  const indegree = new Array<number>(n).fill(0);
  const dependents: number[][] = tasks.map(() => []);
  tasks.forEach((t, i) => {
    for (const dep of t.dependsOn) {
      const depIdxs = idToIndices.get(dep);
      if (!depIdxs || depIdxs.length === 0) {
        notes.push(
          `Task ${t.id} depends on "${dep}", which is not a task id in this sprint's plan — ignored for ordering.`,
        );
        continue;
      }
      for (const depIdx of depIdxs) {
        dependents[depIdx]!.push(i);
        indegree[i]! += 1;
      }
    }
  });

  const ready: number[] = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) ready.push(i);
  const visited = new Array<boolean>(n).fill(false);
  const orderIdx: number[] = [];
  while (ready.length > 0) {
    // Deterministic pick: lowest original index among the currently-ready set.
    ready.sort((a, b) => a - b);
    const idx = ready.shift()!;
    if (visited[idx]) continue;
    visited[idx] = true;
    orderIdx.push(idx);
    for (const dependentIdx of dependents[idx] ?? []) {
      indegree[dependentIdx]! -= 1;
      if (indegree[dependentIdx]! <= 0 && !visited[dependentIdx]) ready.push(dependentIdx);
    }
  }

  const stuckIdx: number[] = [];
  for (let i = 0; i < n; i++) if (!visited[i]) stuckIdx.push(i);
  if (stuckIdx.length > 0) {
    notes.push(
      `Dependency cycle detected among task(s) ${stuckIdx.map((i) => tasks[i]!.id).join(", ")} — kept in their original plan order.`,
    );
    orderIdx.push(...stuckIdx);
  }

  return { order: orderIdx.map((i) => tasks[i]!), notes };
}

/**
 * The checklist block appended to the implementation prompt when the sprint
 * plan has tasks (`source !== "none"`). Empty tasks -> empty block, so a
 * caller can unconditionally append the result. Short, imperative wording —
 * the model already read the full plan above this block. `title`/
 * `doneCriterion` are bounded (`boundTaskText`) so one runaway task text
 * cannot blow the prompt budget.
 */
export function buildTaskChecklistBlock(tasks: SprintPlanTask[]): { block: string; notes: string[] } {
  // C4 — a dropped task (`applyItemDebateToPlanArtifact`) is history, not
  // work: it never appears in the implementation checklist. Any other task's
  // `dependsOn` still naming it is handled by `topologicallyOrderTasks`'s
  // existing "unknown dependency" tolerance (the edge is dropped + noted),
  // exactly as it already does for any id absent from this set.
  const activeTasks = tasks.filter((t) => t.status !== "dropped");
  if (activeTasks.length === 0) return { block: "", notes: [] };
  const { order, notes } = topologicallyOrderTasks(activeTasks);
  const lines = order.map((t, i) => {
    const targets = [...t.targetFiles, ...t.targetDirs];
    const title = boundTaskText(t.title);
    const doneSuffix = t.doneCriterion ? ` — done when: ${boundTaskText(t.doneCriterion)}` : "";
    const targetsSuffix = targets.length > 0 ? ` — targets: ${targets.join(", ")}` : "";
    return `${i + 1}. [${t.id}] ${title}${doneSuffix}${targetsSuffix}`;
  });
  const block = `\n\n--- SPRINT TASK CHECKLIST (work through these IN ORDER; do not skip any) ---\n${lines.join("\n")}\n`;
  return { block, notes };
}
