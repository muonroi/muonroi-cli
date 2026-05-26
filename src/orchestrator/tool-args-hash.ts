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
 * Tools whose primary work IS the pipe chain — for these the pipe is part of
 * the actual query, not a cosmetic view. `grep -n "foo" f | head -5` vs
 * `grep -n "foo" f | wc -l` ask different questions of the same data;
 * collapsing them was a false-positive in session c8840867dcab where 3
 * legitimately-different grep invocations on src/index.ts tripped the
 * pattern-loop detector (canonical cut after `|` made all 3 hash equal).
 *
 * For these leading tokens we keep the FULL command (still strip leading
 * `cd ... &&` and redirections to disk, just not pipe truncation).
 */
const PIPE_NATIVE_TOOLS = new Set(["grep", "sed", "awk", "jq", "find", "rg", "xargs", "cut", "tr", "sort", "uniq"]);

/**
 * Verification commands that the agent re-runs as part of a normal
 * edit-typecheck-fix iteration cycle. The pattern detector should NOT count
 * re-runs of these as a loop signal — they are PROGRESS markers, not wandering.
 * Same session c8840867dcab tripped on 3x `bunx tsc --noEmit` between edits.
 *
 * The list intentionally tracks command STARTS (first 1-3 tokens) — once the
 * canonical form starts with any of these, hashToolArgs returns a `verify:`
 * sentinel which the detector ignores.
 */
const VERIFICATION_COMMAND_PREFIXES = [
  // bun-family typecheckers & runners
  "bunx tsc",
  "bun x tsc",
  "bun tsc",
  "tsc --noEmit",
  "tsc -p",
  // bunx variants for tools
  "bunx vitest",
  "bunx jest",
  "bunx eslint",
  "bunx biome",
  "bunx prettier",
  "bun test",
  "bun run test",
  "bun run lint",
  "bun run typecheck",
  "bun run check",
  "bun run build",
  // npx variants — Phase 5 BUG-F2 (session c96105db6ab6): agent fell back
  // to `npx tsc --noEmit` when `bunx tsc` was slow; the npx form was NOT
  // whitelisted, so repeated runs would have tripped the pattern guard.
  "npx tsc",
  "npx vitest",
  "npx jest",
  "npx eslint",
  "npx biome",
  "npx prettier",
  "npm test",
  "npm run test",
  "npm run lint",
  "npm run typecheck",
  "npm run build",
  "pnpm test",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm build",
  "pnpm exec tsc",
  "pnpm exec vitest",
  "yarn test",
  "yarn lint",
  "yarn typecheck",
  "yarn build",
  "vitest run",
  "vitest",
  "jest",
  "pytest",
  "cargo test",
  "cargo check",
  "cargo build",
  "cargo clippy",
  "go test",
  "go build",
  "go vet",
  "dotnet test",
  "dotnet build",
  "mvn test",
  "gradle test",
  "biome check",
  "biome ci",
  "eslint",
  "prettier --check",
  "prettier -c",
  "ruff check",
  "mypy",
  "phpunit",
  "rspec",
];

export function isVerificationCommand(canonical: string): boolean {
  const lower = canonical.toLowerCase().trim();
  for (const prefix of VERIFICATION_COMMAND_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Strip the redirection / pipe suffix and leading `cd` prefix from a bash
 * command so cosmetic variants collapse to the same canonical form.
 *
 * `cd /foo && bunx vitest run | tail -20` → `bunx vitest run`
 * `cd /foo && bunx vitest run 2>&1 | grep FAIL` → `bunx vitest run`
 * `bunx vitest run > /tmp/x.log` → `bunx vitest run`
 *
 * Exception (Phase 5 BUG-F, session c8840867dcab): when the leading command is
 * one of PIPE_NATIVE_TOOLS (grep/sed/awk/...), the pipe IS the query — keep it.
 * Only file redirections (`>`, `>>`, `2>`, `&>`) get cut for those.
 */
export function canonicalizeBashCommand(command: string): string {
  let s = command.trim();
  // Strip leading cd <dir> && prefix (chained directory hops are noise here).
  // Match `cd <path-or-quoted> && rest` — keep `rest`.
  const cdMatch = s.match(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*([\s\S]+)$/);
  if (cdMatch) s = cdMatch[1]!.trim();

  // Inspect first token (after optional `time`/env-var prefix) to decide
  // whether pipes are query-bearing.
  const firstTokenMatch = s.match(/^(?:time\s+|[A-Z_]+=\S+\s+)*(\S+)/);
  const firstToken = firstTokenMatch?.[1] ?? "";
  const pipeNative = PIPE_NATIVE_TOOLS.has(firstToken);

  if (pipeNative) {
    // Only strip true file redirections (not pipes). Keep the whole pipeline.
    const cutIdx = s.search(/\s+(?:>|2>|&>|>>)/);
    if (cutIdx >= 0) s = s.slice(0, cutIdx);
  } else {
    // Cut at first unquoted redirection or pipe operator. We don't bother
    // tracking quote state precisely — false-positive cuts inside quotes only
    // produce a stricter (more conservative) hash, never a wrong-positive one.
    const cutIdx = s.search(/\s+(?:\||>|2>|&>|>>)/);
    if (cutIdx >= 0) s = s.slice(0, cutIdx);
  }
  // Collapse internal whitespace runs to a single space.
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Compute a short hash for a tool call so the pattern detector can compare
 * "is this the same call again?" without retaining full args in memory.
 *
 * Returns the prefix `<toolName>:` followed by a sha1[0..12) of the canonical
 * form. Same `toolName` with cosmetic-only arg changes hash identically.
 *
 * Special cases beyond the generic JSON hash:
 *
 *   - `bash`: canonical command form (strip pipes/redirects/cd prefix).
 *   - `edit_file` / `write_file`: hash by file_path only — fires when the
 *     agent re-edits the same file with different old_string/new_string
 *     pairs. Observed in session 39884b072b5f where the agent edited
 *     `src/ee/export-transcripts.ts` 7+ times fighting biome auto-format,
 *     each attempt with a different old_string. Generic JSON hash never
 *     collapsed them. Now collapses.
 */
export function hashToolArgs(toolName: string, args: unknown): string {
  if (toolName === "bash" && args && typeof args === "object") {
    const cmd = (args as { command?: unknown }).command;
    if (typeof cmd === "string") {
      const canonical = canonicalizeBashCommand(cmd);
      // Verification commands (typecheck/test/lint) are re-run as part of
      // normal iteration — return a `verify:` sentinel hash that the detector
      // recognizes as "skip from loop accounting". Each verify invocation gets
      // a unique trailing nonce so even back-to-back runs never collide.
      if (isVerificationCommand(canonical)) {
        return `verify:${sha1(canonical)}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
      }
      return `bash:${sha1(canonical)}`;
    }
  }
  if ((toolName === "edit_file" || toolName === "write_file") && args && typeof args === "object") {
    const filePath = (args as { file_path?: unknown }).file_path;
    if (typeof filePath === "string") {
      // Normalize path separators so D:\Personal\... and D:/Personal/... collapse.
      const normalized = filePath.replace(/\\/g, "/");
      return `${toolName}:${sha1(normalized)}`;
    }
  }
  return `${toolName}:${sha1(stableJson(args ?? null))}`;
}
