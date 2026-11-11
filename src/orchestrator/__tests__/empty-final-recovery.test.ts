import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockModel, type StreamChunks, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { appendArtifactToDisk } from "../../ee/artifact-cache.js";
import { getModelIds, loadCatalog } from "../../models/registry.js";
import { ToolCallMarkupLeakError } from "../../providers/tool-markup-guard.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { Agent } from "../orchestrator.js";
import * as finalizer from "../scope-ceiling.js";

function reasoningOnly(): StreamChunks {
  return [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "I need to continue using tools." },
    { type: "reasoning-end", id: "r" },
    ...textOnlyStream("").filter((p) => p.type === "finish"),
  ];
}

describe("session81 empty main finalization", () => {
  let dir: string, previousCwd: string;
  let previousEnv: Record<string, string | undefined>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-empty-final-"));
    previousCwd = process.cwd();
    previousEnv = Object.fromEntries(
      ["HOME", "USERPROFILE", "MUONROI_EE_BASE_URL", "MUONROI_DISABLE_GROUNDING_CHECK"].map((key) => [
        key,
        process.env[key],
      ]),
    );
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    process.env.MUONROI_DISABLE_GROUNDING_CHECK = "1";
    fs.mkdirSync(path.join(dir, ".muonroi-cli"));
    fs.writeFileSync(path.join(dir, ".muonroi-cli/settings.json"), JSON.stringify({ routerSubSessions: false }));
    await appendArtifactToDisk("worker-proof", "bash", "CURRENT_TOOL_EVIDENCE");
    process.chdir(dir);
    closeDatabase();
    await loadCatalog();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  async function run(persistent: boolean, cap = 4, failure: "markup" | "empty" | "error" | "cancel" = "markup") {
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: [
          toolCallStream({
            toolCallId: "current-proof-read",
            toolName: "retrieve_tool_result",
            input: { tool_call_id: "worker-proof" },
          }),
          reasoningOnly(),
          persistent ? reasoningOnly() : textOnlyStream("VERIFIED_FINAL"),
        ],
      },
    });
    let agent: Agent;
    const finalize = vi.spyOn(finalizer, "forcedFinalize").mockImplementation(async () => {
      if (failure === "cancel") {
        agent.abort();
        throw new Error("caller cancelled");
      }
      if (failure === "empty") return { text: "" };
      if (failure === "error") throw new Error("fixture synthesis transport failure");
      throw new ToolCallMarkupLeakError("<tool_call><function=bash>not executed</function></tool_call>");
    });
    try {
      agent = new Agent("test-key", undefined, getModelIds()[0], cap, { persistSession: true });
      const id = agent.getSessionId()!;
      const chunks = [];
      for await (const chunk of agent.processMessage("Retrieve worker-proof and summarize its evidence."))
        chunks.push(chunk);
      const text = chunks
        .filter((c) => c.type === "content")
        .map((c) => c.content)
        .join("");
      const stored = JSON.stringify(
        getDatabase().prepare("select message_json from messages where session_id=?").all(id),
      );
      const events = getDatabase()
        .prepare("select event_type,metadata_json from interaction_logs where session_id=?")
        .all(id) as Array<{ event_type: string; metadata_json: string }>;
      return {
        text,
        stored,
        chunks,
        events,
        calls: handle.model.doStreamCalls.filter((c) => c.tools?.length),
        finalizeCalls: [...finalize.mock.calls],
      };
    } finally {
      handle.uninstall();
    }
  }
  it("recovers once without a user continue and keeps completed tool evidence", async () => {
    const result = await run(false);
    expect(result.text).toContain("VERIFIED_FINAL");
    expect(result.calls).toHaveLength(3);
    expect(JSON.stringify(result.calls[2].prompt)).toContain("CURRENT_TOOL_EVIDENCE");
    expect(JSON.stringify(result.finalizeCalls[0][0].messages)).toContain("CURRENT_TOOL_EVIDENCE");
    expect(
      result.chunks.filter((c) => c.type === "tool_result" && c.toolCall?.function.name === "retrieve_tool_result"),
    ).toHaveLength(1);
    expect(result.stored).toContain("VERIFIED_FINAL");
  }, 15000);
  it.each([
    "markup",
    "empty",
    "error",
  ] as const)("persists a visible incomplete notice after %s failure", async (failure) => {
    const result = await run(true, 4, failure);
    expect(result.text).toContain("Task incomplete:");
    expect(result.stored).toContain("Task incomplete:");
    expect(result.text).not.toContain("<tool_call>");
    expect(result.calls.length).toBeLessThanOrEqual(3);
    expect(result.events.some((e) => e.event_type === "final_answer_failure")).toBe(true);
  }, 15000);
  it("does not regain step budget by recovering after the cap", async () => {
    const result = await run(true, 2);
    expect(result.calls).toHaveLength(2);
    expect(result.text).toContain("Task incomplete:");
  }, 15000);
  it("carries spent steps into the one allowed recovery", async () => {
    const result = await run(true, 3);
    expect(result.calls).toHaveLength(3);
    expect(result.text).toContain("Task incomplete:");
    expect(result.events.filter((e) => e.event_type === "final_answer_recovery")).toHaveLength(1);
  }, 15000);
  it("does not recover or append a failure notice after user cancellation", async () => {
    const result = await run(true, 4, "cancel");
    expect(result.calls).toHaveLength(2);
    expect(result.text).not.toContain("Task incomplete:");
    expect(result.events.filter((e) => e.event_type === "final_answer_recovery")).toHaveLength(0);
  }, 15000);
});
