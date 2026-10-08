import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import type { PipelineContext } from "../../pil/types.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import type { StreamChunk } from "../../types/index.js";
import * as settings from "../../utils/settings.js";
import { __resetCouncilConveneForTests } from "../council-request.js";
import { Agent } from "../orchestrator.js";

const mocks = vi.hoisted(() => ({ pipeline: vi.fn() }));
vi.mock("../../pil/pipeline.js", () => ({ runPipeline: mocks.pipeline }));
vi.mock("../../council/leader.js", async (original) => ({
  ...(await original<typeof import("../../council/leader.js")>()),
  getEffectiveCouncilRoleCount: () => 3,
}));

const raw = "Review this design and give your recommendation.";
const info: PipelineContext = {
  raw,
  enriched: `${raw} SERVER_SUPPLEMENT`,
  taskType: "plan",
  domain: null,
  confidence: 1,
  tokenBudget: 500,
  outputStyle: null,
  metrics: null,
  layers: [],
  gsdAutoCouncil: true,
  modelDepthTier: "heavy",
};

describe("main streaming with optional background PIL", () => {
  it.each([
    "never responds",
    "slow",
    "failed",
    "fast",
    "leader council",
  ])("keeps main ownership when PIL is %s", async (scenario) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-background-pil-"));
    const previousCwd = process.cwd();
    const envKeys = ["HOME", "USERPROFILE", "MUONROI_EE_BASE_URL", "MUONROI_FORCE_ROUTING_CLASSIFY"];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: false }));
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    delete process.env.MUONROI_FORCE_ROUTING_CLASSIFY;
    closeDatabase();
    await loadCatalog();
    __resetCouncilConveneForTests();
    const councilEnabled = vi.spyOn(settings, "isAutoCouncilEnabled").mockReturnValue(true);
    const minRoles = vi.spyOn(settings, "getAutoCouncilMinRoles").mockReturnValue(2);
    let resolvePil!: (ctx: PipelineContext) => void;
    let pilSettled = false;
    mocks.pipeline.mockReset().mockImplementation(async () => {
      if (scenario === "failed") throw new Error("server unavailable");
      if (scenario === "fast") {
        pilSettled = true;
        return info;
      }
      return await new Promise<PipelineContext>((resolve) => {
        resolvePil = resolve;
      });
    });
    const controlTool =
      scenario === "leader council" ? "convene_council" : scenario === "fast" ? "read_pil_context" : null;
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: [
          ...(controlTool
            ? [
                toolCallStream({
                  toolCallId: "leader-control",
                  toolName: controlTool,
                  input: controlTool === "convene_council" ? { reason: "Conflicting design tradeoffs" } : {},
                }),
              ]
            : []),
          textOnlyStream("MAIN_FINAL"),
        ],
      },
    });
    const originalStream = handle.model.doStream.bind(handle.model);
    const streamSpy = vi.spyOn(handle.model, "doStream").mockImplementation(async (options) => {
      if (scenario === "fast" && options.tools?.some((tool) => tool.name === "read_pil_context")) {
        await vi.waitFor(() => expect(mocks.pipeline).toHaveBeenCalled());
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return await originalStream(options);
    });
    const agent = new Agent("test-key", undefined, "deepseek-v4-flash", 3, { persistSession: true });
    const parentId = agent.getSessionId()!;
    const councilSpy = vi.spyOn(agent, "runCouncilV2").mockImplementation(async function* (_message, opts) {
      expect(opts).toMatchObject({ suppressPreDebateCards: true, suppressPostDebate: true, skipPil: true });
      (
        agent as unknown as { councilManager: { setLastSynthesis(value: string): void } }
      ).councilManager.setLastSynthesis("COUNCIL_EVIDENCE");
      yield { type: "content", content: "COUNCIL_EVIDENCE" };
      yield { type: "done" };
    });
    try {
      const chunks: StreamChunk[] = [];
      for await (const chunk of agent.processMessage(raw)) chunks.push(chunk);
      expect(chunks.filter((c) => c.type === "error")).toEqual([]);
      expect(
        chunks
          .filter((c) => c.type === "content")
          .map((c) => c.content)
          .join(""),
      ).toContain("MAIN_FINAL");
      expect(chunks.filter((c) => c.type === "done")).toHaveLength(1);
      expect(agent.getSessionId()).toBe(parentId);
      expect((agent as unknown as { abortController: unknown }).abortController).toBeNull();
      expect(councilSpy).toHaveBeenCalledTimes(scenario === "leader council" ? 1 : 0);
      if (scenario === "slow" || scenario === "never responds" || scenario === "leader council") {
        expect(pilSettled).toBe(false);
        if (resolvePil) {
          resolvePil({ ...info, enriched: "STALE_AFTER_MAIN_FINISHED" });
          pilSettled = true;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const rows = getDatabase()
        .prepare("SELECT message_json FROM messages WHERE session_id=? ORDER BY seq")
        .all(parentId) as { message_json: string }[];
      const stored = JSON.stringify(rows);
      expect(stored).toContain(raw);
      expect(stored).not.toContain("STALE_AFTER_MAIN_FINISHED");
      const calls = handle.model.doStreamCalls.filter((call) => call.tools?.length);
      const userContent = calls[0].prompt.find((message) => message.role === "user")?.content;
      expect(JSON.stringify(userContent)).toContain(raw);
      expect(JSON.stringify(userContent)).not.toContain("SERVER_SUPPLEMENT");
      if (scenario === "fast") {
        expect(stored).toContain("SERVER_SUPPLEMENT");
        expect(JSON.stringify(calls[calls.length - 1].prompt)).toContain("SERVER_SUPPLEMENT");
      }
      if (scenario === "leader council")
        expect(JSON.stringify(calls[calls.length - 1].prompt)).toContain("COUNCIL_EVIDENCE");
    } finally {
      councilSpy.mockRestore();
      streamSpy.mockRestore();
      councilEnabled.mockRestore();
      minRoles.mockRestore();
      handle.uninstall();
      closeDatabase();
      __resetCouncilConveneForTests();
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);
});
