/**
 * Unit tests for pointToExisting().
 *
 * All filesystem operations use real tmp dirs so we don't need to mock fs.
 * detectVerifyRecipe is always mocked so there are no orchestrator calls.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAdoptExistingContinuationPrompt } from "../continuation-prompt.js";
import { detectExistingProjectRecipe, pointToExisting } from "../point-to-existing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "point-to-existing-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: existing dir + recipe found → ok
// ---------------------------------------------------------------------------

describe("pointToExisting — success", () => {
  it("returns ok=true when dir exists and detectVerifyRecipe returns a recipe", async () => {
    const mockRecipe = { kind: "bun-test" };
    const detectVerifyRecipe = vi.fn(async (_cwd: string) => mockRecipe);

    const result = await pointToExisting({
      path: tmpRoot,
      detectVerifyRecipe,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.recipe).toEqual(mockRecipe);
    expect(path.isAbsolute(result.absolutePath)).toBe(true);
    // detectVerifyRecipe called with the resolved absolute path
    expect(detectVerifyRecipe).toHaveBeenCalledOnce();
    expect(detectVerifyRecipe.mock.calls[0]![0]).toBe(result.absolutePath);
  });
});

// ---------------------------------------------------------------------------
// Test 2: nonexistent path → not_a_dir
// ---------------------------------------------------------------------------

describe("pointToExisting — nonexistent path", () => {
  it("returns not_a_dir when path does not exist", async () => {
    const detectVerifyRecipe = vi.fn(async () => ({ kind: "bun-test" }));

    const result = await pointToExisting({
      path: path.join(tmpRoot, "nonexistent-dir-xyz"),
      detectVerifyRecipe,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_dir");
    // detectVerifyRecipe must NOT be called when path is invalid
    expect(detectVerifyRecipe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 3: path is a file, not a directory → not_a_dir
// ---------------------------------------------------------------------------

describe("pointToExisting — file instead of directory", () => {
  it("returns not_a_dir when path points to a file", async () => {
    const filePath = path.join(tmpRoot, "some-file.txt");
    writeFileSync(filePath, "hello");
    const detectVerifyRecipe = vi.fn(async () => ({ kind: "bun-test" }));

    const result = await pointToExisting({
      path: filePath,
      detectVerifyRecipe,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_dir");
    expect(detectVerifyRecipe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 4: dir exists but detectVerifyRecipe returns null → no_recipe
// ---------------------------------------------------------------------------

describe("pointToExisting — no recipe", () => {
  it("returns no_recipe when detectVerifyRecipe returns null", async () => {
    const subdir = path.join(tmpRoot, "project-no-recipe");
    mkdirSync(subdir);
    const detectVerifyRecipe = vi.fn(async (_cwd: string) => null);

    const result = await pointToExisting({
      path: subdir,
      detectVerifyRecipe,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_recipe");
    expect(result.absolutePath).toBeTruthy();
    // detectVerifyRecipe was called (path was valid)
    expect(detectVerifyRecipe).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// detectExistingProjectRecipe — the real filesystem detector that replaced the
// deferred `return null` stub in the point-to-existing recovery handler.
// ---------------------------------------------------------------------------

describe("detectExistingProjectRecipe", () => {
  it("returns a runnable recipe for a node project with a test script", () => {
    writeFileSync(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({ name: "todo", scripts: { test: "node --test", lint: "echo ok" } }),
    );
    const recipe = detectExistingProjectRecipe(tmpRoot);
    expect(recipe).not.toBeNull();
    expect(recipe?.ecosystem).toBe("node");
    expect(recipe?.testCommands.length).toBeGreaterThan(0);
  });

  it("returns null for a directory with no recognizable project files", () => {
    // Bare dir → inferVerifyProjectProfile emits the "unknown" fallback with empty
    // commands; the runnable-gate must reject it so point-to-existing reports
    // no_recipe rather than falsely adopting an empty directory.
    writeFileSync(path.join(tmpRoot, "notes.txt"), "hello");
    expect(detectExistingProjectRecipe(tmpRoot)).toBeNull();
  });

  it("returns a recipe for a project whose only script is build (no test)", () => {
    writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "buildonly", scripts: { build: "tsc" } }));
    const recipe = detectExistingProjectRecipe(tmpRoot);
    expect(recipe).not.toBeNull();
    expect(recipe?.buildCommands.length).toBeGreaterThan(0);
  });
});

describe("buildAdoptExistingContinuationPrompt", () => {
  it("embeds the original request + project dir and forbids re-scaffolding", () => {
    const prompt = buildAdoptExistingContinuationPrompt({
      originalPrompt: "add a delete-todo endpoint",
      projectDir: "/tmp/my-existing-app",
    });
    expect(prompt).toContain("add a delete-todo endpoint");
    expect(prompt).toContain("/tmp/my-existing-app");
    expect(prompt).toContain("do NOT re-scaffold");
    // Must NOT carry the init_new template assumptions.
    expect(prompt).not.toContain("BB template");
  });
});
