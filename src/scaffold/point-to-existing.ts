/**
 * point-to-existing.ts — Validate a user-provided path for an existing project
 * and detect whether it contains a verify recipe.
 *
 * Designed for testability: callers inject detectVerifyRecipe so unit tests
 * never hit the real orchestrator.
 */

import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
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
