import { afterEach, describe, expect, it, vi } from "vitest";
import * as settings from "../../utils/settings.js";
import { executeToolEngine } from "../tool-engine.js";

vi.mock("../../council/leader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../council/leader.js")>()),
  getEffectiveCouncilRoleCount: () => 3,
}));

afterEach(() => vi.restoreAllMocks());

describe("leader owns council entry", () => {
  it("does not convene a council from PIL labels before the leader decides", async () => {
    vi.spyOn(settings, "isAutoCouncilEnabled").mockReturnValue(true);
    vi.spyOn(settings, "getAutoCouncilMinRoles").mockReturnValue(2);
    vi.spyOn(settings, "isAutoCouncilClarifyEnabled").mockReturnValue(false);
    let councils = 0;
    let leaderTurns = 0;
    const controller = new AbortController();
    const deps = {
      messages: [],
      session: null,
      modelId: "test-model",
      batchApi: true,
      getAbortController: () => controller,
      setAbortController: () => {},
      councilManager: {
        isContinuation: false,
        lastSynthesis: null,
        lastPostDebateAction: null,
        lastIntentKind: null,
        setLastSynthesis: () => {},
        setLastPostDebateAction: () => {},
        setLastIntentKind: () => {},
      },
      runCouncilV2: async function* () {
        councils++;
        yield { type: "done" };
      },
      processMessageBatchTurn: async function* () {
        leaderTurns++;
        yield { type: "done" };
      },
    };
    for await (const _chunk of executeToolEngine({
      deps,
      ownsController: false,
      signal: controller.signal,
      userMessage: "Review the architecture",
      system: "leader",
      runtime: {},
      pilCtx: {
        raw: "Review the architecture",
        enriched: "Review the architecture",
        taskType: "plan",
        confidence: 1,
        complexityTier: "heavy",
        gsdAutoCouncil: true,
      },
      userModelMessage: { role: "user", content: "Review the architecture" },
    })) {
      /* drain */
    }
    expect(councils).toBe(0);
    expect(leaderTurns).toBe(1);
  });
});
