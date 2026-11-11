import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildElidedArgsInput } from "../../orchestrator/subagent-compactor.js";
import { closeDatabase, getDatabase } from "../db.js";
import { appendMessages, persistToolCallWriteAhead } from "../transcript.js";

const sessionId = "compaction-evidence-fixture";
const callId = "durable-original-call";

describe("durable tool evidence across compacted history appends", () => {
  let home: string;
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    closeDatabase();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-compaction-evidence-"));
    savedEnv = Object.fromEntries(["HOME", "USERPROFILE", "MUONROI_CLI_HOME"].map((k) => [k, process.env[k]]));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_CLI_HOME = path.join(home, ".muonroi-cli");
    getDatabase().exec(`
      INSERT INTO workspaces(id,scope_key,canonical_path,display_name,last_seen_at)
      VALUES('evidence-ws','evidence-ws','/fixture','fixture','2026-10-16T00:00:00Z');
      INSERT INTO sessions(id,workspace_id,title,model,mode,cwd_at_start,cwd_last,status,created_at,updated_at)
      VALUES('${sessionId}','evidence-ws','fixture','fixture-model','agent','/fixture','/fixture','active','2026-10-16T00:00:00Z','2026-10-16T00:00:00Z');
    `);
  });
  afterEach(() => {
    closeDatabase();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
      console.error("Compaction evidence fixture cleanup failed:", error);
    }
  });

  const assistant = (input: unknown): ModelMessage =>
    ({
      role: "assistant",
      content: [{ type: "tool-call", toolName: "bash", toolCallId: callId, input }],
    }) as ModelMessage;
  const result = (value: string): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolName: "bash", toolCallId: callId, output: { type: "text", value } }],
  });

  it("does not overwrite captured arguments with a compaction marker", () => {
    const original = JSON.stringify({ command: "echo retained-original-command" });
    persistToolCallWriteAhead(sessionId, 0, callId, "bash", original);
    appendMessages(sessionId, [assistant(buildElidedArgsInput(500))]);
    const row = getDatabase().prepare("SELECT args_json, status FROM tool_calls WHERE tool_call_id=?").get(callId) as {
      args_json: string;
      status: string;
    };
    expect(row.args_json).toBe(original);
    expect(row.status).toBe("completed");
  });

  it("does not overwrite stored results with a compactor stub", () => {
    appendMessages(sessionId, [assistant({ command: "echo original" }), result("original-result-evidence")]);
    appendMessages(sessionId, [
      result(
        `[earlier tool_result for tool=bash (id=${callId}) — 500 chars elided by sub-agent compactor; output: preview]`,
      ),
    ]);
    const row = getDatabase()
      .prepare(
        "SELECT output_json FROM tool_results tr JOIN tool_calls tc ON tc.id=tr.tool_call_row_id WHERE tc.tool_call_id=?",
      )
      .get(callId) as { output_json: string };
    expect(row.output_json).toContain("original-result-evidence");
  });

  it("still replaces ordinary captured arguments and results with final values", () => {
    persistToolCallWriteAhead(sessionId, 0, callId, "bash", JSON.stringify({ command: "partial" }));
    appendMessages(sessionId, [result("partial-result")]);
    appendMessages(sessionId, [assistant({ command: "final-command" }), result("final-result")]);
    const row = getDatabase().prepare("SELECT args_json FROM tool_calls WHERE tool_call_id=?").get(callId) as {
      args_json: string;
    };
    expect(JSON.parse(row.args_json).command).toBe("final-command");
    const stored = getDatabase()
      .prepare(
        "SELECT output_json FROM tool_results tr JOIN tool_calls tc ON tc.id=tr.tool_call_row_id WHERE tc.tool_call_id=?",
      )
      .get(callId) as { output_json: string };
    expect(stored.output_json).toContain("final-result");
    expect(stored.output_json).not.toContain("partial-result");
  });

  it("keeps a marker explicit when no original was captured, then accepts later real evidence", () => {
    appendMessages(sessionId, [assistant(buildElidedArgsInput(500)), result("[elided bash]")]);
    const query = () =>
      getDatabase().prepare("SELECT args_json FROM tool_calls WHERE tool_call_id=?").get(callId) as {
        args_json: string;
      };
    expect(query().args_json).toContain("__elided_note");
    appendMessages(sessionId, [assistant({ command: "later-real-command" }), result("later-real-result")]);
    expect(query().args_json).toBe(JSON.stringify({ command: "later-real-command" }));
  });

  it("does not mistake ordinary text mentioning compaction for a replacement envelope", () => {
    appendMessages(sessionId, [assistant({ command: "echo diagnostic" }), result("old-output")]);
    appendMessages(sessionId, [result("Diagnostic explanation mentions [elided bash] but contains real new evidence")]);
    const row = getDatabase()
      .prepare(
        "SELECT output_json FROM tool_results tr JOIN tool_calls tc ON tc.id=tr.tool_call_row_id WHERE tc.tool_call_id=?",
      )
      .get(callId) as { output_json: string };
    expect(row.output_json).toContain("real new evidence");
  });
});
