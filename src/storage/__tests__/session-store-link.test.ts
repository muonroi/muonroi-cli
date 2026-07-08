/**
 * Real-SQLite verification of createSession defaults + linkChild root propagation.
 * Points getDatabasePath at a temp HOME so getDatabase() opens a real
 * better-sqlite3 file DB (bun:sqlite is unavailable under vitest/Node).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../db.js";
import { SessionStore } from "../sessions.js";

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-link-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  closeDatabase();
  getDatabase(); // trigger migrations against the temp DB
});

afterEach(() => {
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("SessionStore.createSession + linkChild", () => {
  it("createSession defaults kind='conversation' and root_session_id=id", () => {
    const store = new SessionStore(tmpHome);
    const s = store.createSession("m", "agent", tmpHome);
    const row = getDatabase().prepare("SELECT kind, root_session_id FROM sessions WHERE id = ?").get(s.id) as {
      kind: string;
      root_session_id: string;
    };
    expect(row.kind).toBe("conversation");
    expect(row.root_session_id).toBe(s.id);
  });

  it("linkChild stamps parent, kind, and inherits the parent's root", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("m", "agent", tmpHome);
    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, root.id, "rotation");

    const row = getDatabase()
      .prepare("SELECT parent_session_id, kind, root_session_id FROM sessions WHERE id = ?")
      .get(child.id) as { parent_session_id: string; kind: string; root_session_id: string };
    expect(row.parent_session_id).toBe(root.id);
    expect(row.kind).toBe("rotation");
    expect(row.root_session_id).toBe(root.id);

    // A grandchild inherits the same root, not its immediate parent's id.
    const grand = store.createSession("m", "agent", tmpHome);
    store.linkChild(grand.id, child.id, "rotation");
    const grandRow = getDatabase().prepare("SELECT root_session_id FROM sessions WHERE id = ?").get(grand.id) as {
      root_session_id: string;
    };
    expect(grandRow.root_session_id).toBe(root.id);
  });
});
