/**
 * The ONE place that knows where the muonroi home (`~/.muonroi-cli`) lives.
 *
 * Priority: explicit `userHome` argument -> `MUONROI_CLI_HOME` env ->
 * `os.homedir()/.muonroi-cli`. With `MUONROI_CLI_HOME` unset and no argument the
 * result is byte-identical to the `path.join(os.homedir(), ".muonroi-cli")` every
 * store used to build for itself.
 *
 * Resolved LAZILY on every call, never as a module-level `const`: a const is
 * evaluated once at import, so a test importing the module normally could never
 * redirect it (`src/lsp/npm-cache.ts:20-28` records what that cost). Reading the
 * env var per call is what lets the suite-wide pin in
 * `src/__test-stubs__/vitest-setup.ts` reach every store.
 *
 * WHY a single helper: ~26 modules each carried their own copy of
 * `MUONROI_CLI_HOME ?? join(homedir(), ".muonroi-cli")`, and a dozen more built
 * `join(homedir(), ".muonroi-cli", ...)` WITHOUT the env check. The latter were
 * invisible to the pin: unit tests wrote 99 entries into the developer's real
 * `~/.muonroi-cli/ee-offline-queue` (2026-11-09 21:12-21:25, which a later
 * `drainQueue` replayed into an unrelated test's stub) and read the real
 * `user-settings.json`. `src/utils/__tests__/muonroi-home-guard.test.ts` fails
 * the build if a non-test file builds that path again outside this module.
 */

import os from "node:os";
import path from "node:path";

/** Directory name of the muonroi home under the user's home directory. */
export const MUONROI_HOME_DIRNAME = ".muonroi-cli";

/**
 * @param userHome Explicit user-home directory (NOT the muonroi home). When given
 *   it wins over `MUONROI_CLI_HOME`, so callers that take a `homeOverride`
 *   (tests, uninstall planning) keep addressing exactly the directory they named.
 */
export function muonroiHome(userHome?: string): string {
  if (userHome !== undefined) return path.join(userHome, MUONROI_HOME_DIRNAME);
  return process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), MUONROI_HOME_DIRNAME);
}
