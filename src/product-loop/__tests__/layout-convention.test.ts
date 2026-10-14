// src/product-loop/__tests__/layout-convention.test.ts
/**
 * F4b — the planner must be told WHERE new code belongs.
 *
 * Regression origin: run `mu229bfiaeec` on D:\sources\CompanyLibs\tcis-libraries
 * wrote nine `.cs` files into `src/analyzers/TCIS.CodeStandards/`, a directory
 * `src/TCISLibraries.sln` does not reference. Nothing compiled, no test ran, the
 * engineering floor failed on `zero_coverage`, ~50 minutes produced work that
 * could not be built; sprint 2 repeated it and the phase exited 0/17.
 *
 * That repo holds 50 projects at `src/src/<Name>/<Name>.csproj` and 48 test
 * projects at `src/tests/<Name>.Tests/` — 98 examples of its own convention in
 * plain sight. F4a (`b087f4af`) made the audit COUNT those files; counting them
 * is not the same as telling the planner where new code goes. This slice states
 * the observed convention, with the counts as the evidence that makes it
 * falsifiable: "projects live in src/src/" is an assertion a model can talk
 * itself out of, "50 of them do" is evidence it has to argue with.
 *
 * Two properties matter more than coverage and are pinned below:
 *   - REPORT ONLY. No enforcement, no rewriting, no failure path.
 *   - Absence of a convention is never reported as one. A flat repo, a new
 *     repo, or a repo with no dominant layout must produce NO block — not a
 *     block full of ones and zeros, and not a guess.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_CONVENTION_EXAMPLES, MIN_DOMINANCE_RATIO } from "../layout-convention.js";
import { auditAsContextBlock, auditRepo } from "../repo-audit.js";

let cwd = "";

async function makeFixture(layout: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "layout-"));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }
  return root;
}

const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>';

/** One .NET project directory: a manifest plus a source file so it is real. */
function project(rel: string, name: string): Record<string, string> {
  return {
    [`${rel}/${name}.csproj`]: CSPROJ,
    [`${rel}/${name}Service.cs`]: `namespace ${name}; public class S {}`,
  };
}

/** One .NET test project directory, named by the `<Name>.Tests` convention. */
function testProject(rel: string, name: string): Record<string, string> {
  return {
    [`${rel}/${name}.Tests.csproj`]: CSPROJ,
    [`${rel}/${name}Tests.cs`]: `namespace ${name}.Tests; public class T {}`,
  };
}

afterEach(async () => {
  if (cwd) await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  cwd = "";
});

describe("F4b: a repo with a layout convention states it, with counts", () => {
  it("names the projects dir, the tests dir and the solution for a tcis-shaped repo", async () => {
    const layout: Record<string, string> = {
      "src/TCISLibraries.sln": "Microsoft Visual Studio Solution File\n",
    };
    for (let i = 0; i < 5; i++) {
      Object.assign(layout, project(`src/src/TCIS.Mod${i}`, `TCIS.Mod${i}`));
      Object.assign(layout, testProject(`src/tests/TCIS.Mod${i}.Tests`, `TCIS.Mod${i}`));
    }
    cwd = await makeFixture(layout);

    const block = auditAsContextBlock(await auditRepo(cwd));

    expect(block).toMatch(/Layout convention \(observed, 10 examples\)/);
    // The directory, the shape, and the count that makes it falsifiable.
    expect(block).toMatch(/projects\s+src\/src\/<Name>\/<Name>\.csproj\s+\(5 found\)/);
    expect(block).toMatch(/tests\s+src\/tests\/<Name>\.Tests\/\s+\(5 found\)/);
    expect(block).toMatch(/solution\s+src\/TCISLibraries\.sln .*MUST be registered/);
  });

  it("reports the pairing convention it actually observed, not an assumed one", async () => {
    // Directories are `src/projects` / `src/verification` and the suffix is
    // `.Spec`, not `src/tests` / `.Tests` — a derived convention must follow
    // the repo, not a shape someone wrote down.
    const layout: Record<string, string> = {};
    for (let i = 0; i < 4; i++) {
      Object.assign(layout, project(`src/projects/Svc${i}`, `Svc${i}`));
      Object.assign(layout, testProject(`src/verification/Svc${i}.Spec`, `Svc${i}`));
    }
    cwd = await makeFixture(layout);

    const block = auditAsContextBlock(await auditRepo(cwd));
    expect(block).toContain("projects   src/projects/<Name>/<Name>.csproj");
    expect(block).toContain("tests      src/verification/<Name>.Spec/");
  });

  it("omits the solution line when the repo has no solution file to register into", async () => {
    const layout: Record<string, string> = {};
    for (let i = 0; i < 4; i++) Object.assign(layout, project(`packages/pkg${i}`, `pkg${i}`));
    cwd = await makeFixture(layout);

    const block = auditAsContextBlock(await auditRepo(cwd));
    expect(block).toContain("Layout convention");
    expect(block).not.toMatch(/solution/i);
    expect(block).not.toMatch(/MUST be registered/);
  });
});

