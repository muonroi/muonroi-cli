/**
 * src/reporter/query-router.ts
 *
 * Classifies a user's Discord message into a query kind using deterministic
 * pattern matching — no LLM, fast, zero cost.
 */

export type QueryKind = "progress" | "sprint" | "item" | "freeform";

export interface ClassifiedQuery {
  kind: QueryKind;
  /** Populated when kind="sprint" — the sprint number requested. */
  sprintNumber?: number;
  /** Populated when kind="item" — the user's item search string. */
  itemQuery?: string;
  rawText: string;
}

const PROGRESS_RE =
  /^(progress|status|ti[eế]n\s*[đd][oộ]|b[aá]o\s*c[aá]o|how\s+is\s+it\s+going|how's\s+it\s+going|\/status)\??\s*$/iu;

const SPRINT_NUMBER_RE = /^(?:show\s+)?sprint\s+(\d+)/i;

// Matches: "show item X", "tell me about item X", "explain feature X", "show task X"
const ITEM_RE = /^(?:show|tell(?:\s+me\s+about)?|explain)\s+(?:item|task|feature)\s+(.+)/i;

/**
 * Classify a raw user message text into a QueryKind.
 *
 * Priority: progress > sprint > item > freeform
 */
export function classifyQuery(text: string): ClassifiedQuery {
  const trimmed = text.trim();

  if (PROGRESS_RE.test(trimmed)) {
    return { kind: "progress", rawText: trimmed };
  }

  const sprintMatch = SPRINT_NUMBER_RE.exec(trimmed);
  if (sprintMatch) {
    return { kind: "sprint", sprintNumber: Number(sprintMatch[1]), rawText: trimmed };
  }

  const itemMatch = ITEM_RE.exec(trimmed);
  if (itemMatch) {
    // Group [1] is the query text after "item|task|feature <query>"
    return { kind: "item", itemQuery: itemMatch[1]?.trim(), rawText: trimmed };
  }

  return { kind: "freeform", rawText: trimmed };
}
