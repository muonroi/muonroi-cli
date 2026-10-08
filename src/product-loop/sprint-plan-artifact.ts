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
 *
 * D5 — the fast-path side-channel does not guarantee the `{step, owner_lens,
 * time_estimate, depends_on, acceptance_criteria}` shape either: a SECOND live
 * run (`muauw6u93e1c`) produced `structuredActionItems` shaped `{key, value}`
 * instead (an index string and the actual work description). Neither
 * `o.step` nor any known criterion/dependency key matched, so the title
 * became the raw `JSON.stringify(o)` blob and `doneCriterion` came out empty
 * for all 6 tasks. `buildTaskFromRawItem` below is therefore alias-based and
 * case-insensitive rather than hardcoded to one key name, with an explicit
 * "exactly one long string field" fallback for shapes like `{key, value}`
 * that match none of the known aliases at all.
 *
 * D6 — that fallback adopted the sole long string WHATEVER it was, so a task
 * could be titled with an owner note, a UUID, or a time estimate (reproduced
 * against b70db771: `{step_id, owner_lens}` -> "the platform team lead
 * responsible for auth"; `{ref, correlation_id}` -> the raw UUID;
 * `{n, time_estimate}` -> "about three and a half working days"). Two causes,
 * both fixed below: `owner_lens`/`time_estimate` were read by DIRECT key
 * access so they never entered the `used` set, and the 20-char floor admits a
 * pure identifier (a UUID is 36 chars). The floor is unchanged — raising it
 * would reject a real short imperative — and the fallback now filters by KEY
 * (`nonDescriptionKeyReason`) and by VALUE SHAPE (`identifierValueReason`)
 * instead, declining WITH a per-field reason in `notes` rather than silently.
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

// ─── D5 — shape-tolerant action-item field resolution ───────────────────────
//
// A council-produced action-item object's key names vary across live runs
// (see the module doc above): `step` vs `value`, `acceptance_criteria` vs
// `done_when`, `depends_on` vs `deps`, sometimes different casing entirely.
// Rather than a single hardcoded key per field, each field has an alias list,
// matched case-insensitively, first match wins.

const DESCRIPTION_ALIASES = ["step", "task", "title", "description", "action", "value", "text", "item"];
const CRITERION_ALIASES = [
  "acceptance_criteria",
  "acceptancecriteria",
  "done_when",
  "criterion",
  "donecriterion",
  "acceptance",
];
const DEPENDS_ON_ALIASES = ["depends_on", "dependson", "deps", "blocked_by", "dependencies", "after"];
/** D6 — `owner_lens`/`time_estimate` used to be read by DIRECT key access, so
 * they never entered the `used` set and stayed eligible as "the sole long
 * string" for the description fallback below (measured: an owner note and a
 * time estimate each became a task `title`). They now go through `pickAlias`
 * like every other field — same single key each, so extraction is unchanged
 * apart from becoming case-insensitive like the rest of the function. */
const OWNER_ALIASES = ["owner_lens"];
const ESTIMATE_ALIASES = ["time_estimate"];

/** A string field is only treated as a stand-in task description (the
 * `{key, value}` fallback below) once it clears this length — short values
 * like an index ("1") or an id are never mistaken for the work description. */
const LONG_STRING_MIN_CHARS = 20;

// ─── D6 — the fallback adopts a WORK DESCRIPTION, not any long string ────────
//
// The "sole remaining long string" fallback earns its place on the `{key,
// value}` shape, but before D6 it adopted whatever single long string was
// left, so `{step_id, owner_lens}` titled the task with an owner note,
// `{ref, correlation_id}` with a UUID, and `{n, time_estimate}` with a time
// estimate. The floor is NOT the lever — raising it would reject a real short
// imperative like "Fix the failing InternalsVisibleTo test" (39 chars) while
// still admitting a 36-char UUID. Two cheap structural filters instead.

