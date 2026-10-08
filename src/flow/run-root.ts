/**
 * src/flow/run-root.ts
 *
 * Anchor a flow-state directory to the RUN, not to whatever the tool cwd
 * happens to be at the moment of the write.
 *
 * ## The incident this exists for (measured, 2026-09-09)
 *
 * After a resumed `/ideal` run, `D:\sources\CompanyLibs\tcis-libraries` held
 * BOTH state trees:
 *
 *   <repo>\.muonroi-flow\                 ← the run's real tree
 *   <repo>\src\.muonroi-flow\planning\    ← a rival, created 4 minutes later
 *
 * The stray contained ONLY `planning/` (config.json, CONTEXT.md, PLAN.md,
 * ROADMAP.md, STATE.md, phases/02-sprint-2-plan/) — no `runs/`, no
 * `roadmap.md`, no `state.md` — so it was NOT `ensureFlowDir`'s doing. It is a
 * GSD planning tree, and every GSD path resolves through `planningRoot(cwd)`
 * (src/gsd/paths.ts).
 *
 * The cwd it resolved is recorded in the DB. For that run's session
 * (`65856a53e25d`, and its verify sub-agent `5ec7999af53f`):
 *
 *   cwd_at_start = D:\sources\CompanyLibs\tcis-libraries
 *   cwd_last     = D:\sources\CompanyLibs\tcis-libraries\src
 *
 * because at 2026-09-09T15:21:56Z a bash call ran
 * `cd /d/sources/CompanyLibs/tcis-libraries/src && dotnet run …`, and the bash
 * tool's `cd` handler mutates `BashTool.cwd` permanently (src/tools/bash.ts:176
 * `this.cwd = nextCwd`). Every flow-state resolver downstream reads that value
 * — `src/tools/registry.ts:1420` hands `bash.getCwd()` to the GSD workflow
 * tools, and `src/orchestrator/orchestrator.ts` hands the same value to
 * `runProductLoop` and `ensureFlowDir`. The stray's first file (config.json,
 * 15:25:45Z) lands 3m49s after that `cd`.
 *
 * ## The rule
 *
 * `getCommitRunRoot()` is the directory the run was launched in — the same
 * anchor the commit guard and the write guard already use, so the three cannot
 * disagree about what "this run" means. A drifted cwd is re-anchored to it, but
 * ONLY when all of these hold:
 *
 *   1. the cwd is a strict descendant of the run root (a cwd outside it is not
 *      ours to move: temp dirs in tests, an explicitly pointed-to directory);
 *   2. the run root IS a git worktree root, and the cwd is inside that SAME
 *      worktree. This is what keeps the documented ecosystem-root launch
 *      working: `D:\sources\Core` is a real launch directory here and is NOT a
 *      git repo, so every sibling repo under it keeps its own state tree rather
 *      than sharing one at the ecosystem root. It also refuses to reach into a
 *      NESTED linked worktree (`<repo>/.wt-sprint`), which owns other history;
 *   3. the cwd does not already own a state tree of its own — a genuinely
 *      nested project keeps what it has. An existing tree is never moved.
 *
 * Consequence worth stating plainly: a repo that ALREADY has a stray tree from
 * before this fix keeps it (clause 3). This prevents the split from happening,
 * it does not heal one that already happened — deleting state a run may still
 * be reading is a worse failure than leaving a directory behind.
 *
 * Opt out with `MUONROI_FLOW_RUN_ANCHOR=0` (matches the `MUONROI_COMMIT_SCOPE`
 * / `MUONROI_WRITE_SCOPE` escape-hatch convention).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { getCommitRunRoot } from "../orchestrator/auto-commit.js";
import { canonicalize, isInside, worktreeRootOfDir } from "../tools/write-scope.js";
import { logger } from "../utils/logger.js";

/** Directory names that mark a directory as owning its own flow/planning state. */
const STATE_TREE_MARKERS = [".muonroi-flow", ".planning"] as const;

/** True when `dir` already holds a flow-state tree of its own. */
function ownsStateTree(dir: string): boolean {
  return STATE_TREE_MARKERS.some((m) => existsSync(path.join(dir, m)));
}

/** `MUONROI_FLOW_RUN_ANCHOR=0` restores the pre-fix ambient-cwd behavior. */
export function flowRunAnchorEnabled(): boolean {
  return process.env.MUONROI_FLOW_RUN_ANCHOR !== "0";
}

/**
 * The directory a flow-state tree for `cwd` belongs in.
 *
 * Returns `cwd` unchanged in every case except the one this module exists for:
 * a cwd that drifted into a subdirectory of the run's own checkout and has no
 * state tree of its own. See the rule above.
 */
export function runAnchoredStateRoot(cwd: string): string {
  if (!flowRunAnchorEnabled()) return cwd;
  let runRoot: string;
  let here: string;
  try {
    runRoot = canonicalize(getCommitRunRoot());
    here = canonicalize(cwd);
  } catch (err) {
    // Path canonicalization is best-effort by construction; if it cannot run at
    // all, the honest answer is "leave the caller's cwd alone" — but say so, so
    // a repeated failure is diagnosable rather than a silent behavior change.
    logger.warn("orchestrator", "[flow/run-root] anchor skipped: could not canonicalize paths", {
      cwd,
      error: (err as Error)?.message,
    });
    return cwd;
  }

  if (here === runRoot) return cwd;
  if (!isInside(runRoot, here)) return cwd;

  // Repo identity — the run must be pinned to a checkout, and the drifted cwd
  // must be in that same checkout.
  const runWorktree = worktreeRootOfDir(runRoot);
  if (!runWorktree || runWorktree !== runRoot) return cwd;
  if (worktreeRootOfDir(here) !== runWorktree) return cwd;

  // A nested project that already owns state keeps it. Never move a live tree.
  if (ownsStateTree(here)) return cwd;

  logger.info("orchestrator", "[flow/run-root] flow-state dir re-anchored to the run root (tool cwd had drifted)", {
    driftedCwd: here,
    runRoot,
  });
  return getCommitRunRoot();
}
