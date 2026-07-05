import { describe, expect, it } from "vitest";
import { applyPilSuffix } from "../../pil/layer6-output.js";
import type { PipelineContext } from "../../pil/types.js";
import { assembleFrontSystem, foldDynamicTailIntoUserMessage, splitFrontAndDynamicTail } from "../cache-prefix.js";

// A realistic, byte-stable static prefix (mode prompt + capabilities + skills).
// The exact bytes don't matter — only that it is identical across turns.
const STATIC_PREFIX = `You are an agent.\n${"CAPABILITIES BLOCK. ".repeat(200)}\nEND STATIC PREFIX.`;

// dynamicSuffix mirrors buildSystemPromptParts: plan/resume/cwd. Per-turn.
const DYNAMIC_SUFFIX = "\n\nCurrent working directory: /tmp/project-xyz";

// A representative live MCP roster (built from the final toolset each turn).
const MCP_CAPS = "\n\n[MCP tools available this turn: mcp_docs__search, mcp_docs__read]";

/** Turn A: no task detected → PIL is a no-op (pil_active=0). */
function ctxNoPil(): PipelineContext {
  return {
    intentKind: "task",
    taskType: null,
    raw: "hello",
    outputStyle: "concise",
    t1Rules: [],
  } as unknown as PipelineContext;
}

/** Turn B: task detected → PIL appends an output suffix (pil_active=1). */
function ctxWithPil(): PipelineContext {
  return {
    intentKind: "task",
    taskType: "debug",
    raw: "fix the failing test",
    outputStyle: "concise",
    t1Rules: [],
  } as unknown as PipelineContext;
}

/**
 * Reproduce the non-fast-tier non-Claude assembly for one turn:
 *   staticPrefix + dynamicSuffix  → applyPilSuffix  → + MCP roster.
 * (Fast-tier cheap-model injectors are gated off for non-fast models, so they
 * do not run here — matching runtime for e.g. deepseek-v4-pro / glm-4.7.)
 */
function assembleSystemWithCaps(ctx: PipelineContext): string {
  const base = `${STATIC_PREFIX}${DYNAMIC_SUFFIX}`;
  const withPil = applyPilSuffix(base, ctx, false);
  return `${withPil}${MCP_CAPS}`;
}

describe("non-Claude cache prefix stability", () => {
  it("baseline (documents the bug): the raw single-string system prefix shifts when PIL activates", () => {
    const rawA = assembleSystemWithCaps(ctxNoPil());
    const rawB = assembleSystemWithCaps(ctxWithPil());
    // The PIL suffix lands BETWEEN staticPrefix and the conversation, so the
    // full strings differ — and because DeepSeek/GLM cache by longest common
    // *prefix*, the tail differing means every byte after staticPrefix is a
    // cache miss on turn B. This is the exact defect Task 3 fixes.
    expect(rawB).not.toBe(rawA);
    expect(rawB.length).toBeGreaterThan(rawA.length); // PIL suffix present in B
  });

  it("keeps the front system byte-identical when PIL activates (the fix)", () => {
    const model = "deepseek-v4-pro"; // non-fast-tier non-Claude (expensive path)
    const frontA = assembleFrontSystem({
      modelId: model,
      systemWithCaps: assembleSystemWithCaps(ctxNoPil()),
      staticPrefix: STATIC_PREFIX,
    });
    const frontB = assembleFrontSystem({
      modelId: model,
      systemWithCaps: assembleSystemWithCaps(ctxWithPil()),
      staticPrefix: STATIC_PREFIX,
    });
    // Front is byte-identical across the PIL toggle → cached prefix no longer moves.
    expect(frontB).toBe(frontA);
    // And it is exactly the byte-stable staticPrefix (nothing dynamic leaked in).
    expect(frontA).toBe(STATIC_PREFIX);
  });

  it("relocates the dynamic tail (dynamicSuffix + PIL suffix + MCP roster) off the front", () => {
    const split = splitFrontAndDynamicTail({
      modelId: "deepseek-v4-pro",
      systemWithCaps: assembleSystemWithCaps(ctxWithPil()),
      staticPrefix: STATIC_PREFIX,
    });
    expect(split.front).toBe(STATIC_PREFIX);
    expect(split.dynamicTail).toContain("Current working directory");
    expect(split.dynamicTail).toContain("mcp_docs__search");
    // Nothing is lost: front + tail reconstruct the original string.
    expect(split.front + split.dynamicTail).toBe(assembleSystemWithCaps(ctxWithPil()));
  });

  it("leaves the Claude path untouched (no split, no relocation)", () => {
    const systemWithCaps = assembleSystemWithCaps(ctxWithPil());
    const split = splitFrontAndDynamicTail({
      modelId: "claude-sonnet-4-6",
      systemWithCaps,
      staticPrefix: STATIC_PREFIX,
    });
    expect(split.front).toBe(systemWithCaps);
    expect(split.dynamicTail).toBe("");
  });

  it("folds the dynamic tail into a string user message without mutating it", () => {
    const original = { role: "user" as const, content: "do the thing" };
    const folded = foldDynamicTailIntoUserMessage(original, DYNAMIC_SUFFIX + MCP_CAPS);
    expect(original.content).toBe("do the thing"); // input unchanged
    expect(typeof folded.content).toBe("string");
    expect(folded.content as string).toContain("do the thing");
    expect(folded.content as string).toContain("Current working directory");
  });

  it("folds the dynamic tail into a structured (array) user message", () => {
    const original = { role: "user" as const, content: [{ type: "text", text: "do the thing" }] };
    const folded = foldDynamicTailIntoUserMessage(original, DYNAMIC_SUFFIX);
    expect(Array.isArray(folded.content)).toBe(true);
    expect((folded.content as unknown[]).length).toBe(2);
    expect(original.content.length).toBe(1); // input unchanged
  });

  it("is a no-op when the tail is empty", () => {
    const original = { role: "user" as const, content: "x" };
    expect(foldDynamicTailIntoUserMessage(original, "   ")).toBe(original);
  });

  it("documents the fast-tier residual: the front-loaded workbook still shifts the prefix", () => {
    // Fast-tier models front-load a task workbook whose addendum covaries with
    // taskType (== pil_active) BEFORE staticPrefix. splitFrontAndDynamicTail cuts
    // at staticPrefix, so that covarying preamble stays in the front and the
    // front is NOT byte-stable for fast-tier. This is a documented limitation
    // (deliberate primacy design) — the fix fully stabilizes non-fast-tier only.
    const workbookA = "CONVERGENCE. ".repeat(20); // taskType=null preamble
    const workbookB = `CONVERGENCE. ${"DEBUG ADDENDUM. ".repeat(10)}`; // taskType=debug preamble
    const frontFast = (workbook: string, ctx: PipelineContext) =>
      assembleFrontSystem({
        modelId: "deepseek-v4-flash",
        systemWithCaps: `${workbook}${assembleSystemWithCaps(ctx)}`,
        staticPrefix: STATIC_PREFIX,
      });
    expect(frontFast(workbookB, ctxWithPil())).not.toBe(frontFast(workbookA, ctxNoPil()));
  });
});
