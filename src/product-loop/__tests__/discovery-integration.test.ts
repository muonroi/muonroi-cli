// src/product-loop/__tests__/discovery-integration.test.ts
import { describe, expect, it } from "vitest";
import { formatProjectContextForPrompt } from "../discovery-context-format.js";
import type { ProjectContext } from "../types.js";

const SAMPLE: ProjectContext = {
  version: 1,
  schemaName: "project-context",
  generatedAt: "2026-05-13T10:00:00Z",
  idea: "Build a B2B SaaS dashboard",
  detection: {
    isGitRepo: false,
    hasCommitHistory: false,
    srcFileCount: 0,
    manifests: [],
    languages: [],
    frameworks: [],
    classification: "greenfield",
  },
  context: {
    productType: "saas",
    targetPlatform: ["web"],
    audience: { persona: "ops engineers", scale: "1k-100k", geography: "global" },
    backendArchitecture: "modular-monolith",
    backendStack: { language: "TypeScript", framework: "NestJS" },
    dbStrategy: { mode: "greenfield", engine: "PostgreSQL" },
  },
  recommendations: { byField: {}, constraints: { fePolicy: "headless-ui-only", feEnforced: true } },
  userOverrides: [],
};

describe("formatProjectContextForPrompt", () => {
  it("renders a deterministic prompt-ready string", () => {
    const out = formatProjectContextForPrompt(SAMPLE);
    expect(out).toContain("B2B SaaS dashboard");
    expect(out).toContain("modular-monolith");
    expect(out).toContain("PostgreSQL");
    expect(out).toContain("headless-ui-only");
  });

  it("produces identical output for identical input", () => {
    expect(formatProjectContextForPrompt(SAMPLE)).toBe(formatProjectContextForPrompt(SAMPLE));
  });

  it("omits undefined optional fields cleanly", () => {
    const out = formatProjectContextForPrompt(SAMPLE);
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("null");
  });
});
