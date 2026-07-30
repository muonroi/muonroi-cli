/**
 * src/storage/__tests__/tool-result-write-ahead.test.ts
 *
 * Regression — sessions 7ec700df5589 / d22397a9e47d (2026-07-29).
 *
 * `tool_calls.status='completed'` and every `tool_results` row were written ONLY
 * by `appendMessages()` at turn end. When the turn-idle watchdog killed a turn,
 * that call never ran, so the durable record of work that had ALREADY SUCCEEDED
 * evaporated: session 7ec700df5589 ended with 9 `tool_calls` stuck `pending`, 0
 * `tool_results`, and 0 assistant messages — even though `interaction_logs` had
 * recorded 8 successful tool results. That is why absorption then logged
 * "No assistant messages found to absorb from sub-session" and ~20.5 minutes of
 * council work ($0.1845 metered) was thrown away.
 *
 * `persistToolCallWriteAhead` already wrote the `pending` row (Phase A4); the
 * RESULT had no equivalent. These tests pin the result write-ahead, and pin that
 * it does not double-write once the end-of-turn `appendMessages` also runs.
 */

import type { ModelMessage } from "ai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../db";
import { appendMessages, persistToolCallWriteAhead, persistToolResultWriteAhead } from "../transcript";

describe("tool_results write-ahead", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    closeDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-trwa-test-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    getDatabase().exec(`
      INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at)
      VALUES ('w1', 'scope1', '/tmp/p1', 'Workspace 1', '2026-07-29T09:41:00Z');

      INSERT INTO sessions (id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at)
      VALUES ('s1', 'w1', 'S', 'gpt-5.4', 'agent', '/tmp/p1', '/tmp/p1', 'active', '2026-07-29T09:41:00Z', '2026-07-29T09:41:00Z');
    `);
  });

  afterEach(() => {
    closeDatabase();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
    else delete process.env.USERPROFILE;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const status = (): string | undefined =>
    (
      getDatabase().prepare("SELECT status FROM tool_calls WHERE tool_call_id='tc1'").get() as
        | { status: string }
        | undefined
    )?.status;

  const results = (): Array<{ success: number; output_json: string }> =>
    getDatabase()
      .prepare(`
        SELECT tr.success, tr.output_json
        FROM tool_results tr JOIN tool_calls tc ON tc.id = tr.tool_call_row_id
        WHERE tc.tool_call_id = 'tc1' ORDER BY tr.id ASC
      `)
      .all() as Array<{ success: number; output_json: string }>;

  it("durably records a finished tool call before the turn ends", () => {
    persistToolCallWriteAhead("s1", 2, "tc1", "bash", JSON.stringify({ command: "git status --short" }));
    expect(status()).toBe("pending");
    expect(results()).toHaveLength(0);

    persistToolResultWriteAhead("s1", "tc1", { success: true, output: "M src/models/catalog.json" });

    // This is the whole point: if the watchdog kills the turn right here, the
    // work is still on disk instead of vanishing.
    expect(status()).toBe("completed");
    const rows = results();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(1);
    expect(rows[0]?.output_json).toContain("catalog.json");
  });

  it("records a failed tool result as success=0", () => {
    persistToolCallWriteAhead("s1", 2, "tc1", "edit_file", "{}");
    persistToolResultWriteAhead("s1", "tc1", { success: false, error: "old_string is not unique" });
    const rows = results();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(0);
    expect(rows[0]?.output_json).toContain("not unique");
  });

  it("does not duplicate the row when the turn later completes normally", () => {
    persistToolCallWriteAhead("s1", 2, "tc1", "bash", JSON.stringify({ command: "echo hi" }));
    persistToolResultWriteAhead("s1", "tc1", { success: true, output: "write-ahead output" });
    expect(results()).toHaveLength(1);

    // Normal end-of-turn path runs afterwards with the authoritative payload.
    const assistant: ModelMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", input: { command: "echo hi" } }],
    };
    const tool: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "bash",
          output: { type: "text", value: "final output" },
        },
      ],
    };
    appendMessages("s1", [assistant, tool]);

    const rows = results();
    expect(rows).toHaveLength(1); // exactly one — not a write-ahead + a final
    expect(rows[0]?.output_json).toContain("final output"); // appendMessages wins
  });

  it("is idempotent when the same result is written twice", () => {
    persistToolCallWriteAhead("s1", 2, "tc1", "bash", "{}");
    persistToolResultWriteAhead("s1", "tc1", { success: true, output: "once" });
    persistToolResultWriteAhead("s1", "tc1", { success: true, output: "twice" });
    expect(results()).toHaveLength(1);
  });

  it("fails open when the tool_call row does not exist", () => {
    expect(() => persistToolResultWriteAhead("s1", "no-such-call", { success: true, output: "x" })).not.toThrow();
    expect(results()).toHaveLength(0);
  });
});
