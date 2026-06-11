import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mirrorRecallLocally } from "./search.js";

/**
 * mirrorRecallLocally writes an op:'recall' row matching the EE buildRecallEvent
 * shape into the client-local activity.jsonl, so the session-end runbook-candidate
 * nudge sees MCP/builtin recalls (not just exp-recall.js CLI recalls).
 */
describe("mirrorRecallLocally", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recall-mirror-"));
    logPath = join(dir, "activity.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends an op:recall row with surfacedIds derived from entries", async () => {
    await mirrorRecallLocally(
      "post donor enrich",
      {
        sourceSession: "sess-1",
        project: "storyflow",
        entries: [
          { id: "4c81b5ca", collection: "experience-selfqa" },
          { id: "1e5f095f", collection: "experience-behavioral" },
        ],
      },
      logPath,
    );
    const rows = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe("recall");
    expect(rows[0].query).toBe("post donor enrich");
    expect(rows[0].sourceSession).toBe("sess-1");
    expect(rows[0].project_slug).toBe("storyflow");
    expect(rows[0].surfacedIds).toEqual(["4c81b5ca", "1e5f095f"]);
    expect(rows[0].count).toBe(2);
    expect(typeof rows[0].ts).toBe("string");
  });

  it("writes count 0 with empty entries (still observable, never throws)", async () => {
    await mirrorRecallLocally("nothing matched", { sourceSession: null, project: null, entries: [] }, logPath);
    const rows = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0].count).toBe(0);
    expect(rows[0].surfacedIds).toEqual([]);
    expect(rows[0].sourceSession).toBeNull();
  });

  it("truncates an over-long query to 200 chars (matches buildRecallEvent)", async () => {
    const long = "x".repeat(500);
    await mirrorRecallLocally(long, { entries: [{ id: "a", collection: "c" }] }, logPath);
    const row = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(row.query.length).toBe(200);
  });

  it("never throws when the target path is unwritable (best-effort)", async () => {
    // A path under a non-existent directory → appendFile rejects → swallowed.
    const bad = join(dir, "nope", "deep", "activity.jsonl");
    await expect(mirrorRecallLocally("q", { entries: [{ id: "a", collection: "c" }] }, bad)).resolves.toBeUndefined();
  });
});
