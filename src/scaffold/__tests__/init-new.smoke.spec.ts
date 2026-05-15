/**
 * Smoke test for initNewProject — real filesystem + real exec.
 *
 * Gated behind env var MUONROI_SMOKE_INIT_NEW=1 because:
 *   - Runs `git init --bare` + `git clone` in a tmp dir (slow, ~2-5s)
 *   - Writes real files to OS temp directory
 *   - On CI, named pipes or sandbox restrictions may prevent git operations
 *
 * Run locally with:
 *   MUONROI_SMOKE_INIT_NEW=1 bunx vitest run src/scaffold/__tests__/init-new.smoke.spec.ts
 */

import { exec as nodeExec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initNewProject } from "../init-new.js";

const execAsync = promisify(nodeExec);

const SMOKE_ENABLED = process.env.MUONROI_SMOKE_INIT_NEW === "1";

describe.skipIf(!SMOKE_ENABLED)("initNewProject smoke — real filesystem", () => {
  let tmpDir: string;
  let bareRepoPath: string;

  beforeAll(async () => {
    // Create a temp workspace.
    tmpDir = await mkdtemp(path.join(tmpdir(), "muonroi-smoke-"));

    // Create a minimal bare git repo to act as the BE source.
    bareRepoPath = path.join(tmpDir, "fake-building-block.git");
    await execAsync(`git init --bare ${JSON.stringify(bareRepoPath)}`);
  }, 30_000);

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("scaffolds a react project with expected file structure", async () => {
    const projectsRoot = path.join(tmpDir, "projects");

    const result = await initNewProject({
      projectName: "smoke-app",
      beSource: bareRepoPath,
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

    // Server directory created by git clone.
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

  it("scaffolds an angular project with expected file structure", async () => {
    const projectsRoot = path.join(tmpDir, "projects-ng");

    const result = await initNewProject({
      projectName: "smoke-ng",
      beSource: bareRepoPath,
      feStack: "angular",
      projectsRoot,
    });

    expect(existsSync(result.projectDir)).toBe(true);
    expect(existsSync(path.join(result.projectDir, "client", "src", "app", "app.component.ts"))).toBe(true);

    const component = await readFile(
      path.join(result.projectDir, "client", "src", "app", "app.component.ts"),
      "utf-8",
    );
    expect(component).toContain("muonroiSemantic");
  }, 30_000);

  it("feStack=none produces no client directory", async () => {
    const projectsRoot = path.join(tmpDir, "projects-none");

    const result = await initNewProject({
      projectName: "smoke-be",
      beSource: bareRepoPath,
      feStack: "none",
      projectsRoot,
    });

    expect(existsSync(result.projectDir)).toBe(true);
    expect(existsSync(path.join(result.projectDir, "client"))).toBe(false);
  }, 30_000);
});
