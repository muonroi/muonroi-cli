/**
 * `markToolCallErrored` — reachability + redaction of `tool_calls.args_json`.
 *
 * This sink LOOKS like the bug class: it is handed a caught error's `.message`
 * copied verbatim (src/orchestrator/tool-engine.ts:3305-3310) and writes it into
 * a SQLite column via `args_json = COALESCE(args_json, ?)`.
 *
 * It is NOT a live leak, and this spec is the proof. `args_json` is declared
 * `TEXT NOT NULL` (src/storage/migrations.ts:222), so an existing row's column
 * can never be NULL and the COALESCE fallback can never select the error text;
 * when no row matches, the UPDATE is a no-op. The error message therefore has no
 * path to disk here — the redaction on that expression is defence-in-depth for a
 * future schema change, not a fix for a reachable leak.
 *
 * Pinning this matters both ways: it stops the next audit re-flagging the sink,
 * and it fails loudly if someone makes the column nullable without revisiting
 * what then becomes persistable.
 *
 * Runs against a real SQLite file under a temp HOME — the user's DB is never
 * opened. Credentials are assembled AT RUNTIME so check-secrets.mjs stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../db.js";
import { markToolCallErrored, persistToolCallWriteAhead } from "../transcript.js";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "t00lc4ll" + "W".repeat(26);
}

const SESSION_ID = "sess-toolcall-redact";

describe("markToolCallErrored — the error text has no path into tool_calls.args_json", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    closeDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-toolcall-redact-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    getDatabase().exec(`
      INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at)
      VALUES ('ws-1', 'scope-1', '/tmp/p', 'p', '2026-09-23T00:00:00.000Z');
      INSERT INTO sessions (id, workspace_id, title, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at)
      VALUES ('${SESSION_ID}', 'ws-1', 't', 'm', 'chat', '/tmp/p', '/tmp/p', 'active', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    `);
  });

  afterEach(() => {
    closeDatabase();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[tool-call-errored.test] temp dir cleanup failed for ${tmpDir}: ${(err as Error)?.message}`);
    }
  });

  function readRow(toolCallId: string): { status: string; args_json: string | null } | undefined {
    return getDatabase()
      .prepare("SELECT status, args_json FROM tool_calls WHERE session_id = ? AND tool_call_id = ?")
      .get(SESSION_ID, toolCallId) as { status: string; args_json: string | null } | undefined;
  }

  it("cannot reach the COALESCE fallback: args_json is NOT NULL by schema", () => {
    persistToolCallWriteAhead(SESSION_ID, 1, "tc-notnull", "mcp__x__call", JSON.stringify({ q: 1 }));

    // The ONLY state in which COALESCE would select the error text. The schema
    // forbids it, which is exactly why the error text never lands.
    expect(() =>
      getDatabase()
        .prepare("UPDATE tool_calls SET args_json = NULL WHERE session_id = ? AND tool_call_id = ?")
        .run(SESSION_ID, "tc-notnull"),
    ).toThrow(/NOT NULL constraint failed: tool_calls\.args_json/);
  });

  it("flips status to errored without writing the error message anywhere", () => {
    const key = fakeProviderKey();
    const realArgs = JSON.stringify({ path: "src/index.ts", limit: 40 });
    persistToolCallWriteAhead(SESSION_ID, 2, "tc-keeps-args", "read", realArgs);

    markToolCallErrored(SESSION_ID, "tc-keeps-args", `read failed: 401 (Authorization: Bearer ${key})`);

    const row = readRow("tc-keeps-args");
    expect(row?.status).toBe("errored");
    // COALESCE keeps the true arguments; the error text is discarded entirely.
    expect(row?.args_json).toBe(realArgs);
    expect(row?.args_json).not.toContain(key);
    expect(row?.args_json).not.toContain("read failed");
  });

  it("is a no-op — not a row insert — when the write-ahead row is missing", () => {
    const key = fakeProviderKey();

    markToolCallErrored(SESSION_ID, "tc-never-written", `boom ${key}`);

    // No row means the UPDATE matched nothing, so there is no column for the
    // message to land in.
    expect(readRow("tc-never-written")).toBeUndefined();
  });

  it("leaves no occurrence of the key anywhere in the tool_calls table", () => {
    const key = fakeProviderKey();
    persistToolCallWriteAhead(SESSION_ID, 3, "tc-scan", "bash", JSON.stringify({ command: "ls" }));

    markToolCallErrored(SESSION_ID, "tc-scan", `bash failed with ${key}`);

    const all = getDatabase().prepare("SELECT * FROM tool_calls WHERE session_id = ?").all(SESSION_ID);
    expect(JSON.stringify(all)).not.toContain(key);
  });
});
