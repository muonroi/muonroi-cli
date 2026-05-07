import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendTrajectoryEvent,
  rotateOldSessions,
  setSessionsDir,
  resetTrajectoryState,
  disableTrajectoryLogging,
} from "./session-trajectory.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ee-traj-"));
  setSessionsDir(tmp);
  resetTrajectoryState();
  disableTrajectoryLogging(false);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("session-trajectory / append", () => {
  it("appends one JSONL line per event", async () => {
    await appendTrajectoryEvent({
      ts: new Date().toISOString(),
      sessionId: "sess1",
      kind: "intercept",
      toolName: "Edit",
      decision: "allow",
      matchCount: 1,
      matchIds: ["abc"],
    });
    await appendTrajectoryEvent({
      ts: new Date().toISOString(),
      sessionId: "sess1",
      kind: "posttool",
      toolName: "Edit",
      success: true,
      durationMs: 12,
    });
    const file = path.join(tmp, "sess1.jsonl");
    const content = await fs.readFile(file, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.kind).toBe("intercept");
  });

  it("sanitizes sessionId for filesystem safety", async () => {
    await appendTrajectoryEvent({
      ts: new Date().toISOString(),
      sessionId: "../../etc/passwd",
      kind: "user_turn",
      excerpt: "hello",
      vetoDetected: false,
    });
    // Sanitized name: `..` and `/` replaced with `_` → `_.._.._etc_passwd`
    const entries = await fs.readdir(tmp);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^[a-zA-Z0-9_-]+\.jsonl$/);
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).not.toContain("..");
  });

  it("skips events without sessionId", async () => {
    await appendTrajectoryEvent({
      ts: new Date().toISOString(),
      sessionId: "",
      kind: "user_turn",
      excerpt: "hi",
      vetoDetected: false,
    });
    const entries = await fs.readdir(tmp).catch(() => []);
    expect(entries.length).toBe(0);
  });

  it("respects disable flag", async () => {
    disableTrajectoryLogging(true);
    await appendTrajectoryEvent({
      ts: new Date().toISOString(),
      sessionId: "sess1",
      kind: "user_turn",
      excerpt: "hi",
      vetoDetected: false,
    });
    const entries = await fs.readdir(tmp).catch(() => []);
    expect(entries.length).toBe(0);
  });
});

describe("session-trajectory / rotation", () => {
  it("removes files older than 30 days", async () => {
    const fresh = path.join(tmp, "fresh.jsonl");
    const old = path.join(tmp, "old.jsonl");
    await fs.writeFile(fresh, "{}\n");
    await fs.writeFile(old, "{}\n");
    // Backdate `old` by 31 days.
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await fs.utimes(old, oldTime / 1000, oldTime / 1000);

    const result = await rotateOldSessions();
    expect(result.removedAge).toBe(1);

    const remaining = await fs.readdir(tmp);
    expect(remaining).toContain("fresh.jsonl");
    expect(remaining).not.toContain("old.jsonl");
  });

  it("evicts oldest files when total size exceeds 100MB", async () => {
    // Write 3 files of 40MB each → 120MB total → 1 must be evicted (40MB removed).
    const sizes = [40, 40, 40];
    const names = ["a.jsonl", "b.jsonl", "c.jsonl"];
    const buf = Buffer.alloc(40 * 1024 * 1024, "x"); // 40 MB

    for (let i = 0; i < names.length; i++) {
      const full = path.join(tmp, names[i]!);
      await fs.writeFile(full, buf);
      // Stagger mtimes — `a` is oldest.
      const t = (Date.now() - (sizes.length - i) * 60_000) / 1000;
      await fs.utimes(full, t, t);
    }

    const result = await rotateOldSessions();
    expect(result.removedSize).toBeGreaterThanOrEqual(1);
    const after = await fs.readdir(tmp);
    expect(after).not.toContain("a.jsonl"); // oldest evicted first
  }, 30_000);

  it("returns zero counts when directory does not exist yet", async () => {
    setSessionsDir(path.join(tmp, "nonexistent"));
    const result = await rotateOldSessions();
    expect(result.removedAge).toBe(0);
    expect(result.removedSize).toBe(0);
  });
});
