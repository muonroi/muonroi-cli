/**
 * Two research paths, one decision.
 *
 * Before `research-mode.ts` they disagreed about the same question:
 * `index.ts:977` decided `internetFirst` from `projectInfo.isEmpty` ("is the
 * repo empty?") while `clarifier.ts:358` decided it from `webTier !== "none"`
 * ("do we have a web tier?"). Both now resolve through `decideInternetFirst` at
 * the call site, where the accurate, blocklist-aware web tier is known.
 *
 * These are CALL-SITE pins: each drives the real generator and asserts on the
 * options bag that `llm.research` / the isolated task actually receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { researchScopeForClarification } from "../clarifier.js";
import { runDebate } from "../debate.js";
import { decideInternetFirst } from "../research-mode.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant } from "../types.js";

const mockGetWebResearchModel = vi.fn();
const mockHasTavilyKey = vi.fn();
const mockGetMcpKey = vi.fn();

vi.mock("../../models/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../models/registry.js")>()),
  // Forces detectProviderForModel onto its prefix fallback — same mechanism
  // debate-research-web-capability.test.ts relies on.
  getModelInfo: () => undefined,
  getWebResearchModel: (reachable: ReadonlySet<string>) => mockGetWebResearchModel(reachable),
}));

vi.mock("../../mcp/mcp-keychain.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../mcp/mcp-keychain.js")>()),
  hasTavilyKey: () => mockHasTavilyKey(),
  getMcpKey: (id: string) => mockGetMcpKey(id),
}));

beforeEach(() => {
  mockGetWebResearchModel.mockReset();
  mockHasTavilyKey.mockReset();
  mockGetMcpKey.mockReset();
  // clarifier.ts's local hasTavilyKey falls back to the RAW env var when
  // getMcpKey yields nothing — a developer machine with a real TAVILY_API_KEY
  // would otherwise make the "no web capability" cases unreachable.
  vi.stubEnv("TAVILY_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Decide X vs Y for a small service.",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function participants(): CouncilParticipant[] {
  return [
    { role: "research", model: "text-only-model", position: "", stance: { name: "research", lens: "evidence" } },
    { role: "architect", model: "deepseek-chat", position: "", stance: { name: "architect", lens: "design" } },
  ] as unknown as CouncilParticipant[];
}

function makeConfig(repoIsEmpty: boolean): CouncilConfig {
  return {
    topic: "X vs Y",
    conversationContext: "",
    leaderModelId: "deepseek-leader",
    participants: participants(),
    debatePlan: {
      intentSummary: "Pick the better option.",
      stances: [
        { name: "architect", lens: "design" },
        { name: "qa", lens: "risk" },
      ],
      outputShape: {
        kind: "decision",
        sections: [{ key: "rec", heading: "Recommendation", shape: "list" }],
        guardrails: [],
      },
      plannedRounds: 1,
    },
    researchSkipOverride: false,
    leaderNeedsResearch: true,
    repoIsEmpty,
    runId: "sess-research-mode-agreement",
  } as unknown as CouncilConfig;
}

const GOOD_TEXT = "Healthy debate turn.";

/** Drives the real runDebate generator; returns the options bag research got. */
async function debateResearchOptions(repoIsEmpty: boolean): Promise<{ internetFirst?: boolean } | undefined> {
  let captured: { internetFirst?: boolean } | undefined;
  const llm = {
    generate: async () => GOOD_TEXT,
    debate: async () => ({ text: GOOD_TEXT, toolCalls: [] }),
    research: async (
      _model: string,
      _topic: string,
      _ctx: string,
      _signal: unknown,
      _trace: unknown,
      options?: { internetFirst?: boolean },
    ) => {
      captured ??= options;
      return "## Research Findings\n- ok";
    },
  } as unknown as CouncilLLM;

  const gen = runDebate(makeSpec(), makeConfig(repoIsEmpty), llm) as AsyncGenerator<StreamChunk, unknown, unknown>;
  for await (const _chunk of gen) {
    /* drain */
  }
  return captured;
}

/** Drives the real clarifier scope-research generator; returns the same bag. */
async function clarifierResearchOptions(repoIsEmpty: boolean): Promise<{ internetFirst?: boolean } | undefined> {
  let captured: { internetFirst?: boolean } | undefined;
  const llm = {
    research: async (
      _model: string,
      _topic: string,
      _ctx: string,
      _signal: unknown,
      _trace: unknown,
      options?: { internetFirst?: boolean },
    ) => {
      captured = options;
      return "brief";
    },
  } as unknown as CouncilLLM;

  const gen = researchScopeForClarification("narrow this", "", "leader", llm, undefined, [], repoIsEmpty);
  for await (const _chunk of gen) {
    /* drain */
  }
  return captured;
}

describe("CALL SITE — council debate research resolves the mode, not runCouncilV2", () => {
  it("empty repo + NO web capability → codebase-first (no self-contradicting prompt)", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockHasTavilyKey.mockResolvedValue(false);
    expect((await debateResearchOptions(true))?.internetFirst).toBe(false);
  });

  it("empty repo + a Tavily key → internet-first", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockHasTavilyKey.mockResolvedValue(true);
    expect((await debateResearchOptions(true))?.internetFirst).toBe(true);
  });

  it("repo WITH source + a Tavily key → codebase-first", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockHasTavilyKey.mockResolvedValue(true);
    expect((await debateResearchOptions(false))?.internetFirst).toBe(false);
  });
});

describe("CALL SITE — clarifier scope research follows the identical rule", () => {
  it("repo WITH source + a Tavily key → codebase-first (was internet-first)", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockGetMcpKey.mockResolvedValue("tavily-key-that-is-long-enough");
    expect((await clarifierResearchOptions(false))?.internetFirst).toBe(false);
  });

  it("empty repo + a Tavily key → internet-first", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockGetMcpKey.mockResolvedValue("tavily-key-that-is-long-enough");
    expect((await clarifierResearchOptions(true))?.internetFirst).toBe(true);
  });

  it("empty repo + NO web capability → codebase-first", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockGetMcpKey.mockResolvedValue("");
    expect((await clarifierResearchOptions(true))?.internetFirst).toBe(false);
  });
});

describe("the two paths agree across the whole input space", () => {
  it("debate and clarifier produce the same verdict for every (webCapable, repoIsEmpty)", async () => {
    for (const repoIsEmpty of [true, false]) {
      for (const webCapable of [true, false]) {
        mockGetWebResearchModel.mockReturnValue(undefined);
        mockHasTavilyKey.mockResolvedValue(webCapable);
        mockGetMcpKey.mockResolvedValue(webCapable ? "tavily-key-that-is-long-enough" : "");

        const fromDebate = (await debateResearchOptions(repoIsEmpty))?.internetFirst;
        const fromClarifier = (await clarifierResearchOptions(repoIsEmpty))?.internetFirst;

        expect({ webCapable, repoIsEmpty, fromDebate }).toEqual({
          webCapable,
          repoIsEmpty,
          fromDebate: fromClarifier,
        });
        expect(fromDebate).toBe(decideInternetFirst({ webCapable, repoIsEmpty }));
      }
    }
  });
});
