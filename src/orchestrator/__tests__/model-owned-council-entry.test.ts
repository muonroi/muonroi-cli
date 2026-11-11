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
    const startCouncil = vi.fn(async () => ({ success: true, output: "Unexpected background council" }));
    const controller = new AbortController();
    const deps = {
      messages: [],
      session: null,
      executionRole: "orchestrator" as const,
      bash: { getCwd: () => process.cwd() },
      modelId: "test-model",
      batchApi: true,
      startCouncil,
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
        flowAutoCouncil: true,
      },
      userModelMessage: { role: "user", content: "Review the architecture" },
    })) {
      /* drain */
    }
    expect(councils).toBe(0);
    expect(startCouncil).not.toHaveBeenCalled();
    expect(leaderTurns).toBe(1);
  });
});
