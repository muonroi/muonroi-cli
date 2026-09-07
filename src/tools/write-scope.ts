/**
 * src/tools/write-scope.ts
 *
 * Containment for AGENT FILE WRITES — the write-side twin of the commit-scope
 * guard in `src/orchestrator/auto-commit.ts`.
 *
 * ## The incident this exists for (measured twice, in production)
 *
 * `BashTool` pins its cwd at construction (src/orchestrator/orchestrator.ts:489
 * `new BashTool(process.cwd())`), and the bash tool's `cd` handler then mutates
 * it with NO containment check (src/tools/bash.ts `this.cwd = nextCwd`, guarded
 * only by a `stat()`/`isDirectory()`). Forked sub-sessions share that same
 * instance and `src/orchestrator/stream-runner.ts:328`
 * (`new BashTool(topBash.getCwd())`) propagates the drifted value to task
 * sub-agents, so ONE `cd` moves the whole run — permanently.
 *
 *   Escape #1 (2026-09-06): a run pinned to a linked worktree ran
 *   `cd <parent-repo> && git log`; every later command inherited that cwd and an
 *   `edit_file src/headless/output.ts` 22 minutes later wrote into the PARENT
 *   repo. Three commits landed on the parent's branch. `checkCommitScope` was
 *   added and now blocks that commit path.
 *
 *   Escape #2 (2026-09-07, WITH the commit guard in place): a run pinned to
 *   `.wt-sprint` wrote `+65` lines to `src/headless/output.test.ts` and `+7/-1`
 *   to `src/headless/output.ts` in the parent working tree. Zero commits
 *   escaped — the commit guard held — but the WRITES did. Blocking the commit
 *   bounds the damage to history; it does not stop a run from silently editing
 *   files whose unmodified state is another experiment's control.
 *
 * ## Why the write, and not the `cd`
 *
 * Escape #1's actual `cd` command was `cd <parent> && git log --oneline -5` — a
 * READ. Refusing that would break a workflow this user relies on (cross-repo
 * inspection across the sibling repos under the ecosystem root) while preventing
 * nothing: the harm arrived later, from a WRITE at the drifted cwd. So the hard
 * refusal sits on the write; the `cd` only warns loudly that the run left its
 * launch directory (see `bash.ts`).
 *
 * ## The rule
 *
 * A write is allowed when its RESOLVED ABSOLUTE target satisfies both:
 *
 *   1. containment — the target is inside the run root (the directory the run
 *      was launched in, read from `getCommitRunRoot()` so the two guards can
 *      never disagree about what "this run" means), inside the OS temp dir, or
 *      inside an operator-configured extra root; and
 *   2. repo identity — when the run root is itself inside a git worktree, the
 *      target's worktree must be that SAME worktree. This is what catches a
 *      NESTED linked worktree (`<repo>/.wt-sprint`), which passes containment
 *      but owns different history.
 *
 * A `cd` into a SUB-directory of the run root keeps both properties, so ordinary
 * sessions are untouched. Launching from the ecosystem root (`D:\sources\Core`,
 * verified NOT a git repo) makes every sibling repo a child of the run root, so
 * cross-repo work keeps working by construction.
 *
 * Fails LOUD, never silent: a refusal is logged AND returned to the agent as a
 * BLOCKED result naming both roots and what to do — the same treatment
 * `describeCommitScopeBlock` gives a refused commit. A silent no-op is the bug,
 * not the fix.
 *
 * Worktree detection is a SYNCHRONOUS `.git` walk-up rather than
 * `git rev-parse --show-toplevel`: no subprocess on every write, no git binary
 * required in tests. It agrees with `--show-toplevel` for a normal checkout
 * (`.git` directory) and for a linked worktree (`.git` FILE holding
 * `gitdir: ...`), which are the two shapes in the incidents. It deliberately
 * does NOT model `GIT_DIR`/`GIT_WORK_TREE` env overrides or bare repos.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCommitRunRoot } from "../orchestrator/auto-commit.js";

/** Filename of the optional per-run extra-roots config (mirrors the harness's). */
export const WRITE_ROOTS_CONFIG = ".muonroi-write-roots.json";

/**
 * Default ON. `MUONROI_WRITE_SCOPE=0` is a USER escape hatch, mirroring the
 * `MUONROI_COMMIT_SCOPE=0` / `MUONROI_AUTO_COMMIT=0` convention. Deliberately
 * never surfaced to the model — same treatment as the commit guard's bypass and
 * the LSP gate's: telling the agent about it just invites circumvention.
 */
export function isWriteScopeGuardEnabled(): boolean {
  return process.env.MUONROI_WRITE_SCOPE !== "0";
}

/**
 * Opt-in extra write roots layered ON TOP of {run root, temp dir}. Posture stays
 * deny-by-default: only roots an operator explicitly listed are added. Mirrors
 * `loadExtraRoots()` in packages/agent-harness-core/src/mcp-server.ts, including
 * its win32 ";"-separator handling so drive letters survive splitting.
 *
 *   1. env `MUONROI_WRITE_SCOPE_ROOTS` — OS-path-list and/or comma separated.
 *   2. `<runRoot>/.muonroi-write-roots.json` — `{ "roots": string[] }`.
 */
