/**
 * src/orchestrator/tool-args-hash.ts
 *
 * Pure helpers for the tool-pattern loop guard (Fix #1). The guard tracks the
 * last N tool calls in a ring buffer and asks the user when M of them collapse
 * to the same hash — a near-certain signal the agent is fishing the same
 * tool with cosmetic-only argument variations (e.g. `bunx vitest | tail -5`
 * vs `bunx vitest | head -10`).
 *
 * The hash deliberately ignores parts of the arguments that don't change what
 * the tool actually does:
 *
 *   - For `bash`: drop everything after the first unquoted `|` / `>` / `2>`,
 *     strip leading `cd <dir> &&` prefix, collapse whitespace.
 *   - For other tools: stable JSON of sorted keys.
 *
 * Extracted from tool-loop-cap.ts so it can be unit-tested without standing up
 * the full streamText harness.
 */

import { createHash } from "node:crypto";

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Strip the redirection / pipe suffix and leading `cd` prefix from a bash
 * command so cosmetic variants collapse to the same canonical form.
 *
 * `cd /foo && bunx vitest run | tail -20` → `bunx vitest run`
 * `cd /foo && bunx vitest run 2>&1 | grep FAIL` → `bunx vitest run`
 * `bunx vitest run > /tmp/x.log` → `bunx vitest run`
 */
export function canonicalizeBashCommand(command: string): string {
  let s = command.trim();
  // Strip leading cd <dir> && prefix (chained directory hops are noise here).
  // Match `cd <path-or-quoted> && rest` — keep `rest`.
  const cdMatch = s.match(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*([\s\S]+)$/);
  if (cdMatch) s = cdMatch[1]!.trim();
  // Cut at first unquoted redirection or pipe operator. We don't bother
  // tracking quote state precisely — false-positive cuts inside quotes only
  // produce a stricter (more conservative) hash, never a wrong-positive one.
  const cutIdx = s.search(/\s+(?:\||>|2>|&>|>>)/);
  if (cutIdx >= 0) s = s.slice(0, cutIdx);
  // Collapse internal whitespace runs to a single space.
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Compute a short hash for a tool call so the pattern detector can compare
 * "is this the same call again?" without retaining full args in memory.
 *
 * Returns the prefix `<toolName>:` followed by a sha1[0..12) of the canonical
 * form. Same `toolName` with cosmetic-only arg changes hash identically.
 */
export function hashToolArgs(toolName: string, args: unknown): string {
  if (toolName === "bash" && args && typeof args === "object") {
    const cmd = (args as { command?: unknown }).command;
    if (typeof cmd === "string") {
      return `bash:${sha1(canonicalizeBashCommand(cmd))}`;
    }
  }
  return `${toolName}:${sha1(stableJson(args ?? null))}`;
}
