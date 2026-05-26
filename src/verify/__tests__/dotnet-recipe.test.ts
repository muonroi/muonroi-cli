/**
 * Tests for the .NET recipe detector.
 *
 * Why this exists: before this detector existed, `inferFallbackRecipe()` had
 * no awareness of .csproj/.sln/Directory.Build.props markers, so a scaffolded
 * .NET project (Muonroi.BaseTemplate, etc.) would fall through to the generic
 * "unknown" recipe with `coverage: null` — tripping CB-3 (`no_recipe`) and
 * halting the sprint with `reason=no_recipe`. The detector fixes that.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferVerifyProjectProfile } from "../recipes.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe(".NET recipe detection", () => {
  it("detects a root-level .sln solution and emits dotnet restore/build/test", () => {
    const cwd = makeTempDir("muonroi-dotnet-sln-");
    fs.writeFileSync(path.join(cwd, "MyApp.sln"), "Microsoft Visual Studio Solution File, Format Version 12.00\n");

    const profile = inferVerifyProjectProfile(cwd);

    expect(profile.recipe.ecosystem).toBe("dotnet");
    expect(profile.recipe.appKind).toBe("dotnet");
    expect(profile.recipe.appLabel).toBe(".NET project");
    expect(profile.recipe.installCommands).toEqual(['dotnet restore "MyApp.sln"']);
    expect(profile.recipe.buildCommands).toEqual(['dotnet build "MyApp.sln" --no-restore']);
    expect(profile.recipe.testCommands).toEqual(['dotnet test "MyApp.sln" --no-build --nologo']);
    expect(profile.recipe.evidence.some((line) => line.includes("MyApp.sln"))).toBe(true);
  });

  it("detects a single .csproj when no .sln is present", () => {
    const cwd = makeTempDir("muonroi-dotnet-csproj-");
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "Worker.csproj"), '<Project Sdk="Microsoft.NET.Sdk"/>\n');

    const profile = inferVerifyProjectProfile(cwd);

    expect(profile.recipe.ecosystem).toBe("dotnet");
    expect(profile.recipe.installCommands[0]).toContain("dotnet restore");
    expect(profile.recipe.installCommands[0]).toContain("Worker.csproj");
  });

  it("labels the project as Muonroi BB when Directory.Build.props is present", () => {
    const cwd = makeTempDir("muonroi-dotnet-bb-");
    fs.writeFileSync(path.join(cwd, "Muonroi.App.sln"), "Microsoft Visual Studio Solution File\n");
    fs.writeFileSync(path.join(cwd, "Directory.Build.props"), "<Project/>\n");

    const profile = inferVerifyProjectProfile(cwd);

    expect(profile.recipe.appLabel).toBe(".NET (Muonroi BB)");
    expect(profile.recipe.evidence.some((line) => line.includes("Directory.Build.props"))).toBe(true);
    expect(profile.recipe.notes.some((line) => line.toLowerCase().includes("modular-boundaries"))).toBe(true);
  });

  it("falls through to unknown when no .NET markers exist (regression guard)", () => {
    const cwd = makeTempDir("muonroi-dotnet-empty-");

    const profile = inferVerifyProjectProfile(cwd);

    expect(profile.recipe.ecosystem).toBe("unknown");
  });

  it("prefers package.json (Node) over .NET when both exist (priority order preserved)", () => {
    const cwd = makeTempDir("muonroi-dotnet-mixed-");
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "jest" } }));
    fs.writeFileSync(path.join(cwd, "MyApp.sln"), "Solution\n");

    const profile = inferVerifyProjectProfile(cwd);

    expect(profile.recipe.ecosystem).toBe("node");
  });
});