export function loadExtraWriteRoots(runRoot: string): string[] {
  const roots: string[] = [];
  const envVal = process.env.MUONROI_WRITE_SCOPE_ROOTS;
  if (envVal) {
    const listSep = process.platform === "win32" ? ";" : ":";
    for (const part of envVal.split(new RegExp(`[${listSep},]`))) {
      const trimmed = part.trim();
      if (trimmed) roots.push(trimmed);
    }
  }
  const cfgPath = path.resolve(runRoot, WRITE_ROOTS_CONFIG);
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as { roots?: unknown };
      if (Array.isArray(parsed.roots)) {
        for (const r of parsed.roots) {
          if (typeof r === "string" && r.trim()) roots.push(r.trim());
        }
      }
    } catch (err) {
      console.error(
        `[write-scope] failed to parse extra-roots config ${cfgPath}: ${(err as Error)?.message}`,
        (err as Error)?.stack?.split("\n").slice(0, 3),
      );
    }
  }
  return roots;
}

/**
 * Canonical form of `p` for comparison: realpath the deepest ancestor that
 * EXISTS (so a not-yet-created write target still resolves through symlinked
 * parents, e.g. macOS `/var` -> `/private/var`) and re-append the missing tail.
 * Never throws — an unresolvable path falls back to `path.resolve`.
 */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.resolve(realpathSync(cur), ...tail);
    } catch (err) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached the filesystem root without a single resolvable ancestor.
        // Nothing left to canonicalize against; use the lexical path.
        if (process.env.MUONROI_WRITE_SCOPE_DEBUG === "1") {
          console.error(`[write-scope] canonicalize fell back to lexical for ${abs}: ${(err as Error)?.message}`);
        }
        return abs;
      }
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `target` is `root` or lives underneath it. Both must be canonical. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  // path.relative is case-insensitive on win32, which is what we want here.
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const worktreeCache = new Map<string, string | null>();

/**
 * Git worktree root containing the DIRECTORY `dir` — the nearest self-or-ancestor
 * holding a `.git` entry, be it a directory (normal checkout) or a file (linked
 * worktree). `null` when `dir` is not inside any worktree. Cached per directory:
 * a single turn resolves the same handful of directories repeatedly.
 */
export function worktreeRootOfDir(dir: string): string | null {
  const seen: string[] = [];
  let cur = canonicalize(dir);
  for (;;) {
    const hit = worktreeCache.get(cur);
    if (hit !== undefined) {
      for (const d of seen) worktreeCache.set(d, hit);
      return hit;
    }
    seen.push(cur);
    if (existsSync(path.join(cur, ".git"))) {
      for (const d of seen) worktreeCache.set(d, cur);
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      for (const d of seen) worktreeCache.set(d, null);
      return null;
    }
    cur = parent;
  }
}

/** Git worktree root owning the FILE at `filePath` (which need not exist yet). */
export function worktreeRootOfFile(filePath: string): string | null {
  return worktreeRootOfDir(path.dirname(canonicalize(filePath)));
}

/** Drop memoized worktree lookups. Test seam; also safe to call after a checkout. */
export function resetWorktreeCache(): void {
  worktreeCache.clear();
}

export type WriteScopeReason = "outside-run-root" | "foreign-worktree";

export interface WriteScopeVerdict {
  ok: boolean;
  /** Canonical absolute path the write would land on. */
  target: string;
  /** The directory this run was launched in (shared with the commit guard). */
  runRoot: string;
  /** Why it was refused; `null` when allowed. */
  reason: WriteScopeReason | null;
  /** Worktree root of `target` (null = not in a repo). */
  targetWorktree: string | null;
  /** Worktree root of `runRoot` (null = the run did not start inside a repo). */
  runWorktree: string | null;
}

/**
 * Decide whether an agent write to `absTarget` lands inside what this run owns.
 * Never throws: any failure to canonicalize degrades to a lexical comparison.
 *
 * `absTarget` must already be resolved to absolute by the caller (file.ts does
 * this in `resolvePath`, which is also where an ABSOLUTE tool argument bypasses
 * the tool cwd entirely — checking the resolved path covers both the relative
 * cwd-drift vector and the absolute-path vector with one call).
 */
