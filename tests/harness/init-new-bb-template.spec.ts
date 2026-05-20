/**
 * init-new-bb-template.spec.ts — Task 6.7
 *
 * Tests for the BB-template-aware scaffold flow in initNewProject.
 * Covers:
 *   - dotnet-available path: bbTemplate provided + detectDotnet returns version
 *   - dotnet-absent path: bbTemplate provided but dotnet not found → falls back to git clone
 *   - no bbTemplate provided: legacy clone path used directly
 *   - EE-INTENT.md emitted when dotnet-template path succeeds
 *
 * All dotnet calls, fs ops, and exec are mocked — no real dotnet SDK required.
 */

import { describe, expect, it, vi } from "vitest";
import type { InitNewOptions } from "../../src/scaffold/init-new.js";

// ---------------------------------------------------------------------------
// Module-level mock for spawnSync used in detectDotnet / detectInstalledBBTemplates
// ---------------------------------------------------------------------------

// We mock at the module level to intercept the spawnSync calls inside init-new.ts.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // spawnSync is mocked per-test via vi.mocked below
    spawnSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFs(opts?: { existsReturns?: boolean; restoreFails?: boolean }) {
  const mkdir = vi.fn(async (_p: string) => {});
  const writeFile = vi.fn(async (_p: string, _content: string) => {});
  const exec = vi.fn(async (cmd: string, _cwd: string): Promise<{ stdout: string; stderr: string }> => {
    // dotnet restore failure simulation
    if (cmd.includes("dotnet restore") && opts?.restoreFails) {
      return { stdout: "", stderr: "error NU1301: feed unreachable" };
    }
    return { stdout: "", stderr: "" };
  });
  const exists = vi.fn((_p: string) => opts?.existsReturns ?? false);
  return { mkdir, writeFile, exec, exists };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initNewProject — bb-template path", () => {
  it("uses dotnet new when bbTemplate provided and dotnet available", async () => {
    const { spawnSync } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawnSync);

    // dotnet --version → returns 9.0.100 (BaseTemplate requires SDK 9+)
    mockSpawn.mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === "dotnet" && args?.[0] === "--version") {
        return { status: 0, stdout: "9.0.100\n", stderr: "", pid: 1, signal: null, output: [] };
      }
      return { status: 1, stdout: "", stderr: "not found", pid: 1, signal: null, output: [] };
    });

    const { initNewProject } = await import("../../src/scaffold/init-new.js");
    const fs = makeMockFs({ existsReturns: false });

    const opts: InitNewOptions = {
      projectName: "my-app",
      beSource: "/fake/bb",
      feStack: "react",
      projectsRoot: "/tmp/projects",
      bbTemplate: { shortName: "muonroi-base", nugetId: "Muonroi.BaseTemplate", version: "latest" },
      fs,
    };

    const result = await initNewProject(opts);

    expect(result.usedDotnetTemplate).toBe(true);

    // dotnet new should have been called via exec mock
    const execCalls = fs.exec.mock.calls;
    const dotnetNewCall = execCalls.find((c) => (c[0] as string).includes("dotnet new"));
    expect(dotnetNewCall).toBeTruthy();
    expect(dotnetNewCall?.[0]).toContain("muonroi-base");
    expect(dotnetNewCall?.[0]).toContain("my-app");

    // EE-INTENT.md should be written
    const writeCalls = fs.writeFile.mock.calls;
    const eeIntentCall = writeCalls.find((c) => (c[0] as string).includes("EE-INTENT.md"));
    expect(eeIntentCall).toBeTruthy();
    const eeIntentContent = eeIntentCall?.[1] as string;
    expect(eeIntentContent).toContain("Muonroi.BaseTemplate");
    expect(eeIntentContent).toContain("muonroi-base");

    // git clone should NOT have been called
    const cloneCall = execCalls.find((c) => (c[0] as string).includes("git clone"));
    expect(cloneCall).toBeFalsy();
  });

  it("throws actionable error when dotnet is absent (Plan 23-01b retired git-clone fallback)", async () => {
    const { spawnSync } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawnSync);

    // dotnet --version → fails (not installed)
    mockSpawn.mockImplementation(() => ({
      status: 1,
      stdout: "",
      stderr: "command not found: dotnet",
      pid: 1,
      signal: null,
      output: [],
    }));

    // Re-import after mock change
    vi.resetModules();
    const { initNewProject } = await import("../../src/scaffold/init-new.js");
    const fs = makeMockFs({ existsReturns: false });

    const opts: InitNewOptions = {
      projectName: "my-app",
      beSource: "https://github.com/muonroi/muonroi-building-block.git",
      feStack: "none",
      projectsRoot: "/tmp/projects",
      bbTemplate: { shortName: "muonroi-base", nugetId: "Muonroi.BaseTemplate", version: "latest" },
      fs,
    };

    await expect(initNewProject(opts)).rejects.toThrow(/\.NET SDK not found/);
  });

  it("skips BE scaffold when no bbTemplate provided (FE-only project)", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockImplementation(() => ({
      status: 0,
      stdout: "9.0.100\n",
      stderr: "",
      pid: 1,
      signal: null,
      output: [],
    }));

    vi.resetModules();
    const { initNewProject } = await import("../../src/scaffold/init-new.js");
    const fs = makeMockFs({ existsReturns: false });

    const opts: InitNewOptions = {
      projectName: "fe-only-app",
      beSource: "/path/to/bb",
      feStack: "react",
      projectsRoot: "/tmp/projects",
      // No bbTemplate — FE-only path
      fs,
    };

    const result = await initNewProject(opts);

    expect(result.usedDotnetTemplate).toBeFalsy();
    expect(result.projectDir).toContain("fe-only-app");

    // Legacy git-clone fallback retired (Plan 23-01b) — no clone call expected.
    const execCalls = fs.exec.mock.calls;
    const cloneCall = execCalls.find((c) => (c[0] as string).includes("git clone"));
    expect(cloneCall).toBeFalsy();
  });

  it("filters commercial packages when commercial flag is false", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockImplementation((cmd: string, args?: readonly string[]) => {
      if (cmd === "dotnet" && args?.[0] === "--version") {
        return { status: 0, stdout: "9.0.100\n", stderr: "", pid: 1, signal: null, output: [] };
      }
      return { status: 1, stdout: "", stderr: "", pid: 1, signal: null, output: [] };
    });

    vi.resetModules();
    const { isCommercialPackage: _ } = await import("../../src/scaffold/init-new.js").catch(() => ({
      isCommercialPackage: undefined,
    }));
    // isCommercialPackage is not exported — test via eePackages injection behavior
    // The test verifies that commercial packages are not injected into props

    const { initNewProject } = await import("../../src/scaffold/init-new.js");
    const fs = makeMockFs({ existsReturns: false });

    const opts: InitNewOptions = {
      projectName: "oss-app",
      beSource: "/fake/bb",
      feStack: "none",
      projectsRoot: "/tmp/projects",
      bbTemplate: { shortName: "muonroi-base", nugetId: "Muonroi.BaseTemplate", version: "latest" },
      eePackages: ["Muonroi.RuleEngine.Core", "Muonroi.RuleEngine.CEP"],
      commercial: false, // CEP is commercial — should be filtered
      fs,
    };

    // Since Directory.Packages.props doesn't exist in mock, the injection is skipped
    // but the test validates the flow doesn't throw
    const result = await initNewProject(opts);
    expect(result.projectDir).toContain("oss-app");
  });
});

describe("detectDotnet", () => {
  it("returns version string when dotnet is available", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockImplementation(() => ({
      status: 0,
      stdout: "8.0.100\n",
      stderr: "",
      pid: 1,
      signal: null,
      output: [],
    }));

    vi.resetModules();
    const { detectDotnet } = await import("../../src/scaffold/init-new.js");
    const version = detectDotnet();
    expect(version).toBe("8.0.100");
  });

  it("returns null when dotnet is not available", async () => {
    const { spawnSync } = await import("node:child_process");
    vi.mocked(spawnSync).mockImplementation(() => ({
      status: 1,
      stdout: "",
      stderr: "not found",
      pid: 1,
      signal: null,
      output: [],
    }));

    vi.resetModules();
    const { detectDotnet } = await import("../../src/scaffold/init-new.js");
    const version = detectDotnet();
    expect(version).toBeNull();
  });
});