/** Keys that name a field this function already extracts under a different
 * name, or an identifier reference — never the work description, whatever
 * their value looks like. Deliberately tiny: each entry is either a plain
 * synonym of `owner_lens`/`time_estimate` (whose measured values are PROSE, so
 * the shape rule below provably cannot reject them) or an id key. Nothing
 * speculative — a key like `rationale` or `notes` still qualifies, because
 * real prose about the work is a better title than a placeholder. */
const NON_DESCRIPTION_KEYS = new Set([
  "owner", // synonym of the already-consumed `owner_lens`
  "assignee", // the other common name for the same field
  "estimate", // synonym of the already-consumed `time_estimate`
  "eta", // ditto
  "duration", // ditto
]);

/** `id`, `run_id`, `correlationId`, `uuid`, `guid` … — an identifier reference
 * by definition. Measured key `correlation_id` carried a UUID (which the shape
 * rule also catches), but the key name stays decisive when the encoding is
 * not, e.g. `run_id: "run mu54vrme4c87 sprint two"`. */
const IDENTIFIER_KEY_RE = /(^|_)(id|uuid|guid)$|[a-z0-9](Id|Uuid|UUID|Guid|GUID)$/;

/** Scripts written without inter-word spaces. The "must contain whitespace"
 * half of the shape rule below would otherwise reject every CJK description
 * outright, which is a false reject, not an identifier. */
const SPACELESS_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A prose word: an all-letter token of 2+ characters ("Fix", "the", "compiles",
 * "Sửa"). A UUID/hex/base64 blob contains no such token once split on
 * whitespace; any real sentence contains several. */
const PROSE_WORD_RE = /^\p{L}{2,}$/u;

/** Why this KEY can never be the work description, or null when it can. The
 * reason never embeds the key itself — both the note and the declined-task
 * placeholder title name the field separately. */
function nonDescriptionKeyReason(key: string): string | null {
  const lk = key.toLowerCase();
  if (NON_DESCRIPTION_KEYS.has(lk)) return "it names this task's owner/estimate, not the work to do";
  if (IDENTIFIER_KEY_RE.test(key) || IDENTIFIER_KEY_RE.test(lk)) return "it names an identifier, not the work";
  return null;
}

/**
 * D6 shape rule — why this VALUE is structurally an identifier rather than
 * prose, or null when it reads as prose. Two conditions, both about shape, so
 * a short real task ("Fix the failing InternalsVisibleTo test") always passes
 * and a long identifier never does:
 *   1. it contains no whitespace at all — a single token is a uuid, hash,
 *      path, slug or timestamp, never an instruction;
 *   2. no whitespace-separated token is a plain word — an identifier list
 *      ("550e8400-… 660e8400-…") has whitespace but no prose in it.
 * Text in a space-less script (CJK) is exempt from both — see SPACELESS_SCRIPT_RE.
 */
function identifierValueReason(value: string): string | null {
  if (SPACELESS_SCRIPT_RE.test(value)) return null;
  if (!/\s/.test(value)) {
    return "its value is a single token with no whitespace — an identifier (uuid/hash/path/slug), not a work description";
  }
  const tokens = value.split(/\s+/);
  if (!tokens.some((t) => PROSE_WORD_RE.test(t))) {
    return "its value contains no plain word — it reads as a list of identifiers, not a work description";
  }
  return null;
}

/** Cap for a key name or a decline reason echoed into a task TITLE. The title
 * flows into the implementation checklist block the model reads, so a long key
 * or reason must not blow the prompt budget on its own. (`boundTaskText`
 * bounds the assembled title again at `MAX_TASK_TEXT_CHARS`.) */
const MAX_PLACEHOLDER_PART_CHARS = 60;

function boundPlaceholderPart(text: string): string {
  const t = text.trim();
  return t.length > MAX_PLACEHOLDER_PART_CHARS ? `${t.slice(0, MAX_PLACEHOLDER_PART_CHARS)}…` : t;
}

/**
 * D6 — the placeholder title for a task whose description fallback DECLINED a
 * candidate. The generic "no recognizable description or criterion field"
 * wording is false here: a field WAS recognized as a candidate and rejected on
 * purpose, and the title is what a human reads first in the artifact and what
 * the checklist block shows the model. Saying one thing while the note beside
 * it says another is the exact failure this slice exists to remove.
 */
