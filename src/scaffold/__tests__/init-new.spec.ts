/**
 * Unit tests for initNewProject scaffolder.
 * All fs + exec operations are mocked — no real I/O or shell-out.
 */

import { describe, expect, it, vi } from "vitest";
import type { InitNewOptions } from "../init-new.js";
import { initNewProject } from "../init-new.js";

// ---------------------------------------------------------------------------
// Mock fs factory — returns a fresh spy set per test.
// ---------------------------------------------------------------------------

function makeMockFs(opts?: { mkdirThrows?: string; existsReturns?: boolean }) {
  const mkdir = vi.fn(async (_p: string) => {
    if (opts?.mkdirThrows) {
      const err = new Error(opts.mkdirThrows) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    }
  });
  const writeFile = vi.fn(async (_p: string, _content: string) => {});
  const exec = vi.fn(async (_cmd: string, _cwd: string) => ({ stdout: "", stderr: "" }));
  const exists = vi.fn((_p: string) => opts?.existsReturns ?? false);
  return { mkdir, writeFile, exec, exists };
}

// ---------------------------------------------------------------------------
// Test 1: scaffolds expected file tree (react)
// ---------------------------------------------------------------------------

describe("initNewProject — react", () => {
  it("creates expected directories and files for react stack", async () => {
    const fs = makeMockFs();
    const result = await initNewProject({
      projectName: "test-app",
      beSource: "/fake/bb",
      feStack: "react",
      projectsRoot: "/tmp/projects",
      fs,
    });

    // Directories created: project root, server, client, client/src
    const mkdirPaths = fs.mkdir.mock.calls.map((c) => c[0] as string);
    expect(mkdirPaths.some((p) => p.endsWith("test-app"))).toBe(true);
    expect(mkdirPaths.some((p) => p.includes("server"))).toBe(true);
    expect(mkdirPaths.some((p) => p.endsWith("client"))).toBe(true);
    expect(mkdirPaths.some((p) => p.includes("client") && p.endsWith("src"))).toBe(true);

    // Files written
    expect(result.files).toContain("package.json");
    expect(result.files).toContain("client/package.json");
    expect(result.files).toContain("client/vite.config.ts");
    expect(result.files).toContain("client/index.html");
    expect(result.files).toContain("client/src/main.tsx");

    // git clone invoked with beSource
    const execCalls = fs.exec.mock.calls;
    expect(execCalls.length).toBe(1);
    const cloneCmd = execCalls[0][0] as string;
    expect(cloneCmd).toContain("git clone");
    expect(cloneCmd).toContain("/fake/bb");

    // main.tsx contains SemanticProvider
    const writeFileCalls = fs.writeFile.mock.calls;
    const mainTsxCall = writeFileCalls.find((c) => (c[0] as string).endsWith("main.tsx"));
    expect(mainTsxCall).toBeDefined();
    expect(mainTsxCall![1] as string).toContain("SemanticProvider");

    // projectDir returned correctly
    expect(result.projectDir).toContain("test-app");
  });
});

// ---------------------------------------------------------------------------
// Test 2: scaffolds expected file tree (angular)
// ---------------------------------------------------------------------------

describe("initNewProject — angular", () => {
  it("creates expected directories and files for angular stack", async () => {
    const fs = makeMockFs();
    const result = await initNewProject({
      projectName: "ng-app",
      beSource: "/fake/bb",
      feStack: "angular",
      projectsRoot: "/tmp/projects",
      fs,
    });

    // Directories: project root, server, client, client/src, client/src/app
    const mkdirPaths = fs.mkdir.mock.calls.map((c) => c[0] as string);
    expect(mkdirPaths.some((p) => p.includes("app"))).toBe(true);

    // Files written
    expect(result.files).toContain("package.json");
    expect(result.files).toContain("client/package.json");
    expect(result.files).toContain("client/tsconfig.json");
    expect(result.files).toContain("client/src/main.ts");
    expect(result.files).toContain("client/src/app/app.component.ts");

    // No react files
    expect(result.files).not.toContain("client/vite.config.ts");
    expect(result.files).not.toContain("client/src/main.tsx");

    // app.component.ts uses muonroiSemantic directive
    const writeFileCalls = fs.writeFile.mock.calls;
    const componentCall = writeFileCalls.find((c) => (c[0] as string).endsWith("app.component.ts"));
    expect(componentCall).toBeDefined();
    expect(componentCall![1] as string).toContain("muonroiSemantic");
    expect(componentCall![1] as string).toContain("SemanticDirective");
  });
});

// ---------------------------------------------------------------------------
// Test 3: feStack=none skips client/**
// ---------------------------------------------------------------------------

describe("initNewProject — none", () => {
  it("skips client directory and files when feStack is none", async () => {
    const fs = makeMockFs();
    const result = await initNewProject({
      projectName: "be-only",
      beSource: "/fake/bb",
      feStack: "none",
      projectsRoot: "/tmp/projects",
      fs,
    });

    // No client/* files
    const clientFiles = result.files.filter((f) => f.startsWith("client/"));
    expect(clientFiles).toHaveLength(0);

    // No client directories created
    const mkdirPaths = fs.mkdir.mock.calls.map((c) => c[0] as string);
    expect(mkdirPaths.every((p) => !p.includes("client"))).toBe(true);

    // root package.json still written
    expect(result.files).toContain("package.json");

    // git clone still runs
    expect(fs.exec.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 4: refuses if projectDir already exists
// ---------------------------------------------------------------------------

describe("initNewProject — existence guard", () => {
  it("rejects with descriptive error when target directory already exists", async () => {
    const fs = makeMockFs({ existsReturns: true });
    await expect(
      initNewProject({
        projectName: "existing-app",
        beSource: "/fake/bb",
        feStack: "react",
        projectsRoot: "/tmp/projects",
        fs,
      }),
    ).rejects.toThrow(/already exists/i);
  });
});

// ---------------------------------------------------------------------------
// Test 5: validates projectName
// ---------------------------------------------------------------------------

describe("initNewProject — name validation", () => {
  it("rejects path traversal in projectName", async () => {
    const fs = makeMockFs();
    await expect(
      initNewProject({
        projectName: "../escape",
        beSource: "/fake/bb",
        feStack: "react",
        fs,
      }),
    ).rejects.toThrow(/path traversal/i);
  });

  it("rejects empty project name", async () => {
    const fs = makeMockFs();
    await expect(
      initNewProject({
        projectName: "",
        beSource: "/fake/bb",
        feStack: "react",
        fs,
      }),
    ).rejects.toThrow(/empty/i);
  });

  it("rejects name with backslash traversal", async () => {
    const fs = makeMockFs();
    await expect(
      initNewProject({
        projectName: "foo\\bar",
        beSource: "/fake/bb",
        feStack: "react",
        fs,
      }),
    ).rejects.toThrow(/path traversal/i);
  });

  it("rejects name with invalid characters (spaces)", async () => {
    const fs = makeMockFs();
    await expect(
      initNewProject({
        projectName: "my app",
        beSource: "/fake/bb",
        feStack: "react",
        fs,
      }),
    ).rejects.toThrow(/invalid/i);
  });
});
