/**
 * Integration test: leaderRecommend must inject the ecosystem preamble into
 * the leader prompt by default, and skip it when discoveryEcosystemBias=false.
 *
 * We capture the prompt passed to `leader.generate` and assert on its content
 * rather than mocking the underlying file. This keeps the test resilient to
 * changes in the preamble wording — it just has to be there.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/settings.js", async (orig) => {
  const real: Record<string, unknown> = await orig();
  return {
    ...real,
    loadUserSettings: vi.fn(() => ({})),
  };
});

import { loadUserSettings } from "../../utils/settings.js";
import { leaderRecommend } from "../discovery-recommender.js";

function captureLeader(): { generate: ReturnType<typeof vi.fn>; lastPrompt: () => string } {
  let lastPrompt = "";
  const generate = vi.fn(async (args: { system: string; prompt: string; maxTokens: number }) => {
    lastPrompt = args.prompt;
    return {
      content: JSON.stringify({
        primary: { value: "Muonroi.BaseTemplate", rationale: "ecosystem default" },
        alternatives: [],
      }),
      costUsd: 0.001,
    };
  });
  return { generate, lastPrompt: () => lastPrompt };
}

function makeInput(questionId = "backendStack"): any {
  return {
    question: { id: questionId, required: true, recommendMode: "leader", prompt: "Pick a backend stack" },
    context: {},
    detection: {
      isGitRepo: false,
      hasCommitHistory: false,
      srcFileCount: 0,
      manifests: [],
      languages: [],
      frameworks: [],
      classification: "greenfield",
    },
  };
}

describe("leaderRecommend — ecosystem preamble injection", () => {
  it("default settings → prompt contains Muonroi ecosystem hint", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    const leader = captureLeader();
    await leaderRecommend(makeInput(), leader as any);
    const prompt = leader.lastPrompt();
    expect(prompt).toContain("Muonroi ecosystem");
    expect(prompt).toContain("muonroi-building-block");
    expect(prompt).toContain("Muonroi.BaseTemplate");
  });

  it("discoveryEcosystemBias=true (explicit) → prompt still contains ecosystem hint", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      discoveryEcosystemBias: true,
    });
    const leader = captureLeader();
    await leaderRecommend(makeInput(), leader as any);
    expect(leader.lastPrompt()).toContain("muonroi-building-block");
  });

  it("discoveryEcosystemBias=false → prompt has NO ecosystem hint", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      discoveryEcosystemBias: false,
    });
    const leader = captureLeader();
    await leaderRecommend(makeInput(), leader as any);
    const prompt = leader.lastPrompt();
    expect(prompt).not.toContain("Muonroi ecosystem");
    expect(prompt).not.toContain("muonroi-building-block");
  });

  it("Question + Field id + Detected project still present (no regression)", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    const leader = captureLeader();
    await leaderRecommend(makeInput("frontendApproach"), leader as any);
    const prompt = leader.lastPrompt();
    expect(prompt).toContain("Question: Pick a backend stack");
    expect(prompt).toContain("Field id: frontendApproach");
    expect(prompt).toContain("Detected project: greenfield");
  });
});

describe("leaderRecommend — existing-project repo-brief path", () => {
  function makeExistingInput(repoBrief?: any): any {
    return {
      question: { id: "backendStack", required: true, recommendMode: "leader", prompt: "Pick a backend stack" },
      context: {},
      detection: {
        isGitRepo: true,
        hasCommitHistory: true,
        srcFileCount: 200,
        manifests: [
          { file: "package.json", type: "package.json", weight: 1, inferredLang: "TypeScript", inferredFrameworks: [] },
        ],
        languages: ["TypeScript"],
        frameworks: [],
        classification: "existing",
      },
      repoBrief,
    };
  }

  const briefStub = {
    markdown: "## Repo brief\nPackage name: `muonroi-cli`\nKey deps: `ai`, `vitest`",
    citableTokens: ["muonroi-cli", "ai", "vitest", "package.json"],
  };

  it("existing project: prompt contains repo brief, NOT ecosystem preamble", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    const leader = captureLeader();
    await leaderRecommend(makeExistingInput(briefStub), leader as any);
    const prompt = leader.lastPrompt();
    expect(prompt).toContain("Repo brief");
    expect(prompt).toContain("muonroi-cli");
    // Vendor preamble must NOT appear for existing repos.
    expect(prompt).not.toContain("Muonroi ecosystem");
    expect(prompt).not.toContain("Muonroi.BaseTemplate");
  });

  it("citation present in rationale → no retry, synthFailed unset", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    let calls = 0;
    const leader = {
      generate: vi.fn(async () => {
        calls += 1;
        return {
          content: JSON.stringify({
            primary: { value: "TypeScript+Bun", rationale: "extends existing `muonroi-cli` toolchain" },
            alternatives: [],
          }),
          costUsd: 0.001,
        };
      }),
    };
    const out = await leaderRecommend(makeExistingInput(briefStub), leader as any);
    expect(calls).toBe(1);
    expect(out.synthFailed).toBeUndefined();
  });

  it("uncited rationale → leader called twice (one retry), still accepted with synthFailed=true", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    let calls = 0;
    const leader = {
      generate: vi.fn(async () => {
        calls += 1;
        return {
          content: JSON.stringify({
            primary: { value: "TypeScript+Bun", rationale: "industry standard choice for SaaS apps" },
            alternatives: [],
          }),
          costUsd: 0.001,
        };
      }),
    };
    const out = await leaderRecommend(makeExistingInput(briefStub), leader as any);
    expect(calls).toBe(2);
    expect(out.synthFailed).toBe(true);
  });

  it("greenfield input without brief → citation validator no-op (no retry)", async () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
    let calls = 0;
    const leader = {
      generate: vi.fn(async () => {
        calls += 1;
        return {
          content: JSON.stringify({
            primary: { value: "Muonroi.BaseTemplate", rationale: "generic but no brief to check" },
            alternatives: [],
          }),
          costUsd: 0.001,
        };
      }),
    };
    const out = await leaderRecommend(makeInput(), leader as any);
    expect(calls).toBe(1);
    expect(out.synthFailed).toBeUndefined();
  });
});