function declinedPlaceholderTitle(id: string, declined: Array<{ key: string; reason: string }>): string {
  const first = declined[0]!;
  const more = declined.length > 1 ? `; +${declined.length - 1} more declined` : "";
  return `Untitled task ${id} (candidate field "${boundPlaceholderPart(first.key)}" declined: ${boundPlaceholderPart(first.reason)}${more})`;
}

/** Case-insensitive key -> value map, first occurrence wins on a duplicate
 * (case-folded) key. Never throws. */
function lowerKeyMap(o: Record<string, unknown>): Map<string, { key: string; value: unknown }> {
  const m = new Map<string, { key: string; value: unknown }>();
  for (const [key, value] of Object.entries(o)) {
    const lk = key.toLowerCase();
    if (!m.has(lk)) m.set(lk, { key, value });
  }
  return m;
}

/** First alias present in `km` and not already in `used` — marks it used so a
 * later field never reuses the same source key. Returns the ORIGINAL (not
 * lowercased) key name alongside the value, for diagnostics. */
function pickAlias(
  km: Map<string, { key: string; value: unknown }>,
  aliases: string[],
  used: Set<string>,
): { key: string; value: unknown } | undefined {
  for (const alias of aliases) {
    const lk = alias.toLowerCase();
    if (used.has(lk)) continue;
    const hit = km.get(lk);
    if (hit === undefined) continue;
    used.add(lk);
    return hit;
  }
  return undefined;
}

/** A string field's plain text, trimmed; "" for anything else (never throws,
 * never stringifies a non-string). */
function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Up to the first sentence-ending punctuation or line break, capped at
 * `maxLen` — used to derive a title from a criterion/description when no
 * dedicated title field exists, instead of stringifying the whole object. */
function firstClause(text: string, maxLen = 160): string {
  const t = text.trim();
  const m = t.match(/^[^.!?\n]+[.!?]?/);
  const clause = (m ? m[0] : t).trim();
  return clause.length > maxLen ? `${clause.slice(0, maxLen)}…` : clause;
}

/** Build one SprintPlanTask from a raw action-item (string or object),
 * 1-indexed. `notes` collects per-task diagnostics (never fabricates a value
 * to avoid a note — an empty `doneCriterion` and a note are both honest). */
