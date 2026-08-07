/**
 * The council debate's OWN research phase previously had zero concept of web
 * capability — `researchWithFallback` ran `llm.research(primaryModel, …)` on
 * whatever model the caller passed, and its only recovery
 * (`pickDebateFallbackModel`) swaps PROVIDER on a crash, not web capability
 * on a text-only model. Session 947db934b573 researched on a native-web
 * model only by coincidence of panel composition — a panel seating a
 * text-only model would have researched blind, silently.
 *
 * `pickResearchWebModel` (debate.ts) closes that gap by applying the same
 * "owner's Part E rule" the other two call sites already follow (see
 * clarifier.ts:278-284/315-325, loop-driver.ts:606-641): prefer a reachable,
 * non-blocked native-web model; else Tavily; else warn — never research
 * silently blind. These tests pin the selection logic in isolation (mocked
 * registry + mcp-keychain) and the end-to-end composition with the existing
 * provider-crash fallback via the real `runDebate` generator (mirrors
 * debate-fallback.test.ts's "real runDebate + recording CouncilLLM" pattern).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "../../types/index.js";
import { pickResearchWebModel, runDebate } from "../debate.js";
import type { ClarifiedSpec, CouncilConfig, CouncilLLM, CouncilParticipant } from "../types.js";

const mockGetWebResearchModel = vi.fn();
const mockHasTavilyKey = vi.fn();

vi.mock("../../models/registry.js", () => ({
  // Forces detectProviderForModel (used by pickDebateFallbackModel) onto its
  // prefix-based fallback — same mechanism debate-fallback.test.ts and
  // provider-failure-blocklist.test.ts already rely on.
  getModelInfo: () => undefined,
  getWebResearchModel: (reachable: ReadonlySet<string>) => mockGetWebResearchModel(reachable),
}));

vi.mock("../../mcp/mcp-keychain.js", () => ({
  hasTavilyKey: () => mockHasTavilyKey(),
}));

beforeEach(() => {
  mockGetWebResearchModel.mockReset();
  mockHasTavilyKey.mockReset();
});

describe("pickResearchWebModel — selection", () => {
  it("prefers a reachable native-web model over the passed-in candidate model", async () => {
    mockGetWebResearchModel.mockImplementation((reachable: ReadonlySet<string>) =>
      reachable.has("web-native-model") ? { id: "web-native-model" } : undefined,
    );

    const llm = {} as CouncilLLM;
    const result = await pickResearchWebModel("text-only-candidate", ["web-native-model", "other-model"], llm);

    expect(result).toEqual({ model: "web-native-model", webTier: "native" });
    // The reachable set handed to getWebResearchModel is candidateModel + pool.
    const reachableArg = mockGetWebResearchModel.mock.calls[0]![0] as ReadonlySet<string>;
    expect(reachableArg.has("text-only-candidate")).toBe(true);
    expect(reachableArg.has("web-native-model")).toBe(true);
    expect(reachableArg.has("other-model")).toBe(true);
  });

  it("does not select a model blocked earlier this session, even though it is otherwise native-web", async () => {
    // Real registry behaviour: getWebResearchModel only returns a model that
    // is actually IN the reachable set it receives. pickResearchWebModel must
    // exclude the blocked id from that set before calling it.
    mockGetWebResearchModel.mockImplementation((reachable: ReadonlySet<string>) =>
      reachable.has("blocked-web-model") ? { id: "blocked-web-model" } : undefined,
    );
    mockHasTavilyKey.mockResolvedValue(false);

    const llm = {
      isModelBlocked: (modelId: string) => modelId === "blocked-web-model",
    } as unknown as CouncilLLM;

    const result = await pickResearchWebModel("candidate", ["blocked-web-model"], llm);

    // The blocked model was never even offered to getWebResearchModel, so it
    // falls through to the no-native-web branch (candidate kept, tier "none").
    expect(result).toEqual({ model: "candidate", webTier: "none" });
    const reachableArg = mockGetWebResearchModel.mock.calls[0]![0] as ReadonlySet<string>;
    expect(reachableArg.has("blocked-web-model")).toBe(false);
  });

  it("falls back to Tavily when no native-web model is reachable but a Tavily key is configured", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockHasTavilyKey.mockResolvedValue(true);

    const llm = {} as CouncilLLM;
    const result = await pickResearchWebModel("candidate", ["other-model"], llm);

    // Model is unchanged — candidate's own builtin web tools + the Tavily key
    // do the work; only the tier changes.
    expect(result).toEqual({ model: "candidate", webTier: "tavily" });
  });

  it("returns webTier 'none' (candidate unchanged) when neither native-web nor Tavily exist — caller must warn", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockHasTavilyKey.mockResolvedValue(false);

    const llm = {} as CouncilLLM;
    const result = await pickResearchWebModel("candidate", [], llm);

    expect(result).toEqual({ model: "candidate", webTier: "none" });
  });
});

// ---------------------------------------------------------------------------
// End-to-end composition through the real runDebate generator.
// ---------------------------------------------------------------------------

function makeSpec(): ClarifiedSpec {
  return {
    problemStatement: "Decide X vs Y for a small service.",
    constraints: [],
    successCriteria: [],
    scope: "",
    rawQA: [],
  } as unknown as ClarifiedSpec;
}

function makeConfig(participants: CouncilParticipant[]): CouncilConfig {
  return {
    topic: "X vs Y",
    conversationContext: "",
    leaderModelId: "deepseek-leader",
    participants,
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
    runId: "sess-debate-research-web-test",
  } as unknown as CouncilConfig;
}

const GOOD_TEXT = "Healthy debate turn.";

async function drainResearchMessage(gen: AsyncGenerator<StreamChunk, unknown, unknown>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  const researchMsg = chunks.find((c) => {
    const cm = (c as { councilMessage?: { kind?: string } }).councilMessage;
    return cm?.kind === "research";
  }) as { councilMessage?: { text?: string; speaker?: { model?: string } } } | undefined;
  return { chunks, researchMsg };
}

describe("runDebate research phase — web-capability routing (real generator)", () => {
  it("routes the initial research call to the reachable native-web model instead of the seated text-only participant", async () => {
    mockGetWebResearchModel.mockImplementation((reachable: ReadonlySet<string>) =>
      reachable.has("deepseek-leader") ? { id: "deepseek-leader" } : undefined,
    );
    mockHasTavilyKey.mockResolvedValue(false);

    const researchCalls: string[] = [];
    const llm = {
      generate: async () => GOOD_TEXT,
      debate: async () => ({ text: GOOD_TEXT, toolCalls: [] }),
      research: async (model: string) => {
        researchCalls.push(model);
        return "## Research Findings\n- routed correctly";
      },
    } as unknown as CouncilLLM;

    const participants = [
      { role: "research", model: "text-only-model", position: "", stance: { name: "research", lens: "evidence" } },
      { role: "architect", model: "deepseek-chat", position: "", stance: { name: "architect", lens: "design" } },
    ] as unknown as CouncilParticipant[];

    const gen = runDebate(makeSpec(), makeConfig(participants), llm);
    const { researchMsg } = await drainResearchMessage(gen);

    // The web-native leader model was used for the actual research call, not
    // the text-only participant that was seated in the "research" role.
    expect(researchCalls).toEqual(["deepseek-leader"]);
    expect(researchMsg?.councilMessage?.speaker?.model).toBe("deepseek-leader");
    // The participant's own role/model assignment for the REST of the debate
    // is untouched — only the research call was rerouted.
    expect(participants[0]!.model).toBe("text-only-model");
  });

  it("warns the user (content chunk) when neither a native-web model nor a Tavily key is reachable", async () => {
    mockGetWebResearchModel.mockReturnValue(undefined);
    mockHasTavilyKey.mockResolvedValue(false);

    const llm = {
      generate: async () => GOOD_TEXT,
      debate: async () => ({ text: GOOD_TEXT, toolCalls: [] }),
      research: async () => "## Research Findings\n- codebase only",
    } as unknown as CouncilLLM;

    const participants = [
      { role: "research", model: "text-only-model", position: "", stance: { name: "research", lens: "evidence" } },
      { role: "architect", model: "deepseek-chat", position: "", stance: { name: "architect", lens: "design" } },
    ] as unknown as CouncilParticipant[];

    const gen = runDebate(makeSpec(), makeConfig(participants), llm);
    const { chunks } = await drainResearchMessage(gen);

    const warning = chunks.find(
      (c) =>
        (c as { type?: string }).type === "content" &&
        typeof (c as { content?: string }).content === "string" &&
        (c as { content: string }).content.includes("no web-research-native model is reachable"),
    );
    expect(warning).toBeDefined();
  });

  it("does not break the existing provider-crash fallback: a web-selected model that crashes still recovers via a different-provider pooled model", async () => {
    // "web-native-model" is preferred by web-capability policy, but its
    // provider crashes for THIS call — pickDebateFallbackModel's existing
    // different-provider recovery must still kick in on top of the swap.
    mockGetWebResearchModel.mockImplementation((reachable: ReadonlySet<string>) =>
      reachable.has("opencode-web-native") ? { id: "opencode-web-native" } : undefined,
    );
    mockHasTavilyKey.mockResolvedValue(false);

    const RESEARCH_FAILED = "## Source Code Findings\n[Research failed: opencode-go overloaded]";
    const RESEARCH_OK = "## Source Code Findings\n- Found the render cascade in app.tsx.";
    const researchCalls: string[] = [];
    const llm = {
      generate: async () => GOOD_TEXT,
      debate: async () => ({ text: GOOD_TEXT, toolCalls: [] }),
      research: async (model: string) => {
        researchCalls.push(model);
        return model.startsWith("opencode") ? RESEARCH_FAILED : RESEARCH_OK;
      },
    } as unknown as CouncilLLM;

    // The research seat itself is a plain text-only model ("deepseek-research-seat")
    // — a THIRD participant seats the native-web model ("opencode-web-native")
    // so it's reachable (part of fallbackPool). pickResearchWebModel swaps the
    // research call onto it; the swapped model then crashes, and the existing
    // provider-crash fallback must still recover the turn.
    const participants = [
      {
        role: "research",
        model: "deepseek-research-seat",
        position: "",
        stance: { name: "research", lens: "evidence" },
      },
      { role: "helper", model: "opencode-web-native", position: "", stance: { name: "helper", lens: "web" } },
      { role: "architect", model: "deepseek-chat", position: "", stance: { name: "architect", lens: "design" } },
    ] as unknown as CouncilParticipant[];

    const config = {
      ...makeConfig(participants),
      leaderModelId: "deepseek-leader",
    } as unknown as CouncilConfig;

    const gen = runDebate(makeSpec(), config, llm);
    const { researchMsg } = await drainResearchMessage(gen);

    // The web-capable (but crash-prone) model was tried first, THEN a
    // different-provider fallback recovered the call.
    expect(researchCalls[0]).toBe("opencode-web-native");
    expect(researchCalls.some((m) => !m.startsWith("opencode"))).toBe(true);
    expect(researchMsg?.councilMessage?.text).toBe(RESEARCH_OK);
    expect(researchMsg?.councilMessage?.text).not.toContain("Research failed");
  });
});
