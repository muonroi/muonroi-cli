import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dynamicTool, jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { noteCouncilStreamDelta } from "../../council/llm.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import * as settings from "../../utils/settings.js";
import { Agent } from "../orchestrator.js";
import { __resetToolActivityForTests } from "../tool-activity.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));
// Isolate the workflow policy; retain the real SDK tool execution and council bridge.
vi.mock("../../gsd/workflow-tools.js", () => ({
  registerGsdWorkflowTools: (tools: any, opts: any) => {
    tools.gsd_status = dynamicTool({
      description: "Read workflow status",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: async () => "PLAN_READY",
    });
    tools.gsd_plan_review = dynamicTool({
      description: "Review the plan",
      inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      execute: async (_input, context) => opts.runDebate("Review this plan", context.abortSignal),
    });
  },
}));

describe("nested plan review liveness (ea7378aab8f8)", () => {
  it.each([
    "slow",
    "slow continuation",
    "streaming",
    "overdue",
    "cancelled",
  ])("handles a %s council without orphaning the tool", async (scenario) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-nested-council-"));
    const cwd = process.cwd();
    const keys = [
      "HOME",
      "USERPROFILE",
      "MUONROI_EE_BASE_URL",
      "MUONROI_TOOL_ACTIVITY_MAX_MS",
      "MUONROI_TOOL_ACTIVITY_GRACE_MS",
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: false }));
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    process.env.MUONROI_TOOL_ACTIVITY_MAX_MS = "500";
    process.env.MUONROI_TOOL_ACTIVITY_GRACE_MS = "1";
    closeDatabase();
    await loadCatalog();
    const idle = vi.spyOn(settings, "getProviderStallTimeoutMs").mockReturnValue(100);
    const progress = vi.spyOn(settings, "getProviderProgressTimeoutMs").mockReturnValue(150);
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: [
          ...(scenario === "slow continuation"
            ? [toolCallStream({ toolCallId: "status", toolName: "gsd_status", input: {} })]
            : []),
          toolCallStream({ toolCallId: "plan-review", toolName: "gsd_plan_review", input: {} }),
          textOnlyStream("IMPLEMENTATION_CONTINUES"),
        ],
      },
    });
    const originalStream = handle.model.doStream.bind(handle.model);
    let delayedContinuation = 0;
    const streamSpy = vi.spyOn(handle.model, "doStream").mockImplementation(async (options) => {
      const response = await originalStream(options);
      if (scenario !== "slow continuation" || !options.prompt.some((message) => message.role === "tool"))
        return response;
      return {
        ...response,
        stream: response.stream.pipeThrough(
          new TransformStream({
            async transform(part, controller) {
              if (part.type === "text-start") {
                delayedContinuation++;
                controller.enqueue({ type: "reasoning-start", id: "after-tool" });
                for (let i = 0; i < 4; i++) {
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  controller.enqueue({ type: "reasoning-delta", id: "after-tool", delta: "Checking the result" });
                }
                controller.enqueue({ type: "reasoning-end", id: "after-tool" });
              }
              controller.enqueue(part);
            },
          }),
        ),
      };
    });
    const agent = new Agent("test-key", undefined, "deepseek-v4-flash", 3, { persistSession: true });
    let councilStarted = false;
    let childSignal: AbortSignal | undefined;
    let lateWrite = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let workTimer: ReturnType<typeof setTimeout> | undefined;
    let deltaTimer: ReturnType<typeof setInterval> | undefined;
    const council = vi.spyOn(agent, "runCouncilV2").mockImplementation(async function* (_topic, opts) {
      councilStarted = true;
      childSignal = (opts as { abortSignal?: AbortSignal })?.abortSignal;
      if (scenario === "cancelled") cancelTimer = setTimeout(() => agent.abort(), 30);
      if (scenario === "streaming") deltaTimer = setInterval(() => noteCouncilStreamDelta(1), 80);
      await new Promise<void>((resolve) => {
        workTimer = setTimeout(
          resolve,
          scenario === "slow continuation" ? 400 : scenario === "slow" ? 250 : scenario === "streaming" ? 1100 : 850,
        );
        childSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(workTimer);
            resolve();
          },
          { once: true },
        );
      });
      clearInterval(deltaTimer);
      if (childSignal?.aborted) return;
      lateWrite = true;
      (agent as any).councilManager.setLastSynthesis("PLAN_REVIEW_READY");
      yield { type: "content", content: "PLAN_REVIEW_READY" };
    });
    try {
      const chunks: any[] = [];
      for await (const chunk of agent.processMessage("Review the migration plan and continue implementation"))
        chunks.push(chunk);
      expect(councilStarted).toBe(true);
      if (scenario === "slow continuation") expect(delayedContinuation).toBeGreaterThan(0);
      const transcriptAtEnd = JSON.stringify(
        getDatabase()
          .prepare("SELECT message_json FROM messages WHERE session_id=? ORDER BY seq")
          .all(agent.getSessionId()),
      );
      if (scenario.startsWith("slow") || scenario === "streaming") {
        expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([]);
        expect(chunks.map((chunk) => chunk.content ?? "").join("")).toContain("IMPLEMENTATION_CONTINUES");
        expect(lateWrite).toBe(true);
      } else {
        expect(childSignal?.aborted).toBe(true);
        if (scenario === "overdue")
          expect(
            chunks.some((chunk) => chunk.type === "error" && chunk.content.includes("Tool execution exceeded")),
          ).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(lateWrite).toBe(false);
        expect(
          JSON.stringify(
            getDatabase()
              .prepare("SELECT message_json FROM messages WHERE session_id=? ORDER BY seq")
              .all(agent.getSessionId()),
          ),
        ).toBe(transcriptAtEnd);
      }
    } finally {
      clearTimeout(cancelTimer);
      clearTimeout(workTimer);
      clearInterval(deltaTimer);
      council.mockRestore();
      idle.mockRestore();
      progress.mockRestore();
      streamSpy.mockRestore();
      handle.uninstall();
      closeDatabase();
      __resetToolActivityForTests();
      process.chdir(cwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);
});
