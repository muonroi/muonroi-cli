/**
 * Guard: the muonroi home (`~/.muonroi-cli`) has exactly one resolver,
 * `muonroiHome()` in `src/utils/muonroi-home.ts`.
 *
 * WHY: a store that joins `os.homedir()` + ".muonroi-cli" itself is invisible to
 * the suite-wide `MUONROI_CLI_HOME` pin (`src/__test-stubs__/vitest-setup.ts`).
 * Measured 2026-11-09: unit tests wrote 99 entries into the developer's REAL
 * `~/.muonroi-cli/ee-offline-queue` (`src/ee/offline-queue.ts` ignored the env
 * var), one test's `drainQueue` replayed another test's entries into its stub
 * (`pipeline.integration.test.ts` flake), and other tests read the real
 * `user-settings.json`. This test fails if any non-test source file builds that
 * path from the OS home directly again.
 *
 * Project-local `.muonroi-cli/` directories (`<cwd>/.muonroi-cli/settings.json`)
 * are NOT the muonroi home and never involve `homedir()`, so they are unaffected.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../..");
const HELPER = path.join(SRC_ROOT, "utils", "muonroi-home.ts");

/** Drop comments so prose such as "~/.muonroi-cli/debug.log" never matches. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * `homedir()` followed (within one statement) by the ".muonroi-cli" literal,
 * in either argument order.
 */
const DIRECT_HOME_JOIN =
  /homedir\s*\(\s*\)[^;]{0,200}?["'`]\.muonroi-cli["'`/]|["'`]\.muonroi-cli["'`/][^;]{0,200}?homedir\s*\(\s*\)/;

function findDirectHomeJoin(text: string): boolean {
  return DIRECT_HOME_JOIN.test(stripComments(text));
}

function isTestFile(rel: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/.test(rel) ||
    rel.split(path.sep).includes("__tests__") ||
    rel.split(path.sep).includes("__test-stubs__")
  );
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe("muonroi home single root", () => {
  it("the scanner recognises every shape that bypassed MUONROI_CLI_HOME", () => {
    expect(findDirectHomeJoin('path.join(os.homedir(), ".muonroi-cli", "crash.log")')).toBe(true);
    expect(findDirectHomeJoin('join(homedir(), ".muonroi-cli", ".env")')).toBe(true);
    expect(findDirectHomeJoin('path.join(\n  os.homedir(),\n  ".muonroi-cli",\n  "x")')).toBe(true);
    expect(findDirectHomeJoin('path.join(homeOverride ?? os.homedir(), ".muonroi-cli", Q)')).toBe(true);
    // not flagged: project-local dir, prose, and the sanctioned helper call
    expect(findDirectHomeJoin('path.join(cwd, ".muonroi-cli", "settings.json")')).toBe(false);
    expect(findDirectHomeJoin("// ~/.muonroi-cli/debug.log written via os.homedir()")).toBe(false);
    expect(findDirectHomeJoin('path.join(muonroiHome(), "user-settings.json")')).toBe(false);
  });

  it("no non-test source file builds homedir() + .muonroi-cli outside muonroi-home.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file === HELPER) continue;
      const rel = path.relative(SRC_ROOT, file);
      if (isTestFile(rel)) continue;
      if (findDirectHomeJoin(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(
      offenders,
      `these files build the muonroi home from os.homedir() themselves and so ignore MUONROI_CLI_HOME; ` +
        `use muonroiHome() from src/utils/muonroi-home.ts: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("muonroiHome() honours MUONROI_CLI_HOME lazily and an explicit user home wins", async () => {
    const { muonroiHome } = await import("../muonroi-home.js");
    const prev = process.env.MUONROI_CLI_HOME;
    try {
      process.env.MUONROI_CLI_HOME = path.join(path.sep, "tmp", "a");
      expect(muonroiHome()).toBe(path.join(path.sep, "tmp", "a"));
      process.env.MUONROI_CLI_HOME = path.join(path.sep, "tmp", "b");
      expect(muonroiHome()).toBe(path.join(path.sep, "tmp", "b"));
      expect(muonroiHome(path.join(path.sep, "u"))).toBe(path.join(path.sep, "u", ".muonroi-cli"));
      delete process.env.MUONROI_CLI_HOME;
      expect(muonroiHome()).toMatch(/[\\/]\.muonroi-cli$/);
    } finally {
      if (prev === undefined) delete process.env.MUONROI_CLI_HOME;
      else process.env.MUONROI_CLI_HOME = prev;
    }
  });
});