function buildTaskFromRawItem(raw: unknown, idx: number, notes: string[]): SprintPlanTask {
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
    const km = lowerKeyMap(o);
    const used = new Set<string>();

    // D6 — which field consumed which key, so the description fallback can say
    // WHY a long string it saw was not reused, instead of silently skipping it.
    const consumedBy = new Map<string, string>();
    const consume = (aliases: string[], label: string) => {
      const hit = pickAlias(km, aliases, used);
      if (hit) consumedBy.set(hit.key.toLowerCase(), label);
      return hit;
    };

    const criterionHit = consume(CRITERION_ALIASES, "acceptance criterion");
    const criterionRaw = criterionHit?.value;
    const doneCriterion =
      typeof criterionRaw === "string"
        ? criterionRaw.trim()
        : Array.isArray(criterionRaw)
          ? criterionRaw.filter((x) => typeof x === "string").join("; ")
          : "";
    if (!doneCriterion) {
      notes.push(
        `Task ${id}: no recognizable acceptance-criterion field (keys: ${Object.keys(o).join(", ") || "(none)"}) — doneCriterion left empty.`,
      );
    }

    const dependsOnHit = consume(DEPENDS_ON_ALIASES, "dependency list");
    const dependsOn = normalizeDependsOn(dependsOnHit?.value);

    // D6 — owner/estimate go through `pickAlias` like every other field so the
    // keys they consume are marked `used`. Read by direct key access they were
    // never marked, and the description fallback below happily adopted them
    // (measured: an owner note and a time estimate each became the `title`).
    const ownerHit = consume(OWNER_ALIASES, "owner");
    const owner = typeof ownerHit?.value === "string" ? ownerHit.value : undefined;
    const estimateHit = consume(ESTIMATE_ALIASES, "time estimate");
    const estimate = typeof estimateHit?.value === "string" ? estimateHit.value : undefined;

    const descriptionHit = consume(DESCRIPTION_ALIASES, "description");
    let description = asTrimmedString(descriptionHit?.value);
    let usedFallbackField: string | undefined;
    /** D6 — long strings the fallback SAW and declined, each with its reason. */
    const declined: Array<{ key: string; reason: string }> = [];
    /** D6 — >1 field could each be the description; adopting one would be a guess. */
    let ambiguousKeys: string[] = [];
    if (!description) {
      // No known description key matched. When the object has EXACTLY ONE
      // remaining long string field that reads as work (e.g. `{key: "1",
      // value: "<the actual task text>"}` — "key" is too short to qualify),
      // that is the description. Anything already consumed by another field,
      // any key that names an owner/estimate/identifier, and any value that is
      // structurally an identifier rather than prose is DECLINED WITH A REASON
      // rather than silently adopted.
      const candidates: Array<{ key: string; value: string }> = [];
      for (const [key, rawValue] of Object.entries(o)) {
        if (typeof rawValue !== "string") continue;
        const value = rawValue.trim();
        if (value.length < LONG_STRING_MIN_CHARS) continue;
        const lk = key.toLowerCase();
        if (used.has(lk)) {
          declined.push({
            key,
            reason: `it is already consumed as this task's ${consumedBy.get(lk) ?? "other field"}`,
          });
          continue;
        }
        const keyReason = nonDescriptionKeyReason(key);
        if (keyReason) {
          declined.push({ key, reason: keyReason });
          continue;
        }
        const valueReason = identifierValueReason(value);
        if (valueReason) {
          declined.push({ key, reason: valueReason });
          continue;
        }
        candidates.push({ key, value });
      }
      if (candidates.length === 1) {
        description = candidates[0]!.value;
        usedFallbackField = candidates[0]!.key;
      } else if (candidates.length > 1) {
        ambiguousKeys = candidates.map((c) => c.key);
      }
    }

    // D6 — each placeholder states what ACTUALLY happened. The generic wording
    // is kept only for the case it is still true of: nothing usable was there.
    let title: string;
    if (description) {
      title = description;
    } else if (doneCriterion) {
      title = firstClause(doneCriterion);
    } else if (ambiguousKeys.length > 0) {
      title = `Untitled task ${id} (${ambiguousKeys.length} candidate fields, none adopted: picking one would be a guess)`;
    } else if (declined.length > 0) {
      title = declinedPlaceholderTitle(id, declined);
    } else {
      title = `Untitled task ${id} (no recognizable description or criterion field)`;
    }

    if (usedFallbackField) {
      notes.push(
        `Task ${id}: description sourced from field "${usedFallbackField}" — no recognized description key ` +
          `(tried: ${DESCRIPTION_ALIASES.join(", ")}) matched this item's shape.`,
      );
    } else if (!description) {
      // D6 — say WHY the title is not this item's own long text. Every
      // declined candidate is named with its reason, so a wrong exclusion is
      // diagnosable from the artifact's own notes instead of needing a fresh
      // live-run forensics pass.
      for (const d of declined) {
        notes.push(`Task ${id}: field "${d.key}" was NOT adopted as the description — ${d.reason}.`);
      }
      if (ambiguousKeys.length > 0) {
        notes.push(
          `Task ${id}: ${ambiguousKeys.length} fields could each be the description (${ambiguousKeys.join(", ")}) — ` +
            `none adopted, because picking one would be a guess.`,
        );
      }
      if (doneCriterion) {
        notes.push(`Task ${id}: no recognizable description field — title derived from the acceptance criterion.`);
      } else if (declined.length === 0 && ambiguousKeys.length === 0) {
        // Only claim "nothing recognizable" when that is true. When a
        // candidate was declined the reason is already one note per field
        // above, and the placeholder title itself names the declined field.
        notes.push(
          `Task ${id}: no recognizable description or criterion field at all (keys: ${Object.keys(o).join(", ") || "(none)"}) — title is a placeholder.`,
        );
      }
    }

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

/** The raw item's own key set, as a diagnostic label — `"{key1, key2}"` for
 * an object, or its JS type for anything else. Sorted so the same shape
 * always renders the same label regardless of key order in the source. */
function describeItemShape(raw: unknown): string {
  if (raw && typeof raw === "object")
    return Object.keys(raw as object)
      .sort()
      .join(", ");
  return typeof raw;
}

/** D5 — record which raw action-item shape(s) this plan actually used, so a
 * future mismatch (a third shape from a future run) is diagnosable from the
 * artifact's own notes instead of requiring a fresh live-run forensics pass. */
function noteDetectedShapes(items: unknown[], notes: string[]): void {
  const counts = new Map<string, number>();
  for (const raw of items) {
    const shape = describeItemShape(raw);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  for (const [shape, count] of counts) {
    notes.push(`Action-item shape detected: {${shape}} (${count} task${count === 1 ? "" : "s"}).`);
  }
}

/** Build the task list from raw action-item objects/strings, plus a note about
 * any `dependsOn` reference that does not match a known task id in this set. */
function buildTasksFromRawItems(items: unknown[], notes: string[]): SprintPlanTask[] {
  noteDetectedShapes(items, notes);
  const tasks = items.map((raw, idx) => buildTaskFromRawItem(raw, idx, notes));
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
  /**
   * D5 — a further real, non-invented fallback for `outcome.goal`, tried after
   * `sprintFocus`: a short description of this sprint's active backlog item
   * (e.g. its `title`/`description`, joined by the caller). Only reached when
   * the plan carries no summary AND no `sprintFocus` was given.
   */
  backlogFocus?: string;
  /**
   * D5 — a real, non-invented fallback for `outcome.acceptance` when the plan
   * text itself yields none: this sprint's own rows from `criteria.json`
   * (`readCriteriaSnapshot`, filtered to `sprint === sprintN`), passed by the
   * caller.
   */
  criteriaFallback?: string[];
}

/**
 * Pure builder — no I/O. Never throws; every extraction step is defensive so a
 * malformed plan degrades to a lesser `source`, never an exception.
 */
export function buildSprintPlanArtifact(args: BuildSprintPlanArtifactArgs): SprintPlanArtifact {
  const { sprintN, runId, planSynthesis, structuredActionItems, sprintFocus, backlogFocus, criteriaFallback } = args;
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
  // D5 — the fast path can produce a plan whose own text carries no
  // acceptance criteria at all (run `muauw6u93e1c`: `acceptance: []`). Fall
  // back to this sprint's own criteria.json rows before leaving it empty —
  // an honest, already-seeded source, never invented here.
  if (acceptance.length === 0 && criteriaFallback && criteriaFallback.length > 0) {
    acceptance = criteriaFallback;
    notes.push(
      `Acceptance criteria sourced from ${criteriaFallback.length} criteria.json row(s) for sprint ${sprintN} (the plan text itself carried none).`,
    );
  }

  const jsonBlock = parsePlanJsonBlock(planSynthesis ?? "");

  // Goal: plan's own summary, else the given sprint focus, else the active
  // backlog item's own description, else empty + a note. Every fallback step
  // records WHY it was reached, so a future gap is diagnosable rather than
  // silently degrading to an empty goal.
  let goal = "";
  const summaryRaw = jsonBlock?.summary;
  if (typeof summaryRaw === "string" && summaryRaw.trim()) {
    goal = summaryRaw.trim();
  } else if (sprintFocus?.trim()) {
    goal = sprintFocus.trim();
    notes.push("Goal sourced from the carried-over sprint focus (the plan text itself carried no summary).");
  } else if (backlogFocus?.trim()) {
    goal = backlogFocus.trim();
    notes.push("Goal sourced from the active backlog item (no plan summary and no sprint focus were available).");
  } else {
    notes.push(
      "No goal available: the plan carried no summary and no sprint focus was provided; no backlog item was available either.",
    );
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
