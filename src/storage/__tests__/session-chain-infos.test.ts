/**
 * getSessionChainInfos: enumerate the session tree (root + rotation / sub-agent
 * descendants) with per-session metadata for the rail's "Sessions" block.
 *
 * Real better-sqlite3 against a temp HOME (same pattern as sub-session-realdb):
 * exercises the actual SessionStore.linkChild wiring + message counts, not mocks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../db.js";
import { SessionStore } from "../sessions.js";
import { appendMessages, getSessionChainInfos } from "../transcript.js";

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-chain-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  closeDatabase();
  getDatabase(); // migrate temp DB
});

afterEach(() => {
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function seedMsgs(id: string, n: number): void {
  appendMessages(id, Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` })) as never);
}

describe("getSessionChainInfos", () => {
  it("returns a single node for a childless conversation", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("deepseek-v4-flash", "agent", tmpHome);
    seedMsgs(root.id, 2);

    const nodes = getSessionChainInfos(root.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: root.id,
      kind: "conversation",
      depth: 0,
      isCurrent: true,
      messageCount: 2,
    });
  });

  it("enumerates root + subagent + rotation with depth, kind, msg counts, and isCurrent", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("deepseek-v4-flash", "agent", tmpHome);
    seedMsgs(root.id, 2);

    const sub = store.createSession("deepseek-v4-flash", "agent", tmpHome);
    store.linkChild(sub.id, root.id, "subagent");
    seedMsgs(sub.id, 6);

    const rot = store.createSession("deepseek-v4-flash", "agent", tmpHome);
    store.linkChild(rot.id, root.id, "rotation");
    seedMsgs(rot.id, 3);

    const nodes = getSessionChainInfos(root.id);
    expect(nodes).toHaveLength(3);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(root.id)).toMatchObject({ kind: "conversation", depth: 0, isCurrent: true, messageCount: 2 });
    expect(byId.get(sub.id)).toMatchObject({ kind: "subagent", depth: 1, isCurrent: false, messageCount: 6 });
    expect(byId.get(rot.id)).toMatchObject({ kind: "rotation", depth: 1, isCurrent: false, messageCount: 3 });
    // Root-first ordering.
    expect(nodes[0].id).toBe(root.id);
  });

  it("marks the resumed leaf as current, not the root", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("deepseek-v4-flash", "agent", tmpHome);
    seedMsgs(root.id, 2);
    const sub = store.createSession("deepseek-v4-flash", "agent", tmpHome);
    store.linkChild(sub.id, root.id, "subagent");
    seedMsgs(sub.id, 4);

    // Resume from the CHILD id — walk-up-then-down still yields the full tree,
    // and isCurrent tracks the id we resumed from.
    const nodes = getSessionChainInfos(sub.id);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.id === sub.id)?.isCurrent).toBe(true);
    expect(nodes.find((n) => n.id === root.id)?.isCurrent).toBe(false);
  });
});
