/**
 * Unit tests for continueAsCouncil() — Task 5.5.
 *
 * All filesystem writes are injected via opts.fs so the real filesystem is
 * never touched. runCouncil is also injected so no real orchestrator runs.
 *
 * Key invariant checked by Test 2: the source file must contain no reference
 * to "runVerify" — guaranteeing it can never accidentally re-enter CB-3.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { continueAsCouncil } from "../continue-as-council.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an async iterable that emits delta chunks then done. */
async function* makeCouncilStream(
  chunks: string[],
): AsyncIterable<{ type: "delta" | "done"; content?: string }> {
  for (const c of chunks) {
    yield { type: "delta", content: c };
  }
  yield { type: "done" };
}

// ---------------------------------------------------------------------------
// Test 1: happy-path — delta chunks are collected and written to spec.md
// ---------------------------------------------------------------------------

describe("continueAsCouncil — happy path", () => {
  it("writes spec.md with both delta strings and returns hasContent: true", async () => {
    const writeFile = vi.fn(async (_p: string, _content: string) => {});

    const result = await continueAsCouncil({
      prompt: "build todo",
      outputDir: "/tmp/proj",
      runCouncil: () => makeCouncilStream(["First council note.", " Second council note."]),
      fs: { writeFile },
    });

    // writeFile called exactly once
    expect(writeFile).toHaveBeenCalledOnce();

    // path ends in spec.md
    expect(result.specPath.endsWith("spec.md")).toBe(true);

    // hasContent flag
    expect(result.hasContent).toBe(true);

    // content includes both delta strings
    const [, written] = writeFile.mock.calls[0]!;
    expect(written).toContain("First council note.");
    expect(written).toContain("Second council note.");
  });
});

// ---------------------------------------------------------------------------
// Test 2 (critical): source file must NOT reference runVerify
// ---------------------------------------------------------------------------

describe("continueAsCouncil — no runVerify dependency", () => {
  it("source file contains no reference to runVerify", () => {
    const srcPath = resolve(__dirname, "../continue-as-council.ts");
    const content = readFileSync(srcPath, "utf-8");
    expect(content).not.toContain("runVerify");
  });
});

// ---------------------------------------------------------------------------
// Test 3: spec.md content has recognizable heading and original prompt
// ---------------------------------------------------------------------------

describe("continueAsCouncil — spec.md content", () => {
  it("spec.md includes heading and original prompt text", async () => {
    const writeFile = vi.fn(async (_p: string, _content: string) => {});

    await continueAsCouncil({
      prompt: "design a recommendation engine",
      outputDir: "/tmp/spec-test",
      runCouncil: () => makeCouncilStream(["Some council output."]),
      fs: { writeFile },
    });

    const [, written] = writeFile.mock.calls[0]!;
    // Has recognizable heading
    expect(written).toContain("# Council brainstorm output");
    // Contains original prompt
    expect(written).toContain("design a recommendation engine");
  });
});

// ---------------------------------------------------------------------------
// Test 4: empty council stream → hasContent false, spec.md still written
// ---------------------------------------------------------------------------

describe("continueAsCouncil — empty stream", () => {
  it("writes spec.md even when council produces no content, hasContent: false", async () => {
    const writeFile = vi.fn(async (_p: string, _content: string) => {});

    async function* emptyStream(): AsyncIterable<{ type: "delta" | "done"; content?: string }> {
      yield { type: "done" };
    }

    const result = await continueAsCouncil({
      prompt: "empty prompt",
      outputDir: "/tmp/empty-test",
      runCouncil: emptyStream,
      fs: { writeFile },
    });

    expect(result.hasContent).toBe(false);
    // spec.md is still written
    expect(writeFile).toHaveBeenCalledOnce();
    const [, written] = writeFile.mock.calls[0]!;
    // Still has the heading
    expect(written).toContain("# Council brainstorm output");
    // Notes no content was produced
    expect(written).toContain("No content was produced");
  });
});
