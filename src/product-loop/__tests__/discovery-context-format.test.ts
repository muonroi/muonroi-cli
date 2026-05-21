/**
 * Regression tests for formatProjectContextForPrompt — session
 * e2660a052918 crashed at "ctx.context.backendStack.language" because
 * `backendStack` was marked as prefilled-from-detection (interview
 * skipped the question) but the prefillAnswers map didn't actually
 * contain a backendStack value. Downstream the formatter accessed
 * `.language` of undefined and the /ideal loop silently halted.
 *
 * The formatter must NEVER throw on a partial context. Every consumer
 * is a leader prompt; we'd rather emit "(unspecified)" than crash the
 * loop.
 */

import { describe, expect, it } from "vitest";
import { formatProjectContextForPrompt } from "../discovery-context-format.js";
import type { ExistingProjectSignals, ProjectContext } from "../types.js";

function makeDetection(): ExistingProjectSignals {
  return {
    isGitRepo: false,
    hasCommitHistory: false,
    srcFileCount: 0,
    manifests: [],
    languages: [],
    frameworks: [],
    classification: "greenfield",
  };
}

function makeCtx(over: Partial<ProjectContext["context"]> = {}): ProjectContext {
  return {
    version: 1,
    schemaName: "project-context",
    generatedAt: new Date().toISOString(),
    idea: "test idea",
    detection: makeDetection(),
    context: over as ProjectContext["context"],
    recommendations: {
      byField: {},
      constraints: { fePolicy: "headless-ui-only", feEnforced: true },
    },
    userOverrides: [],
  };
}

describe("formatProjectContextForPrompt — partial context resilience", () => {
  it("does not throw when context is COMPLETELY empty (regression e2660a052918)", () => {
    const ctx = makeCtx({});
    expect(() => formatProjectContextForPrompt(ctx)).not.toThrow();
    const out = formatProjectContextForPrompt(ctx);
    expect(out).toContain("Idea: test idea");
  });

  it("does not throw when backendStack is missing (the actual crash field)", () => {
    const ctx = makeCtx({
      productType: "internal-tool",
      targetPlatform: ["cli"],
    });
    expect(() => formatProjectContextForPrompt(ctx)).not.toThrow();
    const out = formatProjectContextForPrompt(ctx);
    expect(out).toContain("Product type: internal-tool");
    expect(out).not.toContain("Backend stack:");
  });

  it("does not throw when audience is partial (e.g. only persona)", () => {
    const ctx = makeCtx({
      audience: { persona: "developer" } as unknown as ProjectContext["context"]["audience"],
    });
    expect(() => formatProjectContextForPrompt(ctx)).not.toThrow();
    const out = formatProjectContextForPrompt(ctx);
    expect(out).toContain("developer");
  });

  it("renders backendStack when present with all fields", () => {
    const ctx = makeCtx({
      backendStack: { language: "TypeScript", framework: "Hono", runtime: "Bun" },
    });
    const out = formatProjectContextForPrompt(ctx);
    expect(out).toContain("Backend stack: TypeScript / Hono on Bun");
  });

  it("renders backendStack without runtime gracefully", () => {
    const ctx = makeCtx({
      backendStack: { language: "TypeScript", framework: "Hono" },
    });
    const out = formatProjectContextForPrompt(ctx);
    expect(out).toContain("Backend stack: TypeScript / Hono");
    expect(out).not.toContain(" on ");
  });

  it("handles backendStack with only framework or only language", () => {
    const ctx1 = makeCtx({
      backendStack: { framework: "Express" } as ProjectContext["context"]["backendStack"],
    });
    expect(() => formatProjectContextForPrompt(ctx1)).not.toThrow();
    expect(formatProjectContextForPrompt(ctx1)).toContain("Express");

    const ctx2 = makeCtx({
      backendStack: { language: "Rust" } as ProjectContext["context"]["backendStack"],
    });
    expect(() => formatProjectContextForPrompt(ctx2)).not.toThrow();
    expect(formatProjectContextForPrompt(ctx2)).toContain("Rust");
  });

  it("does not throw when recommendations.constraints is missing", () => {
    const ctx = makeCtx({});
    // biome-ignore lint/suspicious/noExplicitAny: deliberately remove constraints
    (ctx as any).recommendations = undefined;
    expect(() => formatProjectContextForPrompt(ctx)).not.toThrow();
  });
});
