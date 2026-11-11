import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetArtifactCacheForTests } from "../../ee/artifact-cache.js";
import { filterExecutionTools } from "../../orchestrator/orchestration-policy.js";
import { BashTool } from "../../tools/bash.js";
import { createBuiltinTools } from "../../tools/registry.js";
import { closeDatabase, getDatabase } from "../db.js";
import { listToolEvidence } from "../tool-evidence-index.js";
import { appendMessages, persistToolCallWriteAhead } from "../transcript.js";

describe("native session-scoped evidence discovery", () => {
  let home: string;
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    closeDatabase();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tool-evidence-index-"));
    savedEnv = Object.fromEntries(["HOME", "USERPROFILE", "MUONROI_CLI_HOME"].map((key) => [key, process.env[key]]));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MUONROI_CLI_HOME = path.join(home, ".muonroi-cli");
    getDatabase().exec(`INSERT INTO workspaces(id,scope_key,canonical_path,display_name,last_seen_at)
      VALUES('index-ws','index-ws','/fixture','fixture','2026-11-03T00:00:00Z');`);
    const insert =
      getDatabase().prepare(`INSERT INTO sessions(id,parent_session_id,workspace_id,title,model,mode,cwd_at_start,cwd_last,status,created_at,updated_at)
      VALUES(?,?,'index-ws','fixture','fixture-model','agent','/fixture','/fixture','active','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z')`);
    for (const [id, parent] of [
      ["root", null],
      ["child", "root"],
      ["sibling", "root"],
      ["foreign", null],
    ])
      insert.run(id, parent);
  });
  afterEach(() => {
    __resetArtifactCacheForTests();
    closeDatabase();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error("Evidence index fixture cleanup failed:", err);
    }
  });
  function save(session: string, id: string, file = "PLAN.md") {
    appendMessages(session, [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "delegation_read",
            toolCallId: id,
            input: { id: "fixture-worker", file_path: file },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "delegation_read",
            toolCallId: id,
            output: { type: "text", value: "saved-plan-anchor PRIVATE_OUTPUT" },
          },
        ],
      },
    ] as ModelMessage[]);
  }

  it("discovers the existing session family tree but excludes another conversation in the same workspace", async () => {
    for (const session of ["root", "child", "sibling", "foreign"]) save(session, `call_shared_${session}`);
    const result = await listToolEvidence("child", { prefix: "call_shared_" });
    expect(result.entries.map((entry) => entry.session_id).sort()).toEqual(["child", "root", "sibling"]);
    expect(JSON.stringify(result)).not.toContain("foreign");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OUTPUT");
    expect(JSON.stringify(result)).not.toContain("file_path");
  });

  it("filters literal input paths and ID prefixes without SQL wildcard expansion", async () => {
    save("root", "call_case_1", "docs/100%_done.md");
    save("root", "call_case_2", "docs/100XXdone.md");
    expect((await listToolEvidence("root", { query: "%_" })).entries.map((e) => e.tool_call_id)).toEqual([
      "call_case_1",
    ]);
    expect((await listToolEvidence("root", { prefix: "call_case_%" })).entries).toEqual([]);
    expect((await listToolEvidence("root", { prefix: "CALL_CASE" })).entries).toEqual([]);
    expect((await listToolEvidence("root", { query: "' OR 1=1 --" })).entries).toEqual([]);
  });

  it("pages stable bounded references and never embeds complete arguments or result contents", async () => {
    for (let i = 0; i < 21; i++) save("root", `call_page_${i}`);
    const first = await listToolEvidence("root");
    const second = await listToolEvidence("root", { chunkIndex: 1 });
    const last = await listToolEvidence("root", { chunkIndex: 2 });
    expect(first.entries).toHaveLength(10);
    expect(second.entries).toHaveLength(10);
    expect(last.entries).toHaveLength(1);
    expect(first.next_chunk_index).toBe(1);
    expect(second.next_chunk_index).toBe(2);
    expect(last.next_chunk_index).toBeNull();
    expect(new Set([...first.entries, ...second.entries, ...last.entries].map((e) => e.tool_call_id)).size).toBe(21);
    expect(first.entries[0].tool_call_id).toBe("call_page_20");
  });

  it("reports absent results explicitly instead of treating a write-ahead call as completed evidence", async () => {
    persistToolCallWriteAhead("root", 0, "call_pending", "read_file", JSON.stringify({ file_path: "PLAN.md" }));
    const entry = (await listToolEvidence("root")).entries[0];
    expect(entry.result_available).toBe(false);
    expect(entry.arguments_available).toBe(true);
    const tools = createBuiltinTools(new BashTool(home), "agent", { sessionId: "root" });
    const missing = String(
      await tools.retrieve_tool_result!.execute!(
        { tool_call_id: "call_pending" },
        { toolCallId: "pending-fixture", messages: [] },
      ),
    );
    expect(missing).toContain("not found");
    expect(missing).not.toContain('"retrieve"');
  });

  it("lets main recover an unshortened ID after compaction and a cold cache without reading project files", async () => {
    const fullId = "call_f56f2b2b980c4ea7861f126c";
    save("root", fullId);
    appendMessages("root", [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "delegation_read",
            toolCallId: fullId,
            output: {
              type: "text",
              value: `[earlier tool_result for tool=delegation_read (id=${fullId}) — 33855 chars elided by sub-agent compactor]`,
            },
          },
        ],
      },
    ]);
    __resetArtifactCacheForTests();
    const native = createBuiltinTools(new BashTool(home), "agent", {
      sessionId: "root",
      executionRole: "orchestrator",
    });
    const main = filterExecutionTools(native, native, "orchestrator");
    expect(main.read_file?.execute).toEqual(expect.any(Function));
    expect(main.bash).toBeUndefined();
    const execute = (input: object) =>
      main.retrieve_tool_result!.execute!(input, { toolCallId: "recovery-fixture", messages: [] });
    const miss = String(await execute({ tool_call_id: "call_f56f2b2" }));
    expect(miss).toContain(fullId);
    expect(miss).not.toContain("saved-plan-anchor");
    const discovered = JSON.parse(String(await execute({ view: "index", query: "PLAN.md" })));
    expect(discovered.entries[0].retrieve).toEqual({ tool_call_id: fullId });
    const recovered = JSON.parse(String(await execute(discovered.entries[0].retrieve)));
    expect(recovered.source).toContain("SQLite");
    expect(recovered.content).toContain("saved-plan-anchor");
    expect(recovered.content).not.toContain("elided by sub-agent compactor");
  });

  it("fails closed for missing ownership, invalid queries or pages, and empty local matches", async () => {
    await expect(listToolEvidence(undefined)).rejects.toThrow("session binding");
    await expect(listToolEvidence("root", { query: "x".repeat(257) })).rejects.toThrow("256");
    for (const page of [-1, 1.2, Number.MAX_SAFE_INTEGER])
      await expect(listToolEvidence("root", { chunkIndex: page })).rejects.toThrow("chunk_index");
    expect((await listToolEvidence("root")).entries).toEqual([]);
  });
});
