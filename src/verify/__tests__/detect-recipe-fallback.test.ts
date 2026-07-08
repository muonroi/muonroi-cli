import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CB3_verifyBlank } from "../../product-loop/circuit-breakers.js";
import type { VerifyRecipe } from "../../types/index.js";
import { inferVerifyProjectProfile, shouldTrustDeterministicRecipe } from "../entrypoint.js";

/**
 * Gate-seam test for the deterministic verify-recipe fallback wired into
 * Orchestrator.detectVerifyRecipe. When the LLM verify-detect turn returns no
 * usable recipe, the orchestrator falls back to inferVerifyProjectProfile(cwd)
 * and trusts it via shouldTrustDeterministicRecipe(). That exact predicate
 * decides whether CB-3 false-halts an in-place /ideal migration ("Recovery
 * options" card) on an existing repo.
 *
 * These tests exercise the REAL predicate (not a copy) AND compose it with the
 * REAL CB3_verifyBlank so the whole slow-gate decision — the one the live
 * /ideal run used to be the only way to observe — is pinned here at unit speed.
 * `resolveFallbackRecipe` mirrors detectVerifyRecipe's fallback branch exactly:
 * profile → trust predicate → recipe-or-null, so a drift in either half breaks
 * a fast test instead of a 30-minute real run.
 */
async function mktmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `recipe-fallback-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * The deterministic half of Orchestrator.detectVerifyRecipe (LLM returned
 * null): infer the profile, return the recipe only when the trust predicate
 * accepts it, else null — verbatim the production branch.
 */
function resolveFallbackRecipe(cwd: string): VerifyRecipe | null {
  const profile = inferVerifyProjectProfile(cwd);
  return shouldTrustDeterministicRecipe(profile.recipe) ? profile.recipe : null;
}

describe("deterministic verify-recipe fallback (CB-3 existing-repo rescue)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rescues a node repo with a test script → recipe trusted, CB-3 does NOT halt on sprint 1", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "vitest run" }, devDependencies: { vitest: "^4" } }),
      "utf8",
    );
    const recipe = resolveFallbackRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe?.appKind).not.toBe("unknown");
    expect(recipe?.testCommands.length).toBeGreaterThan(0);
    // coverage must not be an explicit 0 — that would trip CB-3 zero_coverage.
    expect(recipe?.coverage ?? undefined).not.toBe(0);
    // The whole gate seam: a rescued recipe means sprint 1 proceeds.
    expect(CB3_verifyBlank(1, recipe).halt).toBe(false);
  });

  it("rescues a .NET repo with a solution → dotnet test recipe, CB-3 does NOT halt", async () => {
    await fs.writeFile(path.join(dir, "App.sln"), "Microsoft Visual Studio Solution File\n", "utf8");
    const recipe = resolveFallbackRecipe(dir);
    expect(recipe).not.toBeNull();
    expect(recipe?.appKind).not.toBe("unknown");
    expect(recipe?.testCommands.join(" ")).toContain("dotnet test");
    expect(CB3_verifyBlank(1, recipe).halt).toBe(false);
  });

  it("does NOT rescue a genuinely blank cwd → null recipe, CB-3 correctly halts greenfield (no_recipe)", async () => {
    const recipe = resolveFallbackRecipe(dir);
    expect(recipe).toBeNull();
    const cb = CB3_verifyBlank(1, recipe);
    expect(cb.halt).toBe(true);
    expect(cb.reason).toBe("no_recipe");
  });

  it("does NOT rescue a node repo with NO test/check/lint script → null, CB-3 halts (no_recipe)", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
      "utf8",
    );
    const recipe = resolveFallbackRecipe(dir);
    // A node manifest with no test-ish scripts yields no test commands, so the
    // fallback declines and CB-3 still surfaces the recovery card — correct, we
    // have nothing deterministic to verify against.
    expect(recipe).toBeNull();
    expect(CB3_verifyBlank(1, recipe).halt).toBe(true);
  });
});

describe("shouldTrustDeterministicRecipe — boundary predicate (unit)", () => {
  it("trusts only when appKind is known AND at least one test command exists", () => {
    expect(shouldTrustDeterministicRecipe({ appKind: "node", testCommands: ["npm run test"] })).toBe(true);
    expect(shouldTrustDeterministicRecipe({ appKind: "dotnet", testCommands: ["dotnet test"] })).toBe(true);
  });

  it("declines an unknown ecosystem even with test commands", () => {
    expect(shouldTrustDeterministicRecipe({ appKind: "unknown", testCommands: ["npm run test"] })).toBe(false);
  });

  it("declines a known ecosystem with no test commands", () => {
    expect(shouldTrustDeterministicRecipe({ appKind: "node", testCommands: [] })).toBe(false);
  });
});
