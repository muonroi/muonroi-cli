// src/product-loop/__tests__/discovery-triage.test.ts
import { describe, expect, it, vi } from "vitest";
import { DISCOVERY_QUESTIONS } from "../discovery-schema.js";
import { fallbackTriage, triageInterview } from "../discovery-triage.js";

const REQUIRED = DISCOVERY_QUESTIONS.filter((q) => q.required);

function leaderReturning(content: string) {
  return { generate: vi.fn(async () => ({ content, costUsd: 0 })) };
}

describe("triageInterview", () => {
  it("parses a valid model triage and normalizes relevant to [] for non-complex", async () => {
    const leader = leaderReturning(
      JSON.stringify({ complexity: "trivial", relevant: ["backendStack"], rationale: "hello world script" }),
    );
    const t = await triageInterview("build a hello.py script + pytest", leader as never, REQUIRED);
    expect(t.complexity).toBe("trivial");
    expect(t.relevant).toEqual([]); // relevant is meaningful only for complex
    expect(t.source).toBe("model");
  });

  it("keeps only valid required ids in relevant for a complex idea", async () => {
    const leader = leaderReturning(
      JSON.stringify({
        complexity: "complex",
        relevant: ["backendStack", "dbStrategy", "not-a-real-id", "frontendApproach"],
        rationale: "multi-tenant",
      }),
    );
    const t = await triageInterview("multi-tenant SaaS with OAuth", leader as never, REQUIRED);
    expect(t.complexity).toBe("complex");
    // "not-a-real-id" dropped; "frontendApproach" is optional (not in REQUIRED_QUESTION_IDS) → dropped
    expect(t.relevant).toEqual(["backendStack", "dbStrategy"]);
  });

  it("tolerates code fences around the JSON", async () => {
    const leader = leaderReturning('```json\n{"complexity":"standard","relevant":[],"rationale":"todo app"}\n```');
    const t = await triageInterview("build a todo web app", leader as never, REQUIRED);
    expect(t.complexity).toBe("standard");
    expect(t.source).toBe("model");
  });

  it("falls back on unparseable output", async () => {
    const leader = leaderReturning("I think this is a trivial script, honestly.");
    const t = await triageInterview("build a hello world script", leader as never, REQUIRED);
    expect(t.source).toBe("fallback");
    // minimal prompt → fallback maps to trivial
    expect(t.complexity).toBe("trivial");
  });

  it("falls back on an invalid tier value", async () => {
    const leader = leaderReturning(JSON.stringify({ complexity: "gigantic", relevant: [], rationale: "x" }));
    const t = await triageInterview(
      "please build me a fairly ordinary program that does several small useful things for people today",
      leader as never,
      REQUIRED,
    );
    expect(t.source).toBe("fallback");
    expect(t.complexity).toBe("standard"); // >10 words, no qualifiers → moderate → standard
  });

  it("falls back (no throw) when the leader throws", async () => {
    const leader = {
      generate: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const t = await triageInterview("build a hello world script", leader as never, REQUIRED);
    expect(t.source).toBe("fallback");
    expect(leader.generate).toHaveBeenCalledOnce();
  });

  it("skips the LLM call for an empty idea", async () => {
    const leader = leaderReturning("{}");
    const t = await triageInterview("   ", leader as never, REQUIRED);
    expect(t.source).toBe("fallback");
    expect(leader.generate).not.toHaveBeenCalled();
  });
});

describe("fallbackTriage", () => {
  it("maps a minimal prompt to trivial", () => {
    expect(fallbackTriage("tạo todo app").complexity).toBe("trivial");
  });
  it("maps a non-minimal prompt to standard", () => {
    expect(
      fallbackTriage("build a multi tenant billing platform with stripe and postgres and oauth sso").complexity,
    ).toBe("standard");
  });
});
