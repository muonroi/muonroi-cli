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
import { pointToExisting } from "../point-to-existing.js";

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
