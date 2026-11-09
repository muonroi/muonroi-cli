/**
 * The `/ideal` run record survives a restart.
 *
 * `/ideal status` and `/ideal abort` used to read an in-memory field, so after a
 * CLI restart / `--session` resume they answered "No /ideal run has been
 * started" while the run's workers were still running. The record is now saved
 * with the session (storage/transcript.ts persistIdealRun) — keyed on the
 * SESSION, never on the cwd, so a different session in the same project does not
 * inherit it (project_cwd_owned_state_leaks_into_sessions).
 *
 * Real SQLite against a temp HOME; only the model turn and the delegation
 * ledger/kill are stubbed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { getLastIdealRun, persistIdealRun } from "../../storage/transcript.js";
import { Agent } from "../orchestrator.js";

// The suite pin (vitest-setup.ts); user files live under MUONROI_CLI_HOME, not under HOME.
const PINNED_CLI_HOME = process.env.MUONROI_CLI_HOME;

const MODEL = "deepseek-v4-flash";
const GOAL = "Build the parser";

let tmpHome: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-ideal-run-"));
  prevHome = process.env.HOME;
  prevProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MUONROI_CLI_HOME = path.join(tmpHome, ".muonroi-cli");
  closeDatabase();
  getDatabase(); // migrate the temp DB
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevProfile;
  if (PINNED_CLI_HOME === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = PINNED_CLI_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function drain(gen: AsyncGenerator<{ type: string; content?: string }>) {
  const chunks: Array<{ type: string; content?: string }> = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function newAgent(session?: string): Agent {
  const agent = new Agent("fixture-key", undefined, MODEL, 1, {
    persistSession: true,
    executionRole: "orchestrator",
    ...(session ? { session } : {}),
  });
  vi.spyOn(agent, "processMessage").mockImplementation(async function* () {
    yield { type: "content", content: "Main coordinates bounded workers" };
  });
  return agent;
}

const entry = (id: string, status: "running" | "complete", startedAt: string) => ({
  id,
  agent: "general",
  description: `job ${id}`,
  status,
  startedAt,
  acknowledged: false,
});

describe("storage: /ideal run record", () => {
  it("newest row wins and a close row ends the run; sessions are independent", () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    for (const id of ["s-a", "s-b"]) {
      db.prepare(
        "INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      ).run("w", "scope", "/w", "w", now);
      db.prepare(
        "INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES (?, 'w', 'm', 'agent', '/w', '/w', 'active', ?, ?)",
      ).run(id, now, now);
    }
    expect(getLastIdealRun("s-a")).toBeNull();
    expect(persistIdealRun("s-a", { goal: "one", startedAt: "2026-11-09T10:00:00.000Z" })).toBe(true);
    expect(persistIdealRun("s-a", { goal: "two", startedAt: "2026-11-09T11:00:00.000Z" })).toBe(true);
    expect(getLastIdealRun("s-a")).toEqual({ goal: "two", startedAt: "2026-11-09T11:00:00.000Z" });
    expect(getLastIdealRun("s-b")).toBeNull();
    expect(persistIdealRun("s-a", null)).toBe(true);
    expect(getLastIdealRun("s-a")).toBeNull();
  });

  it("an unreadable row is logged and treated as no run; a write to an unknown session reports failure", () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at) VALUES ('w', 'scope', '/w', 'w', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES ('s-x', 'w', 'm', 'agent', '/w', '/w', 'active', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO tool_calls (session_id, message_seq, tool_call_id, tool_name, args_json, status, started_at) VALUES ('s-x', 0, 'bad-1', '__ideal_run', '{not json', 'completed', ?)",
    ).run(now);
    expect(getLastIdealRun("s-x")).toBeNull();
    // foreign_keys=ON: a session that does not exist cannot own the row.
    expect(persistIdealRun("no-such-session", { goal: "g", startedAt: now })).toBe(false);
  });
});

describe("Agent: /ideal status and abort after a restart", () => {
  it("a resumed session still reports the run and aborts its running workers; /new and a sibling session do not see it", async () => {
    const first = newAgent();
    const sessionId = first.getSessionId()!;
    await drain(first.runProductLoopV1({ subcommand: "start", idea: GOAL, flags: { doneThreshold: 90 } }) as never);
    await first.cleanup();

    const run = getLastIdealRun(sessionId)!;
    expect(run.goal).toBe(GOAL);
    const during = new Date(Date.parse(run.startedAt) + 5_000).toISOString();
    const before = new Date(Date.parse(run.startedAt) - 60_000).toISOString();

    // "Restart": a brand-new Agent (fresh memory) resumes the session.
    const resumed = newAgent(sessionId);
    const internal = resumed as any;
    vi.spyOn(internal.delegations, "ledgerSnapshot").mockResolvedValue([
      entry("pre-run-job", "running", before),
      entry("run-worker-a", "running", during),
      entry("run-worker-b", "complete", during),
    ]);
    const kill = vi.spyOn(internal.delegations, "kill").mockResolvedValue({ success: true, output: "killed" });

    const status = await drain(
      resumed.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }) as never,
    );
    expect(status[0]!.content).toContain(`Goal: ${GOAL}`);
    expect(status[0]!.content).toContain("run-worker-a");
    expect(status[0]!.content).not.toContain("pre-run-job");
    expect(resumed.processMessage).not.toHaveBeenCalled();

    const abort = await drain(resumed.runProductLoopV1({ subcommand: "abort", flags: { doneThreshold: 90 } }) as never);
    expect(kill.mock.calls.map((c) => c[0])).toEqual(["run-worker-a"]);
    expect(abort[0]!.content).toContain("Stopped 1 worker(s): run-worker-a");
    await resumed.cleanup();

    // The abort is durable: the next restart sees the run closed.
    const afterAbort = newAgent(sessionId);
    const closed = await drain(
      afterAbort.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }) as never,
    );
    expect(closed[0]!.content).toContain("No /ideal run has been started in this session.");
    await afterAbort.cleanup();
  });

  it("does not leak into another session of the same project, nor into /new in the same process", async () => {
    const a = newAgent();
    await drain(a.runProductLoopV1({ subcommand: "start", idea: GOAL, flags: { doneThreshold: 90 } }) as never);
    const idA = a.getSessionId()!;
    vi.spyOn((a as any).delegations, "ledgerSnapshot").mockResolvedValue([]);

    // Same cwd, different session (what a fresh `muonroi-cli` launch gets).
    const other = newAgent();
    expect(other.getSessionId()).not.toBe(idA);
    vi.spyOn((other as any).delegations, "ledgerSnapshot").mockResolvedValue([]);
    const otherStatus = await drain(
      other.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }) as never,
    );
    expect(otherStatus[0]!.content).toContain("No /ideal run has been started in this session.");

    // `/new` inside the same process: the run belongs to the old session.
    expect(
      (await drain(a.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }) as never))[0]!.content,
    ).toContain(`Goal: ${GOAL}`);
    // startNewSession reuses an empty untitled session, so give the run's session content first.
    (a as any).messages = [{ role: "user", content: "hello" }];
    a.startNewSession();
    expect(a.getSessionId()).not.toBe(idA);
    const afterNew = await drain(a.runProductLoopV1({ subcommand: "status", flags: { doneThreshold: 90 } }) as never);
    expect(afterNew[0]!.content).toContain("No /ideal run has been started in this session.");
    await a.cleanup();
    await other.cleanup();
  });
});
