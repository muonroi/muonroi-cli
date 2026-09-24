/**
 * A repository whose stacks live in sub-directories must still produce a recipe.
 *
 * Every non-.NET detector used to look at the repository root ONLY, so a
 * monorepo that keeps each stack one directory down came back
 * `ecosystem: "unknown"` / `testCommands: []`, which fails
 * `shouldTrustDeterministicRecipe` (recipes.ts), which makes
 * `Orchestrator.detectVerifyRecipe` return null, which makes circuit-breaker
 * CB-3 (`CB3_verifyBlank`, src/product-loop/circuit-breakers.ts) HALT the
 * `/ideal` run with `no_recipe`.
 *
 * Measured against the real trees on this machine before the fix:
 *
 *   D:/sources/Core/claw-code-parity   -> ecosystem "unknown", TRUSTED false
 *                                         (a real Cargo workspace at `rust/`)
 *   D:/sources/CompanyLibs/qa-platform -> buildCommands [], no install command
 *                                         for `frontend/` (its `package-lock.json`
 *                                         is invisible to a root-only
 *                                         `detectPackageManager`)
 *
 * Fixtures below copy those two shapes into temp dirs. `D:/sources/CompanyLibs`
 * is read-only, so nothing here touches it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVerifyTaskPrompt,
  createVerifyRuntimeConfig,
  inferVerifyProjectProfile,
  shouldTrustDeterministicRecipe,
} from "../entrypoint.js";

const made: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-recipe-"));
  made.push(dir);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf8");
}

afterEach(() => {
  while (made.length) {
    const dir = made.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/** The real qa-platform shape: root `verify` script, Next.js front end, FastAPI back end. */
