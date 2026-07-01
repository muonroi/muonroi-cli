import type { ModelMessage } from "ai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../db";
import { appendMessages, persistMessageWriteAhead } from "../transcript";

interface FtsRow {
  session_id: string;
  seq: number;
  role: string;
  tool_name: string | null;
  content: string | null;
  tool_args: string | null;
  tool_output: string | null;
}

describe("FTS5 transcript integration", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    // Reset DB singleton if it exists
    closeDatabase();

    // Setup temporary home directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-fts-test-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });

  afterEach(() => {
    closeDatabase();
    // Restore home
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;

    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should index messages and tool calls in FTS5 table and support cascading deletes", () => {
    const db = getDatabase();

    // Create workspaces and session
    db.exec(`
      INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at)
      VALUES ('w1', 'scope1', '/tmp/p1', 'Workspace 1', '2026-06-30T11:29:46Z');

      INSERT INTO sessions (id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at)
      VALUES ('s1', 'w1', 'Session 1', 'claude-3-5', 'safe', '/tmp/p1', '/tmp/p1', 'active', '2026-06-30T11:29:46Z', '2026-06-30T11:29:46Z');
    `);

    // 1. Append a user message
    const userMessage: ModelMessage = {
      role: "user",
      content: "Hello, this is a search test request.",
    };
    appendMessages("s1", [userMessage]);

    // Check that it's indexed
    let rows = db.prepare("SELECT * FROM session_history_fts WHERE session_id = 's1'").all() as unknown as FtsRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: "s1",
      seq: 1,
      role: "user",
      content: "Hello, this is a search test request.",
      tool_name: null,
      tool_args: null,
      tool_output: null,
    });

    // 2. Append assistant message calling a tool
    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I will call the search tool." },
        { type: "tool-call", toolCallId: "tc1", toolName: "grep_search", input: { Query: "FTS5", SearchPath: "/tmp" } },
      ],
    };
    appendMessages("s1", [assistantMessage]);

    rows = db
      .prepare("SELECT * FROM session_history_fts WHERE session_id = 's1' ORDER BY seq ASC")
      .all() as unknown as FtsRow[];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      session_id: "s1",
      seq: 2,
      role: "assistant",
      content: "I will call the search tool.",
      tool_name: "grep_search",
      tool_args: JSON.stringify({ Query: "FTS5", SearchPath: "/tmp" }),
      tool_output: null,
    });

    // 3. Append tool result message
    const toolMessage: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "grep_search",
          output: { success: true, files: ["migrations.ts"] } as any,
        },
      ],
    };
    appendMessages("s1", [toolMessage]);

    rows = db
      .prepare("SELECT * FROM session_history_fts WHERE session_id = 's1' ORDER BY seq ASC")
      .all() as unknown as FtsRow[];
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      session_id: "s1",
      seq: 3,
      role: "tool",
      content: null,
      tool_name: "grep_search",
      tool_args: null,
      tool_output: JSON.stringify({ success: true, files: ["migrations.ts"] }),
    });

    // 4. Test deduplication / upsert
    const userMessage2: ModelMessage = {
      role: "user",
      content: "Initial query text",
    };
    persistMessageWriteAhead("s1", 4, "user", JSON.stringify(userMessage2));

    rows = db
      .prepare("SELECT * FROM session_history_fts WHERE session_id = 's1' AND seq = 4")
      .all() as unknown as FtsRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Initial query text");

    // Now upsert/override FTS by calling persistMessageWriteAhead again with the same sequence but different text
    const userMessage2Final: ModelMessage = {
      role: "user",
      content: "Final query text",
    };
    persistMessageWriteAhead("s1", 4, "user", JSON.stringify(userMessage2Final));

    rows = db
      .prepare("SELECT * FROM session_history_fts WHERE session_id = 's1' AND seq = 4")
      .all() as unknown as FtsRow[];
    expect(rows).toHaveLength(1); // Verify deduplication (still exactly 1 row)
    expect(rows[0].content).toBe("Final query text"); // Verify content updated successfully

    // 5. Test cascading delete trigger
    db.exec("DELETE FROM sessions WHERE id = 's1'");
    rows = db.prepare("SELECT * FROM session_history_fts WHERE session_id = 's1'").all() as unknown as FtsRow[];
    expect(rows).toHaveLength(0);
  });
});
