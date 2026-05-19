/**
 * Smoke test for initNewProject — real filesystem.
 *
 * Plan 23-01b retired the git-clone fallback: BE scaffold now requires a
 * `bbTemplate` and a working `dotnet` SDK + NuGet feed. The legacy bare-repo
 * smoke variants were removed; we now exercise FE-only scaffolds (no
 * bbTemplate) so the test stays portable across machines without .NET SDK.
 *
 * Gated behind env var MUONROI_SMOKE_INIT_NEW=1 because it writes real files
 * to the OS temp directory.
 *
 * Run locally with:
 *   MUONROI_SMOKE_INIT_NEW=1 bunx vitest run src/scaffold/__tests__/init-new.smoke.spec.ts
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initNewProject } from "../init-new.js";

const SMOKE_ENABLED = process.env.MUONROI_SMOKE_INIT_NEW === "1";

describe.skipIf(!SMOKE_ENABLED)("initNewProject smoke — real filesystem", () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Create a temp workspace.
    tmpDir = await mkdtemp(path.join(tmpdir(), "muonroi-smoke-"));
  }, 30_000);

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("scaffolds a react project with expected file structure (FE-only)", async () => {
    const projectsRoot = path.join(tmpDir, "projects");

    const result = await initNewProject({
      projectName: "smoke-app",
      feStack: "react",
      projectsRoot,
    });

    // Project dir exists.
    expect(existsSync(result.projectDir)).toBe(true);

    // Root package.json present and valid JSON with workspaces.
    const pkgJson = JSON.parse(await readFile(path.join(result.projectDir, "package.json"), "utf-8"));
    expect(pkgJson.name).toBe("smoke-app");
    expect(pkgJson.workspaces).toContain("client");
    expect(pkgJson.workspaces).toContain("server");

    // Server directory created (empty placeholder when no bbTemplate).
    expect(existsSync(path.join(result.projectDir, "server"))).toBe(true);

    // Client files exist.
    expect(existsSync(path.join(result.projectDir, "client", "src", "main.tsx"))).toBe(true);
    expect(existsSync(path.join(result.projectDir, "client", "package.json"))).toBe(true);
    expect(existsSync(path.join(result.projectDir, "client", "vite.config.ts"))).toBe(true);

    // main.tsx wires SemanticProvider.
    const mainTsx = await readFile(path.join(result.projectDir, "client", "src", "main.tsx"), "utf-8");
    expect(mainTsx).toContain("SemanticProvider");
    expect(mainTsx).toContain("@muonroi/agent-harness-react");
  }, 30_000);

  it("scaffolds an angular project with expected file structure (FE-only)", async () => {
    const projectsRoot = path.join(tmpDir, "projects-ng");

    const result = await initNewProject({
      projectName: "smoke-ng",
      feStack: "angular",
      projectsRoot,
    });

    expect(existsSync(result.projectDir)).toBe(true);
    expect(existsSync(path.join(result.projectDir, "client", "src", "app", "app.component.ts"))).toBe(true);

    const component = await readFile(path.join(result.projectDir, "client", "src", "app", "app.component.ts"), "utf-8");
    expect(component).toContain("muonroiSemantic");
  }, 30_000);

  it("feStack=none produces no client directory", async () => {
    const projectsRoot = path.join(tmpDir, "projects-none");

    const result = await initNewProject({
      projectName: "smoke-be",
      feStack: "none",
      projectsRoot,
    });

    expect(existsSync(result.projectDir)).toBe(true);
    expect(existsSync(path.join(result.projectDir, "client"))).toBe(false);
  }, 30_000);
});