export function checkWriteScope(absTarget: string): WriteScopeVerdict {
  const runRoot = canonicalize(getCommitRunRoot());
  const target = canonicalize(absTarget);
  const base: WriteScopeVerdict = {
    ok: true,
    target,
    runRoot,
    reason: null,
    targetWorktree: null,
    runWorktree: null,
  };
  if (!isWriteScopeGuardEnabled()) return base;

  // Containment, run root first. Everything under the launch directory is a
  // candidate; the repo-identity rule below still applies to it.
  if (!isInside(runRoot, target)) {
    // Roots the operator explicitly opted into are allowed outright — that is
    // what opting in means.
    for (const extra of loadExtraWriteRoots(runRoot)) {
      try {
        if (isInside(canonicalize(extra), target)) return base;
      } catch (err) {
        console.error(`[write-scope] extra write root unresolved, skipping: ${extra} (${(err as Error)?.message})`);
      }
    }
    // Scratch space in the OS temp dir is allowed, but ONLY when the target is
    // not inside a git worktree. A throwaway temp file is not work product and
    // refusing it produces baffling failures in workflows agents legitimately
    // use; a CHECKOUT that happens to live under the temp dir is work product,
    // and blanket-allowing all of tmpdir would be a hole wide enough to drive
    // the original incident through (on Windows TEMP sits under the user
    // profile).
    const targetWorktree = worktreeRootOfFile(target);
    if (isInside(canonicalize(tmpdir()), target) && targetWorktree === null) return base;
    return {
      ...base,
      ok: false,
      reason: "outside-run-root",
      runWorktree: worktreeRootOfDir(runRoot),
      // Populated even though the message does not use it: the refusal LOG
      // prints this field, and reporting "<none>" for a path that is plainly
      // inside a checkout would be a lie in the one record an operator reads.
      targetWorktree,
    };
  }

  // Repo identity. Only meaningful when the run itself started inside a
  // worktree; a run launched outside any repo (e.g. the ecosystem root) has no
  // history of its own to be confined to, exactly as `checkCommitScope` reasons.
  const runWorktree = worktreeRootOfDir(runRoot);
  if (!runWorktree) return base;
  const targetWorktree = worktreeRootOfFile(target);
  // A target inside the run root but in NO worktree cannot be a foreign
  // worktree; allow. A target in a DIFFERENT worktree — the nested-linked-
  // worktree shape — is refused.
  if (targetWorktree !== null && targetWorktree !== runWorktree) {
    return { ...base, ok: false, reason: "foreign-worktree", targetWorktree, runWorktree };
  }
  return { ...base, targetWorktree, runWorktree };
}

/** The operator- and agent-facing explanation of a refused write. */
export function describeWriteScopeBlock(requestedPath: string, v: WriteScopeVerdict): string {
  const why =
    v.reason === "foreign-worktree"
      ? `it belongs to a DIFFERENT git worktree (${v.targetWorktree}) than the one this run was launched in (${v.runWorktree})`
      : `it is OUTSIDE the directory this run was launched in (${v.runRoot})`;
  return (
    `BLOCKED (write-scope): refused to write "${requestedPath}" — ${why}. ` +
    `Nothing was written. Resolved target: ${v.target}. ` +
    `Your tool working directory has most likely drifted out of the launch directory via a \`cd\`, ` +
    `so a relative path now resolves somewhere else. Write only inside ${v.runRoot}; ` +
    `if you truly need to change that other directory, run the CLI from there instead.`
  );
}

/**
 * Warning text for a `cd` that takes the tool cwd OUT of the run root, or `null`
 * when the new cwd is still inside it.
 *
 * This is a WARNING, not a refusal, and that asymmetry is deliberate. Escape #1's
 * `cd` was `cd <parent-repo> && git log --oneline -5` — read-only and harmless in
 * itself; blocking it would break cross-repo inspection, which is normal work
 * here. What made it dangerous was that the drift was SILENT and permanent, so
 * every later relative path quietly retargeted. Saying so out loud removes the
 * silence; `blockWriteIfOutOfScope` removes the harm.
 */
export function describeCwdDrift(newCwd: string): string | null {
  if (!isWriteScopeGuardEnabled()) return null;
  const runRoot = canonicalize(getCommitRunRoot());
  const target = canonicalize(newCwd);
  if (isInside(runRoot, target)) {
    const runWorktree = worktreeRootOfDir(runRoot);
    if (!runWorktree) return null;
    const targetWorktree = worktreeRootOfDir(target);
    if (targetWorktree === null || targetWorktree === runWorktree) return null;
    return (
      `WARNING (write-scope): the working directory is now in a DIFFERENT git worktree ` +
      `(${targetWorktree}) than the one this run was launched in (${runWorktree}). ` +
      `Relative paths now resolve there. File writes outside the launch directory will be REFUSED.`
    );
  }
  return (
    `WARNING (write-scope): the working directory has left the directory this run was launched in ` +
    `(${runRoot}) and is now ${target}. Relative paths now resolve there, not in the launch directory. ` +
    `Reads are fine; file writes outside the launch directory will be REFUSED. ` +
    `\`cd\` back before creating or editing files.`
  );
}

/**
 * One-call helper for a write tool: returns the refusal text, or `null` when the
 * write may proceed. Logs every refusal with module, operation and both roots so
 * a block is diagnosable from the transcript alone.
 */
export function blockWriteIfOutOfScope(requestedPath: string, absTarget: string): string | null {
  const verdict = checkWriteScope(absTarget);
  if (verdict.ok) return null;
  const detail = describeWriteScopeBlock(requestedPath, verdict);
  console.error(
    `[write-scope] refused write: reason=${verdict.reason} target=${verdict.target} ` +
      `runRoot=${verdict.runRoot} runWorktree=${verdict.runWorktree ?? "<none>"} ` +
      `targetWorktree=${verdict.targetWorktree ?? "<none>"}`,
  );
  return detail;
}
