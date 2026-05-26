/**
 * repo-map.test.ts — Unit tests for ensureRepoMap + generateRepoMap.
 * Uses tmpdir for fs operations so it never touches the real workspace.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureRepoMap, generateRepoMap } from "../repo-map.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-repo-map-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// ---------------------------------------------------------------------------

describe("ensureRepoMap", () => {
  it("reads existing REPO_DEEP_MAP.md when present", async () => {
    const content = "# REPO_DEEP_MAP\n> pre-existing map\n\nsrc/\n├── index.ts\n";
    await fs.writeFile(path.join(tmpDir, "REPO_DEEP_MAP.md"), content, "utf8");

    const result = await ensureRepoMap(tmpDir);

    expect(result.source).toBe("existing");
    expect(result.content).toContain("pre-existing map");
    expect(result.path).toBe(path.join(tmpDir, "REPO_DEEP_MAP.md"));
  });

  it("generates and writes REPO_DEEP_MAP.md when file is missing", async () => {
    // Create a small synthetic file tree
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "// entry point\nexport {};", "utf8");

    const result = await ensureRepoMap(tmpDir);

    expect(result.source).toBe("generated");
    // File should now exist on disk
    const written = await fs.readFile(path.join(tmpDir, "REPO_DEEP_MAP.md"), "utf8");
    expect(written).toContain("REPO_DEEP_MAP");
    expect(result.content).toContain("src");
  });

  it("truncates long existing content to ~2000 chars", async () => {
    const longContent = "x".repeat(5000);
    await fs.writeFile(path.join(tmpDir, "REPO_DEEP_MAP.md"), longContent, "utf8");

    const result = await ensureRepoMap(tmpDir);

    // Content must be truncated
    expect(result.content.length).toBeLessThanOrEqual(2020); // 2000 + "[... truncated]"
    expect(result.content).toContain("[... truncated]");
  });
});

// ---------------------------------------------------------------------------

describe("generateRepoMap", () => {
  it("skips node_modules, .git, and dist directories", async () => {
    // Create skip-listed dirs with files
    for (const skipDir of ["node_modules", ".git", "dist"]) {
      await fs.mkdir(path.join(tmpDir, skipDir), { recursive: true });
      await fs.writeFile(path.join(tmpDir, skipDir, "should-be-hidden.ts"), "// hidden", "utf8");
    }
    // Create a real source file
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "visible.ts"), "// visible", "utf8");

    const map = await generateRepoMap(tmpDir);

    expect(map).toContain("visible.ts");
    expect(map).not.toContain("node_modules");
    expect(map).not.toContain("should-be-hidden");
    expect(map).not.toContain(".git");
    expect(map).not.toContain("dist");
  });

  it("truncates output at ~2000 chars and appends truncation marker", async () => {
    // Create many files to force truncation
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await fs.writeFile(
        path.join(tmpDir, "src", `file-with-long-name-${String(i).padStart(3, "0")}.ts`),
        "// filler",
        "utf8",
      );
    }

    const map = await generateRepoMap(tmpDir);

    // Should be under MAX_GENERATE_CHARS (1800) + truncation line
    expect(map.length).toBeLessThanOrEqual(1900);
    expect(map).toContain("truncated");
  });

  it("extracts top-of-file JSDoc description from TS files", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "auth.ts"),
      `/**\n * Handles user authentication and session management.\n */\nexport {};`,
      "utf8",
    );

    const map = await generateRepoMap(tmpDir);

    expect(map).toContain("auth.ts");
    expect(map).toContain("Handles user authentication");
  });

  it("extracts top-of-file // comment description from TS files", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "logger.ts"),
      `// Structured logging utilities for the CLI\nexport {};`,
      "utf8",
    );

    const map = await generateRepoMap(tmpDir);

    expect(map).toContain("Structured logging utilities");
  });
});
