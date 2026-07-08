import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inferVerifyProjectProfile } from "../entrypoint.js";

/**
 * Contract test for the deterministic verify-recipe fallback wired into
 * Orchestrator.detectVerifyRecipe. When the LLM verify-detect turn returns no
 * usable recipe, the orchestrator falls back to inferVerifyProjectProfile(cwd)
 * and trusts it ONLY when `appKind !== "unknown" && testCommands.length > 0`.
 * That exact boundary decides whether CB-3 false-halts an in-place /ideal
 * migration ("Recovery options" card) on an existing repo. These tests pin the
 * boundary so the fallback keeps rescuing real repos and keeps halting on a
 * genuinely blank cwd.
 */
async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `recipe-fallback-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function fallbackWouldRescue(recipe: { appKind: string; testCommands: string[] }): boolean {
  return recipe.appKind !== "unknown" && recipe.testCommands.length > 0;
}

describe("deterministic verify-recipe fallback (CB-3 existing-repo rescue)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rescues a node repo with a test script (fallback returns a usable recipe → CB-3 does not halt)", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }),
      "utf8",
    );
    const profile = inferVerifyProjectProfile(dir);
    expect(profile.recipe.appKind).not.toBe("unknown");
    expect(profile.recipe.testCommands.length).toBeGreaterThan(0);
    expect(fallbackWouldRescue(profile.recipe)).toBe(true);
    // coverage must not be an explicit 0 — that would trip CB-3 zero_coverage.
    expect(profile.recipe.coverage ?? undefined).not.toBe(0);
  });

  it("rescues a .NET repo with a solution (dotnet test recipe)", async () => {
    await fs.writeFile(path.join(dir, "App.sln"), "Microsoft Visual Studio Solution File\n", "utf8");
    const profile = inferVerifyProjectProfile(dir);
    expect(profile.recipe.appKind).not.toBe("unknown");
    expect(profile.recipe.testCommands.join(" ")).toContain("dotnet test");
    expect(fallbackWouldRescue(profile.recipe)).toBe(true);
  });

  it("does NOT rescue a genuinely blank cwd (fallback stays null → CB-3 correctly halts greenfield)", async () => {
    const profile = inferVerifyProjectProfile(dir);
    expect(profile.recipe.appKind).toBe("unknown");
    expect(fallbackWouldRescue(profile.recipe)).toBe(false);
  });

  it("does NOT rescue a node repo that has NO test/check/lint script", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
      "utf8",
    );
    const profile = inferVerifyProjectProfile(dir);
    // A node manifest with no test-ish scripts yields no test commands, so the
    // fallback declines and CB-3 still surfaces the recovery card — correct, we
    // have nothing deterministic to verify against.
    expect(fallbackWouldRescue(profile.recipe)).toBe(false);
  });
});
