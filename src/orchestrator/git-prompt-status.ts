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
 *
 * NON-BLOCKING: the prompt builder only ever reads the cache; a stale or
 * missing entry starts ONE background refresh and the line appears from the
 * next build on. It used to be `spawnSync` on the prompt path — in session
 * c2fda568be6b (TCIS replay temp clone) all 867 probes timed out, each one
 * freezing the event loop for the full 1.5s timeout. A probe that fails is not
 * retried for FAILURE_BACKOFF_MS, so a slow repository is not re-spawned every
 * few seconds either.
 */
import { execFile } from "node:child_process";
import { logger } from "../utils/logger.js";

const STATUS_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 5000;
const FAILURE_BACKOFF_MS = 60_000;

interface CachedLine {
  line: string;
  at: number;
  failed: boolean;
}

const cache = new Map<string, CachedLine>();
const inflight = new Map<string, Promise<string>>();

/** Test helper. */
export function __resetGitPromptStatusCache(): void {
  cache.clear();
  inflight.clear();
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

/**
 * Prompt line for `cwd` from the cache, or "" when none is known yet / outside
 * a git repository. Never blocks: a missing or stale entry starts a background
 * refresh ({@link refreshGitPromptStatus}) and returns what is cached now.
 */
export function gitPromptStatus(cwd: string, now = Date.now()): string {
  if (process.env.MUONROI_PROMPT_GIT_STATUS === "0") return "";
  const hit = cache.get(cwd);
  const ttl = hit?.failed ? FAILURE_BACKOFF_MS : CACHE_TTL_MS;
  if (!hit || now - hit.at >= ttl) void refreshGitPromptStatus(cwd);
  return hit?.line ?? "";
}

/**
 * Run the probe asynchronously (one in flight per cwd) and cache the result.
 * Resolves to the new line; never rejects (failures are logged and cached as
 * "" with a backoff).
 */
export function refreshGitPromptStatus(cwd: string): Promise<string> {
  const running = inflight.get(cwd);
  if (running) return running;
  const probe = new Promise<string>((resolve) => {
    try {
      execFile(
        "git",
        ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
        {
          cwd,
          encoding: "utf8",
          timeout: STATUS_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout) => {
          if (!error) {
            const line = formatGitPromptStatus(stdout ?? "");
            cache.set(cwd, { line, at: Date.now(), failed: false });
            resolve(line);
            return;
          }
          // Non-zero exit = not a git work tree (exit 128): absence is the answer, not a failure.
          const exitCode =
            typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
          const notARepo = exitCode !== null && !(error as { killed?: boolean }).killed;
          if (!notARepo) {
            logger.file("warn", "orchestrator", "[git-prompt-status] git status did not complete", {
              operation: "gitPromptStatus",
              cwd,
              error: error.message,
            });
          }
          cache.set(cwd, { line: "", at: Date.now(), failed: !notARepo });
          resolve("");
        },
      );
    } catch (err) {
      logger.file("warn", "orchestrator", "[git-prompt-status] git status threw", {
        operation: "gitPromptStatus",
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      cache.set(cwd, { line: "", at: Date.now(), failed: true });
      resolve("");
    }
  }).finally(() => inflight.delete(cwd));
  inflight.set(cwd, probe);
  return probe;
}
