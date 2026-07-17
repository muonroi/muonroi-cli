/**
 * src/ui/utils/tool-summary.ts
 *
 * Phrasing for the tool-group panel. Pure string helpers, no React, so the
 * wording is unit-testable and the component stays presentational.
 *
 * Active:  "Reading 2 files…"          (header, present participle)
 * Done:    "Read 2 files, ran 1 shell command"   (past-tense recap)
 *
 * Counting is per CATEGORY, not per tool name: read_file and
 * mcp__filesystem__read_text_file are both "files" to a reader.
 */

import { verbForTool } from "./tools.js";

interface Category {
  /** Present participle for the active header — reuses verbForTool's vocabulary. */
  gerund: string;
  /** Past tense for the done recap. Lowercase; the first phrase is capitalized. */
  past: string;
  noun: string;
  nounPlural: string;
}

const CATEGORIES: Record<string, Category> = {
  read: { gerund: "Reading", past: "read", noun: "file", nounPlural: "files" },
  write: { gerund: "Writing", past: "wrote", noun: "file", nounPlural: "files" },
  edit: { gerund: "Editing", past: "edited", noun: "file", nounPlural: "files" },
  bash: { gerund: "Running", past: "ran", noun: "shell command", nounPlural: "shell commands" },
  search: { gerund: "Searching", past: "ran", noun: "search", nounPlural: "searches" },
  agent: { gerund: "Exploring", past: "ran", noun: "sub-agent", nounPlural: "sub-agents" },
  other: { gerund: "Working", past: "ran", noun: "tool", nounPlural: "tools" },
};

/** Stable phrase order so the recap doesn't reshuffle as items land. */
const ORDER = ["read", "write", "edit", "bash", "search", "agent", "other"] as const;

export function categoryForTool(name: string): string {
  if (name === "write_file" || /^mcp_+filesystem__write_file$/.test(name)) return "write";
  if (name === "edit_file" || /^mcp_+filesystem__edit_file$/.test(name)) return "edit";
  if (name === "bash") return "bash";
  if (name === "task" || name === "delegate") return "agent";
  // Fall back to the existing verb vocabulary so a new tool inherits sane
  // phrasing without being enumerated here twice.
  const verb = verbForTool(name);
  if (verb === "Reading") return "read";
  if (verb === "Searching") return "search";
  return "other";
}

function countByCategory(toolNames: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of toolNames) {
    const c = categoryForTool(n);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

function phrase(cat: Category, n: number, past: boolean): string {
  const noun = n === 1 ? cat.noun : cat.nounPlural;
  return past ? `${cat.past} ${n} ${noun}` : `${cat.gerund} ${n} ${noun}`;
}

/**
 * Header while the group runs: "Reading 2 files…".
 * With a mixed batch the dominant category wins and the rest are summed into a
 * trailing "+N more" so the header never claims work it isn't doing.
 */
export function activeToolGroupHeader(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return "Working…";
  const counts = countByCategory(toolNames);
  let bestKey = "other";
  let best = 0;
  for (const key of ORDER) {
    const c = counts.get(key) ?? 0;
    if (c > best) {
      best = c;
      bestKey = key;
    }
  }
  const rest = toolNames.length - best;
  const head = phrase(CATEGORIES[bestKey]!, best, false);
  return rest > 0 ? `${head} +${rest} more…` : `${head}…`;
}

/** Past-tense recap once the group closes: "Read 2 files, ran 1 shell command". */
export function doneToolGroupSummary(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return "Done";
  const counts = countByCategory(toolNames);
  const parts: string[] = [];
  for (const key of ORDER) {
    const n = counts.get(key) ?? 0;
    if (n > 0) parts.push(phrase(CATEGORIES[key]!, n, true));
  }
  const joined = parts.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
