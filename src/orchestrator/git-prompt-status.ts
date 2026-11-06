/**
 * src/orchestrator/git-prompt-status.ts
 *
 * One line of git state for the system prompt's DYNAMIC suffix (prompts.ts
 * buildSystemPromptParts): branch, short HEAD and dirty-file count, so the
 * model starts every turn knowing where it is instead of spending a bash call
 * on `git status`. Kept out of the cached static prefix on purpose — it
 * changes with every commit/edit.
 *
 * One `git status --porcelain=v2 --branch` spawn yields all three facts.
 * Bounded: 1.5s timeout, GIT_OPTIONAL_LOCKS=0 (a status probe must never take
 * index.lock while the agent's own git command runs), and a short per-cwd
 * cache because the prompt is rebuilt several times per turn. Never throws;
 * returns "" outside a git work tree.
 */
import { spawnSync } from "node:child_process";
import { logger } from "../utils/logger.js";

const STATUS_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 5000;

interface CachedLine {
  line: string;
  at: number;
}

const cache = new Map<string, CachedLine>();

/** Test helper. */
export function __resetGitPromptStatusCache(): void {
  cache.clear();
}

/** Parse `git status --porcelain=v2 --branch` output into the prompt line. */
export function formatGitPromptStatus(porcelainV2: string): string {
  let branch = "";
  let oid = "";
  let dirty = 0;
  for (const raw of porcelainV2.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
    else if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length).trim();
    else if (!line.startsWith("#")) dirty++;
  }
  if (!branch && !oid) return "";
  const head = oid === "(initial)" ? "(no commits)" : oid.slice(0, 7);
  return `- Git: branch ${branch || "(unknown)"} @ ${head || "(unknown)"}; ${dirty} dirty file${dirty === 1 ? "" : "s"}`;
}

/** Prompt line for `cwd`, or "" outside a git repository / on any failure (logged). */
export function gitPromptStatus(cwd: string, now = Date.now()): string {
  if (process.env.MUONROI_PROMPT_GIT_STATUS === "0") return "";
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.line;
  let line = "";
  try {
    const r = spawnSync("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], {
      cwd,
      encoding: "utf8",
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (r.error) {
      logger.file("warn", "orchestrator", "[git-prompt-status] git status did not complete", {
        operation: "gitPromptStatus",
        cwd,
        error: r.error.message,
      });
    } else if (r.status === 0) {
      line = formatGitPromptStatus(r.stdout ?? "");
    }
    // Non-zero exit = not a git work tree (exit 128): absence is the answer, not a failure.
  } catch (err) {
    logger.file("warn", "orchestrator", "[git-prompt-status] git status threw", {
      operation: "gitPromptStatus",
      cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  cache.set(cwd, { line, at: now });
  return line;
}
