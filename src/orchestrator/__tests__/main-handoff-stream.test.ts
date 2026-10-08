import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { createHeadlessJsonlEmitter } from "../../headless/output.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import * as settings from "../../utils/settings.js";
import { Agent } from "../orchestrator.js";
import * as stallWatchdog from "../stall-watchdog.js";

vi.mock("../../pil/llm-classify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pil/llm-classify.js")>()),
  classifySubSessionAction: async () => ({
    action: "SPAWN_SUB_SESSION",
    confidence: 0.98,
    reason: "controlled handoff",
  }),
}));

describe("main handoff with real MessageProcessor and mock SDK stream", () => {
  it.each([
    "slow",
    "wedged",
    "abort-ignored",
    "cancel",
    "mid-loop",
  ] as const)("handles %s acceptance without the generic turn watchdog", async (scenario) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-handoff-stall-"));
    const previousCwd = process.cwd();
    const envKeys = [
      "HOME",
      "USERPROFILE",
      "MUONROI_FORCE_ROUTING_CLASSIFY",
      "MUONROI_EE_BASE_URL",
      "MUONROI_TURN_IDLE_MS",
      "MUONROI_TURN_PROGRESS_PING_INTERVAL_MS",
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: true }));
    fs.writeFileSync(path.join(home, "evidence.txt"), "verified tool evidence");
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_FORCE_ROUTING_CLASSIFY = "1";
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    process.env.MUONROI_TURN_IDLE_MS = scenario === "mid-loop" ? "4000" : "150";
    process.env.MUONROI_TURN_PROGRESS_PING_INTERVAL_MS = "20";
    closeDatabase();
    await loadCatalog();
    const stallSpy = vi.spyOn(settings, "getProviderStallTimeoutMs").mockReturnValue(700);
    const progressSpy = vi.spyOn(settings, "getProviderProgressTimeoutMs").mockReturnValue(2000);
    const backoffSpy = vi.spyOn(stallWatchdog, "stallRepromptBackoffMs").mockReturnValue(20);
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: [
          textOnlyStream("HELPER_EVIDENCE"),
          ...(scenario === "mid-loop"
            ? [
                toolCallStream({
                  toolCallId: "evidence-read",
                  toolName: "read_file",
                  input: { file_path: path.join(home, "evidence.txt") },
                }),
              ]
            : []),
          textOnlyStream("MAIN_FINAL"),
        ],
      },
    });
    const original = handle.model.doStream.bind(handle.model);
    let mainCalls = 0;
    let agent: Agent;
    let resumedWithToolResult = false;
    const doStreamSpy = vi.spyOn(handle.model, "doStream").mockImplementation(async (options) => {
      const main = JSON.stringify(options.prompt).includes("[Helper receipt:") && !!options.tools?.length;
      if (main) {
        mainCalls++;
        if (scenario === "mid-loop" && mainCalls === 2) return await new Promise<never>(() => {});
        if (scenario === "mid-loop" && mainCalls === 3)
          resumedWithToolResult = JSON.stringify(options.prompt).includes("verified tool evidence");
        if (scenario === "cancel") {
          setTimeout(() => agent.abort(), 50);
          return await new Promise<never>(() => {});
        }
        if (scenario === "abort-ignored") return await new Promise<never>(() => {});
        if (scenario === "wedged" && mainCalls === 1) {
          return await new Promise<never>((_, reject) => {
            const abort = () => reject(options.abortSignal!.reason);
            if (options.abortSignal!.aborted) abort();
            else options.abortSignal!.addEventListener("abort", abort, { once: true });
          });
        }
        if (scenario === "slow") await new Promise((resolve) => setTimeout(resolve, 500));
        const parts =
          scenario === "mid-loop" && mainCalls === 1
            ? toolCallStream({
                toolCallId: "evidence-read",
                toolName: "read_file",
                input: { file_path: path.join(home, "evidence.txt") },
              })
            : textOnlyStream("MAIN_FINAL");
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      }
      return original(options);
    });
    try {
      agent = new Agent("test-key", undefined, "deepseek-v4-flash", 2, { persistSession: true });
      const parentId = agent.getSessionId()!;
      const chunks = [];
      const emitter = createHeadlessJsonlEmitter(parentId);
      let jsonOutput = "";
      for await (const c of agent.processMessage("What is the sum of two and two?", emitter.observer)) {
        chunks.push(c);
        jsonOutput += emitter.consumeChunk(c).stdout ?? "";
      }
      jsonOutput += emitter.flush().stdout ?? "";
      const errors = chunks
        .filter((c) => c.type === "error")
        .map((c) => c.content)
        .join("\n");
      expect(errors).not.toContain("Turn ended by watchdog");
      expect(agent.getSessionId()).toBe(parentId);
      expect((agent as unknown as { abortController: AbortController | null }).abortController).toBeNull();
      if (scenario === "cancel") {
        expect(mainCalls).toBe(1);
        expect(
          chunks
            .filter((c) => c.type === "content")
            .map((c) => c.content)
            .join(""),
        ).toContain("Cancelled");
      } else if (scenario === "abort-ignored") {
        expect(errors).toContain("Model not responding");
        expect(mainCalls).toBe(2);
      } else {
        expect(
          chunks
            .filter((c) => c.type === "content")
            .map((c) => c.content)
            .join(""),
        ).toContain("MAIN_FINAL");
        expect(jsonOutput).toContain("MAIN_FINAL");
        expect(mainCalls).toBe(scenario === "mid-loop" ? 3 : scenario === "wedged" ? 2 : 1);
        if (scenario === "mid-loop") {
          expect(resumedWithToolResult).toBe(true);
          expect(
            chunks.filter((c) => c.type === "tool_result" && c.toolCall?.function.name === "read_file"),
          ).toHaveLength(1);
        }
      }
      expect(
        JSON.stringify(getDatabase().prepare("SELECT message_json FROM messages WHERE session_id=?").all(parentId)),
      ).toContain("Helper receipt");
    } finally {
      doStreamSpy.mockRestore();
      stallSpy.mockRestore();
      progressSpy.mockRestore();
      backoffSpy.mockRestore();
      handle.uninstall();
      closeDatabase();
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15_000);

  it("streams main's own answer after isolated helper evidence", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-handoff-stream-"));
    const previousCwd = process.cwd();
    const previousEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      MUONROI_FORCE_ROUTING_CLASSIFY: process.env.MUONROI_FORCE_ROUTING_CLASSIFY,
      MUONROI_EE_BASE_URL: process.env.MUONROI_EE_BASE_URL,
    };
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: true }));
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_FORCE_ROUTING_CLASSIFY = "1";
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    closeDatabase();
    await loadCatalog();
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: [
          textOnlyStream("HELPER_EVIDENCE: the value is four."),
          textOnlyStream("MAIN_FINAL: verified answer is four."),
        ],
      },
    });
    try {
      const agent = new Agent("test-key", undefined, "deepseek-v4-flash", 2, { persistSession: true });
      const parentId = agent.getSessionId()!;
      const chunks = [];
      for await (const chunk of agent.processMessage("What is the sum of two and two?")) chunks.push(chunk);
      const output = chunks
        .filter((c) => c.type === "content")
        .map((c) => c.content ?? "")
        .join("");
      expect(output).toContain("MAIN_FINAL");
      expect(output).not.toContain("HELPER_EVIDENCE");
      expect(agent.getSessionId()).toBe(parentId);
      const rows = getDatabase().prepare("SELECT message_json FROM messages WHERE session_id = ?").all(parentId);
      expect(JSON.stringify(rows)).toContain("Helper receipt");
      expect(JSON.stringify(rows)).toContain("MAIN_FINAL");
    } finally {
      handle.uninstall();
      closeDatabase();
      process.chdir(previousCwd);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30_000);
});