function qaPlatformShape(): string {
  const dir = tmp();
  write(
    dir,
    "package.json",
    JSON.stringify({
      name: "qa-platform",
      private: true,
      scripts: { verify: "cd frontend && npx tsc --noEmit && npx next build --webpack" },
    }),
  );
  write(
    dir,
    "frontend/package.json",
    JSON.stringify({
      name: "frontend",
      private: true,
      scripts: { dev: "next dev", build: "next build --webpack", start: "next start", lint: "eslint" },
      dependencies: { next: "16.3.4", react: "19.2.8" },
      devDependencies: { typescript: "^5" },
    }),
  );
  write(dir, "frontend/package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
  write(dir, "backend/conftest.py", "import sys\n");
  write(dir, "backend/requirements.txt", "fastapi==0.115.0\nuvicorn==0.30.0\n");
  return dir;
}

describe("polyglot sub-directory detection", () => {
  it("gives the qa-platform shape a TRUSTED recipe with the Python tests and the front-end install", () => {
    const cwd = qaPlatformShape();
    const recipe = inferVerifyProjectProfile(cwd).recipe;

    expect(shouldTrustDeterministicRecipe(recipe)).toBe(true);
    expect(recipe.testCommands.some((c) => /^cd backend && .*-m pytest$/.test(c))).toBe(true);
    expect(recipe.installCommands.some((c) => c === "cd frontend && npm install")).toBe(true);
  });

  it("closes the missing build gate through the front-end package's own build script", () => {
    const cwd = qaPlatformShape();
    const recipe = inferVerifyProjectProfile(cwd).recipe;

    // The ROOT package declares only `verify`, so the root component contributes
    // no build command; `frontend/package.json` declares `build`.
    expect(recipe.buildCommands).toContain("cd frontend && npm run build");
  });

  it("installs the sub-project's own Python dependencies, and no root-level ones it does not have", () => {
    const cwd = qaPlatformShape();
    const recipe = inferVerifyProjectProfile(cwd).recipe;

    expect(recipe.installCommands.some((c) => c.startsWith("cd backend &&") && c.includes("requirements.txt"))).toBe(
      true,
    );
    // There is no requirements.txt at the root — a root-relative install would
    // fail the moment the floor ran it.
    expect(recipe.installCommands).not.toContain("pip install -r requirements.txt");
  });

  it("reports every component's ecosystem, not just the primary label", () => {
    const cwd = qaPlatformShape();
    expect(inferVerifyProjectProfile(cwd).componentEcosystems).toEqual(["node", "python"]);
    // And says so to the verify sub-agent, which is otherwise told only "node".
    expect(buildVerifyTaskPrompt(cwd)).toContain("This repository has more than one stack: node, python.");
  });

  it("provisions BOTH toolchains in the sandbox, not just the primary stack's", () => {
    const cwd = qaPlatformShape();
    const bootstrap = createVerifyRuntimeConfig(cwd).profile.recipe.bootstrapCommands;

    // The Python half's own install command is `… -m pip install …`, which needs
    // pip present; the node apt line installs `python3` but not `python3-pip`.
    expect(bootstrap.some((c) => c.includes("nodejs") && c.includes("npm"))).toBe(true);
    expect(bootstrap.some((c) => c.includes("python3-pip") && c.includes("python3-venv"))).toBe(true);
  });

  it("resolves the package manager from the lockfile beside the package, not only at the root", () => {
    const cwd = tmp();
    write(cwd, "package.json", JSON.stringify({ name: "root", scripts: { verify: "true" } }));
    write(
      cwd,
      "frontend/package.json",
      JSON.stringify({ name: "fe", scripts: { build: "vite build", test: "vitest" } }),
    );
    write(cwd, "frontend/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.installCommands).toContain("cd frontend && pnpm install");
    expect(recipe.testCommands).toContain("cd frontend && pnpm test");
  });

  it("finds a Cargo workspace that lives one directory down (the claw-code-parity shape)", () => {
    const cwd = tmp();
    write(cwd, "README.md", "# parity\n");
    write(cwd, "rust/Cargo.toml", '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n');
    write(cwd, "rust/crates/core/Cargo.toml", '[package]\nname = "core"\n');

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.ecosystem).toBe("rust");
    expect(recipe.testCommands).toEqual(["cd rust && cargo test"]);
    expect(recipe.buildCommands).toEqual(["cd rust && cargo build"]);
    expect(shouldTrustDeterministicRecipe(recipe)).toBe(true);
  });

  it("provisions a toolchain for a stack that has no install step of its own", () => {
    // Cargo fetches dependencies as part of `cargo build`, so `detectRustRecipe`
    // emits no install command — and `ensureBootstrapCommands` used to bail on
    // `installCommands.length === 0`, so the sandbox never got rustup and
    // `cargo build` could not run. Reachable for any Rust repo, root or nested.
    const cwd = tmp();
    write(cwd, "rust/Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');

    const bootstrap = createVerifyRuntimeConfig(cwd).profile.recipe.bootstrapCommands;
    expect(bootstrap.some((c) => c.includes("sh.rustup.rs"))).toBe(true);
  });

  it("does not emit a second cargo command for a workspace member", () => {
    const cwd = tmp();
    write(cwd, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
    write(cwd, "crates/a/Cargo.toml", '[package]\nname = "a"\n');
    write(cwd, "crates/b/Cargo.toml", '[package]\nname = "b"\n');

    expect(inferVerifyProjectProfile(cwd).recipe.testCommands).toEqual(["cargo test"]);
  });

  it("keeps a workspace root as ONE Node component instead of one per member", () => {
    const cwd = tmp();
    write(
      cwd,
      "package.json",
      JSON.stringify({ name: "mono", workspaces: ["packages/*"], scripts: { build: "tsc", test: "vitest run" } }),
    );
    write(cwd, "packages/a/package.json", JSON.stringify({ name: "a", scripts: { test: "vitest run" } }));
    write(cwd, "packages/b/package.json", JSON.stringify({ name: "b", scripts: { test: "vitest run" } }));

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.testCommands).toEqual(["npm run test"]);
    expect(recipe.buildCommands).toEqual(["npm run build"]);
  });
});

describe("no widening of the trust boundary", () => {
  it("still returns an untrusted recipe for a tree with nothing to characterise — CB-3 halt stays honest", () => {
    const cwd = tmp();
    write(cwd, "README.md", "# notes\n");
    write(cwd, "docs/design.md", "prose\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.ecosystem).toBe("unknown");
    expect(recipe.appKind).toBe("unknown");
    expect(recipe.testCommands).toEqual([]);
    expect(shouldTrustDeterministicRecipe(recipe)).toBe(false);
  });

  it("still returns untrusted when a sub-project is found but has no tests at all", () => {
    const cwd = tmp();
    write(cwd, "package.json", JSON.stringify({ name: "root", scripts: { verify: "true" } }));
    write(cwd, "frontend/package.json", JSON.stringify({ name: "fe", scripts: { build: "next build" } }));

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.appKind).not.toBe("unknown");
    expect(recipe.testCommands).toEqual([]);
    expect(shouldTrustDeterministicRecipe(recipe)).toBe(false);
  });
});

describe("single-stack repositories at the root are byte-identical", () => {
  it("root-only Node repo", () => {
    const cwd = tmp();
    write(
      cwd,
      "package.json",
      JSON.stringify({
        name: "app",
        scripts: { build: "tsc -p .", test: "vitest run", lint: "eslint .", start: "node dist/index.js" },
        dependencies: {},
      }),
    );
    write(cwd, "package-lock.json", JSON.stringify({ lockfileVersion: 3 }));

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.ecosystem).toBe("node");
    expect(recipe.appKind).toBe("node");
    expect(recipe.installCommands).toEqual(["npm install"]);
    expect(recipe.buildCommands).toEqual(["npm run build"]);
    expect(recipe.testCommands).toEqual(["npm run test", "npm run lint"]);
    expect(recipe.startCommand).toBe("npm run start");
    expect(recipe.evidence).toEqual(["Detected package.json", "Scripts: build, test, lint, start"]);
  });

  it("root-only .NET repo", () => {
    const cwd = tmp();
    write(cwd, "App.sln", "Microsoft Visual Studio Solution File\n");
    write(cwd, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.ecosystem).toBe("dotnet");
    expect(recipe.appKind).toBe("dotnet");
    expect(recipe.installCommands).toEqual(['dotnet restore "App.sln"']);
    expect(recipe.buildCommands).toEqual(['dotnet build "App.sln" --no-restore']);
    expect(recipe.testCommands).toEqual(['dotnet test "App.sln" --no-build --nologo']);
  });

  it("root-only Makefile repo keeps its last-resort position", () => {
    const cwd = tmp();
    write(cwd, "Makefile", "build:\n\tcc main.c\n\ntest:\n\t./a.out\n");

    const recipe = inferVerifyProjectProfile(cwd).recipe;
    expect(recipe.ecosystem).toBe("make");
    expect(recipe.testCommands).toEqual(["make test"]);
  });

  it("a Makefile does NOT become a component of a Node repo", () => {
    const cwd = tmp();
    write(cwd, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
    write(cwd, "Makefile", "test:\n\techo nope\n");

    expect(inferVerifyProjectProfile(cwd).recipe.testCommands).toEqual(["npm run test"]);
  });
});
