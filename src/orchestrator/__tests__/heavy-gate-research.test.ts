import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));

describe("heavy plan gate research dispatch (ea7378aab8f8)", () => {
  it.each([
    "main",
    "explore",
    "explore approved",
    "explore gate disabled",
  ])("respects plan authorization during %s research", async (scenario) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-gate-research-"));
    const cwd = process.cwd();
    const keys = ["HOME", "USERPROFILE", "MUONROI_EE_BASE_URL", "MUONROI_GSD_NATIVE", "MUONROI_GSD_HARD_GATE"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: false }));
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    process.env.MUONROI_GSD_NATIVE = "1";
    process.env.MUONROI_GSD_HARD_GATE = scenario === "explore gate disabled" ? "0" : "1";
    closeDatabase();
    await loadCatalog();
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: scenario.startsWith("explore")
          ? [
              toolCallStream({
                toolCallId: "shell-write",
                toolName: "bash",
                input: { command: "echo MUTATION > forbidden.ts" },
              }),
              textOnlyStream("RESEARCH_CONTINUES_WRITES_LOCKED"),
            ]
          : [
              toolCallStream({
                toolCallId: "research",
                toolName: "delegate",
                input: {
                  agent: "explore",
                  description: "Inspect context delivery",
                  prompt: "Identify bounded source evidence",
                },
              }),
              toolCallStream({
                toolCallId: "clarify",
                toolName: "ask_user",
                input: { question: "Which acceptance criterion?" },
              }),
              toolCallStream({
                toolCallId: "write",
                toolName: "write_file",
                input: { path: "forbidden.ts", content: "MUTATION" },
              }),
              textOnlyStream("RESEARCH_CONTINUES_WRITES_LOCKED"),
            ],
      },
    });
    const originalStream = handle.model.doStream.bind(handle.model);
    const streamSpy = vi.spyOn(handle.model, "doStream").mockImplementation(async (options) => {
      // Model-owned classification has already run. Seed the exact persisted
      // heavy/revise gate at the outbound boundary, before actual SDK dispatch.
      fs.mkdirSync(path.join(home, ".planning"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".planning", "STATE.md"),
        `| Field | Value |\n|---|---|\n| Phase | ${scenario === "explore approved" ? "execute" : "plan"} |\n| Depth | heavy |\n`,
      );
      fs.writeFileSync(
        path.join(home, ".planning", "PLAN-VERIFY.md"),
        `verdict: ${scenario === "explore approved" ? "pass" : "revise"}\n`,
      );
      return originalStream(options);
    });
    const agent = new Agent("test-key", undefined, "deepseek-v4-flash", 5, { persistSession: true });
    const delegation = vi
      .spyOn(agent as any, "runDelegation")
      .mockResolvedValue({ success: true, output: "RESEARCH_STARTED" });
    const clarification = vi.fn(async () => "Use isolated fixtures");
    agent.setAskUserHandler(clarification);
    try {
      const chunks: any[] = [];
      if (scenario.startsWith("explore")) {
        const result = await agent.runTaskRequest({
          agent: "explore",
          modelId: "deepseek-v4-flash",
          description: "Inspect source",
          prompt: "Inspect source evidence",
        });
        expect(result.success).toBe(true);
        const allowed = scenario !== "explore";
        expect(fs.existsSync(path.join(home, "forbidden.ts"))).toBe(allowed);
        expect(JSON.stringify(handle.model.doStreamCalls).includes("BLOCKED: this task")).toBe(!allowed);
        return;
      }
      for await (const chunk of agent.processMessage("Gather evidence before changing context enrichment"))
        chunks.push(chunk);
      expect(delegation).toHaveBeenCalledOnce();
      expect(clarification).toHaveBeenCalledOnce();
      const transcript = JSON.stringify(handle.model.doStreamCalls);
      expect(transcript).toContain("RESEARCH_STARTED");
      expect(transcript).toContain("Use isolated fixtures");
      expect(transcript).toContain("BLOCKED: this task");
      expect(fs.existsSync(path.join(home, "forbidden.ts"))).toBe(false);
      expect(fs.readFileSync(path.join(home, ".planning", "PLAN-VERIFY.md"), "utf8")).toBe("verdict: revise\n");
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
      expect(chunks.map((chunk) => chunk.content ?? "").join("")).toContain("RESEARCH_CONTINUES_WRITES_LOCKED");
    } finally {
      delegation.mockRestore();
      streamSpy.mockRestore();
      handle.uninstall();
      closeDatabase();
      process.chdir(cwd);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);
});
