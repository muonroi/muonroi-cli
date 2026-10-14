/**
 * Regression cover for the "answer cut off mid-sentence" report: the main turn
 * ended with finishReason "length" and the tool engine accepted it as a
 * finished turn — no notice, no continuation. Drives the REAL MessageProcessor
 * + tool engine against a mock SDK stream.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMockModel, type StreamChunks, textOnlyStream } from "../../agent-harness/mock-model.js";
import { getModelInfo, loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import type { StreamChunk } from "../../types/index.js";
import { Agent } from "../orchestrator.js";
import { resolveTurnMaxOutputTokens } from "../tool-engine.js";

// Test fixture: a catalog reasoning model with a declared output ceiling.
const MODEL_ID = "deepseek-v4-flash";
const CUT = "Điểm mấu chốt nhất: probe vẫn 429 sau 2.6–";
const REST = "3 giây, nên giới hạn nằm ở phía nhà cung cấp.";

/** A text stream whose provider stopped on the output-token limit. */
function lengthStream(text: string): StreamChunks {
  const parts = textOnlyStream(text);
  const finish = parts[parts.length - 1] as { finishReason: unknown };
  finish.finishReason = { unified: "length" as const, raw: "length" };
  return parts;
}

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "MUONROI_EE_BASE_URL",
  "MUONROI_FORCE_ROUTING_CLASSIFY",
  "MUONROI_OUTPUT_LIMIT_CONTINUATIONS",
  "MUONROI_DISABLE_GROUNDING_CHECK",
];

describe("main turn output-token limit", () => {
  let home: string;
  let previousCwd: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-output-limit-"));
    previousCwd = process.cwd();
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    fs.mkdirSync(path.join(home, ".muonroi-cli"));
    fs.writeFileSync(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: false }));
    process.chdir(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
    process.env.MUONROI_DISABLE_GROUNDING_CHECK = "1";
    delete process.env.MUONROI_FORCE_ROUTING_CLASSIFY;
    delete process.env.MUONROI_OUTPUT_LIMIT_CONTINUATIONS;
    closeDatabase();
    await loadCatalog();
  });

  afterEach(() => {
    closeDatabase();
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function run(stream: StreamChunks[]) {
    const handle = installMockModel({ fixture: { autoClassify: true, stream } });
    try {
      const agent = new Agent("test-key", undefined, MODEL_ID, 3, { persistSession: true });
      const sessionId = agent.getSessionId()!;
      const chunks: StreamChunk[] = [];
      for await (const chunk of agent.processMessage("Viết báo cáo chi tiết về lỗi 429.")) chunks.push(chunk);
      const content = chunks
        .filter((c) => c.type === "content")
        .map((c) => c.content)
        .join("");
      const stored = JSON.stringify(
        getDatabase().prepare("SELECT message_json FROM messages WHERE session_id=? ORDER BY seq").all(sessionId),
      );
      const mainCalls = handle.model.doStreamCalls.filter((call) => call.tools?.length);
      return { chunks, content, stored, mainCalls };
    } finally {
      handle.uninstall();
    }
  }

  it("sizes a reasoning model's main-turn budget from its catalog ceiling, not the bare taskType budget", async () => {
    const { mainCalls } = await run([textOnlyStream("OK")]);
    const ceiling = getModelInfo(MODEL_ID)?.maxOutputTokens;
    expect(getModelInfo(MODEL_ID)?.reasoning).toBe(true);
    expect(ceiling).toBeGreaterThan(resolveTurnMaxOutputTokens({ taskType: null }));
    expect(mainCalls[0]?.maxOutputTokens).toBeGreaterThanOrEqual(ceiling!);
  }, 15_000);

  it("auto-continues a reply cut by the output limit from the exact cut point", async () => {
    const { chunks, content, stored, mainCalls } = await run([lengthStream(CUT), textOnlyStream(REST)]);
    expect(chunks.filter((c) => c.type === "error")).toEqual([]);
    expect(chunks.filter((c) => c.type === "done")).toHaveLength(1);
    expect(mainCalls).toHaveLength(2);
    // The continuation request quotes the cut tail so the model resumes there.
    const resumePrompt = JSON.stringify(mainCalls[1]!.prompt);
    expect(resumePrompt).toContain("[Output limit]");
    expect(resumePrompt).toContain("2.6–");
    // The user sees the cut text immediately followed by the rest, no notice.
    expect(content).toContain(`${CUT}${REST}`);
    expect(content).not.toContain("Reply cut off");
    expect(stored).toContain(CUT);
    expect(stored).toContain(REST);
  }, 15_000);

  it("appends a visible, persisted notice once continuations are exhausted", async () => {
    process.env.MUONROI_OUTPUT_LIMIT_CONTINUATIONS = "0";
    const { content, stored, mainCalls } = await run([lengthStream(CUT)]);
    expect(mainCalls).toHaveLength(1);
    expect(content).toContain(CUT);
    expect(content).toContain("Reply cut off: the model reached its output-token limit");
    // Persisted too — the TUI re-renders the transcript from the DB at turn end.
    expect(stored).toContain("Reply cut off");
  }, 15_000);

  it("stops after the per-turn continuation cap and then shows the notice", async () => {
    process.env.MUONROI_OUTPUT_LIMIT_CONTINUATIONS = "1";
    const { content, mainCalls } = await run([lengthStream(CUT), lengthStream(REST)]);
    expect(mainCalls).toHaveLength(2);
    expect(content).toContain(`${CUT}${REST}`);
    expect(content).toContain("after 1 automatic continuation");
  }, 15_000);
});
