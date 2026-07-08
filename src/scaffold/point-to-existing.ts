/**
 * point-to-existing.ts — Validate a user-provided path for an existing project
 * and detect whether it contains a verify recipe.
 *
 * Designed for testability: callers inject detectVerifyRecipe so unit tests
 * never hit the real orchestrator.
 */

import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import type { VerifyRecipe } from "../types/index.js";
import { inferVerifyProjectProfile } from "../verify/recipes.js";
import { detectBBFramework } from "./init-new.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PointToExistingOptions {
  /** Raw path string entered by the user. May be relative or absolute. */
  path: string;
  /**
   * Injected verify-recipe detector.
   * Returns a non-null recipe when the cwd looks like a configured project,
   * or null when no recipe is found.
   */
  detectVerifyRecipe: (cwd: string) => Promise<unknown | null>;
}

export type PointToExistingReason = "not_a_dir" | "no_recipe" | "ok";

export interface PointToExistingResult {
  ok: boolean;
  reason: PointToExistingReason;
  recipe?: unknown;
  absolutePath: string;
  /** Detected target framework (e.g. "muonroi-building-block") when BB heuristic matches. */
  targetFramework?: "muonroi-building-block" | string;
}

export { detectBBFramework };

/**
 * Deterministic, filesystem-only verify-recipe detection for an existing project
 * the user pointed to via the CB-3 recovery card.
 *
 * WHY NOT the orchestrator's detectVerifyRecipe: that path runs an LLM
 * verify-detect sub-agent against the orchestrator's OWN (session) cwd via
 * `this.bash.getCwd()` — it cannot inspect an arbitrary pointed-to directory, so
 * wiring it here was deferred and the handler stubbed to `null` (point-to-existing
 * therefore ALWAYS reported "no recipe", making the recovery option inert).
 * `inferVerifyProjectProfile` reads the target dir's manifest/build files
 * directly (package.json test/check/lint, Makefile, pyproject, go.mod, cargo,
 * maven/gradle, *.csproj) — the correct detector for adopting an existing repo.
 *
 * Returns the recipe only when it is actually RUNNABLE (has a test/build/start
 * command). The bare "unknown" fallback that `inferVerifyProjectProfile` emits
 * for a directory with no recognizable project files carries empty commands →
 * we return null so point-to-existing correctly reports `no_recipe` instead of
 * falsely adopting an empty directory.
 */
export function detectExistingProjectRecipe(cwd: string): VerifyRecipe | null {
  const { recipe } = inferVerifyProjectProfile(cwd);
  const runnable = recipe.testCommands.length > 0 || recipe.buildCommands.length > 0 || Boolean(recipe.startCommand);
  return runnable ? recipe : null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Resolve and validate a user-provided path for sprint re-entry.
 *
 * Steps:
 *  1. Resolve to an absolute path (handles ~ and relative segments).
 *  2. Stat — confirm it is an existing directory. Returns `not_a_dir` otherwise.
 *  3. Call opts.detectVerifyRecipe(absPath). If null → `no_recipe`.
 *  4. Return { ok: true, reason: "ok", recipe, absolutePath }.
 */
export async function pointToExisting(opts: PointToExistingOptions): Promise<PointToExistingResult> {
  // Step 1: resolve to absolute path, expanding ~ on POSIX.
  const expanded = opts.path.startsWith("~")
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/", opts.path.slice(1))
    : opts.path;

  const absolutePath = path.resolve(expanded);

  // Step 2: verify it is an existing directory.
  try {
    // realpathSync also catches dangling symlinks.
    realpathSync(absolutePath);
    const st = statSync(absolutePath);
    if (!st.isDirectory()) {
      return { ok: false, reason: "not_a_dir", absolutePath };
    }
  } catch {
    return { ok: false, reason: "not_a_dir", absolutePath };
  }

  // Step 3: detect verify recipe.
  const recipe = await opts.detectVerifyRecipe(absolutePath);
  if (recipe === null || recipe === undefined) {
    return { ok: false, reason: "no_recipe", absolutePath };
  }

  // Step 4: success.
  const targetFramework = detectBBFramework(absolutePath);
  return { ok: true, reason: "ok", recipe, absolutePath, ...(targetFramework ? { targetFramework } : {}) };
}