describe("F4b: absence of a convention is never reported as one", () => {
  it("emits no block for a flat repo — every source in one directory, no test tree", async () => {
    const layout: Record<string, string> = { "package.json": '{"name":"flat"}' };
    for (let i = 0; i < 12; i++) layout[`src/mod${i}.ts`] = `export const m${i} = ${i};`;
    cwd = await makeFixture(layout);

    const block = auditAsContextBlock(await auditRepo(cwd));
    expect(block).not.toMatch(/Layout convention/);
    // Specifically: not a degenerate block asserting a one-example rule.
    expect(block).not.toMatch(/\(1 found\)/);
  });

  it("emits no block for a brand-new repo with nothing in it", async () => {
    cwd = await makeFixture({ "README.md": "# new\n\nnothing here yet.\n" });

    const block = auditAsContextBlock(await auditRepo(cwd));
    expect(block).not.toMatch(/Layout convention/);
  });

  it("emits no block when projects are scattered with no dominant home", async () => {
    // Three containers, three projects each: naming one would be a guess.
    const layout: Record<string, string> = {};
    for (const dir of ["alpha", "beta", "gamma"]) {
      for (let i = 0; i < 3; i++) Object.assign(layout, project(`src/${dir}/P${dir}${i}`, `P${dir}${i}`));
    }
    cwd = await makeFixture(layout);

    const block = auditAsContextBlock(await auditRepo(cwd));
    expect(block).not.toMatch(/Layout convention/);
  });
});

describe("F4b: the chosen threshold is pinned, not incidental", () => {
  it("MIN_CONVENTION_EXAMPLES projects in one dir is a convention; one fewer is not", async () => {
    const atThreshold: Record<string, string> = {};
    for (let i = 0; i < MIN_CONVENTION_EXAMPLES; i++) {
      Object.assign(atThreshold, project(`src/libs/At${i}`, `At${i}`));
    }
    cwd = await makeFixture(atThreshold);
    expect(auditAsContextBlock(await auditRepo(cwd))).toMatch(
      new RegExp(`projects\\s+src/libs/<Name>/<Name>\\.csproj\\s+\\(${MIN_CONVENTION_EXAMPLES} found\\)`),
    );
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    const belowThreshold: Record<string, string> = {};
    for (let i = 0; i < MIN_CONVENTION_EXAMPLES - 1; i++) {
      Object.assign(belowThreshold, project(`src/libs/Below${i}`, `Below${i}`));
    }
    cwd = await makeFixture(belowThreshold);
    expect(auditAsContextBlock(await auditRepo(cwd))).not.toMatch(/Layout convention/);
  });

  it("a winner at MIN_DOMINANCE_RATIO× the runner-up dominates; below it, nothing is claimed", async () => {
    const runnerUp = MIN_CONVENTION_EXAMPLES;

    // Exactly at the ratio → a convention.
    const dominant: Record<string, string> = {};
    for (let i = 0; i < runnerUp * MIN_DOMINANCE_RATIO; i++) {
      Object.assign(dominant, project(`src/main/D${i}`, `D${i}`));
    }
    for (let i = 0; i < runnerUp; i++) Object.assign(dominant, project(`src/extra/E${i}`, `E${i}`));
    cwd = await makeFixture(dominant);
    expect(auditAsContextBlock(await auditRepo(cwd))).toMatch(
      new RegExp(`projects\\s+src/main/<Name>/<Name>\\.csproj\\s+\\(${runnerUp * MIN_DOMINANCE_RATIO} found\\)`),
    );
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

    // One project short of the ratio → no claim.
    const tied: Record<string, string> = {};
    for (let i = 0; i < runnerUp * MIN_DOMINANCE_RATIO - 1; i++) {
      Object.assign(tied, project(`src/main/T${i}`, `T${i}`));
    }
    for (let i = 0; i < runnerUp; i++) Object.assign(tied, project(`src/extra/U${i}`, `U${i}`));
    cwd = await makeFixture(tied);
    expect(auditAsContextBlock(await auditRepo(cwd))).not.toMatch(/Layout convention/);
  });
});

describe("F4b: report only", () => {
  it("never throws and never mutates the repo, even on a pathological layout", async () => {
    const layout: Record<string, string> = {
      "weird.csproj": CSPROJ,
      "a/b/c/d/e/f/g/h/deep.csproj": CSPROJ,
      "src/x.cs": "public class X {}",
    };
    cwd = await makeFixture(layout);
    const before = (await fs.readdir(cwd)).sort();

    const audit = await auditRepo(cwd);
    expect(() => auditAsContextBlock(audit)).not.toThrow();

    expect((await fs.readdir(cwd)).sort()).toEqual(before);
  });

  it("leaves the pre-existing audit lines intact — the block is additive", async () => {
    const layout: Record<string, string> = { "README.md": "# Lib\n\nShared libraries.\n" };
    for (let i = 0; i < 4; i++) {
      Object.assign(layout, project(`src/src/Mod${i}`, `Mod${i}`));
      Object.assign(layout, testProject(`src/tests/Mod${i}.Tests`, `Mod${i}`));
    }
    cwd = await makeFixture(layout);

    const block = auditAsContextBlock(await auditRepo(cwd));
    expect(block).toContain("## Repository audit");
    expect(block).toMatch(/Source files: \d+, test files: \d+/);
    expect(block).toContain("Layout convention");
  });
});
