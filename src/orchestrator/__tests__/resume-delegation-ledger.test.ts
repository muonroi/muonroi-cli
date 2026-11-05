/**
 * Host-carried delegation ledger on SESSION RESUME (real SQLite + real
 * DelegationManager job files against a temp home).
 *
 * Gap left by 0ce416b0: the ledger is a seq=null, never-persisted message, so a
 * `--session <id>` resume (or the session-picker relaunch, which re-execs with
 * `--session`) reloaded history WITHOUT it while background workers — separate
 * processes with durable job records — kept running. The resumed orchestrator
 * was blind to them until its next compaction: the same blind spot behind the
 * duplicate dispatch in session 4edc02516a92 (steady-ivory-panda /
 * steady-indigo-heron).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { SessionStore } from "../../storage/sessions.js";
import { appendCompaction, appendMessages } from "../../storage/transcript.js";
import { isCompactionSummaryMessage } from "../compaction.js";
import { DELEGATION_LEDGER_HEADER, isDelegationLedgerMessage } from "../delegation-ledger.js";
import { completeDelegation, type StoredDelegation } from "../delegations.js";
import { Agent } from "../orchestrator.js";

const MODEL = "deepseek-v4-flash";

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "USERPROFILE", "MUONROI_CLI_HOME", "MUONROI_BACKGROUND_CHILD"] as const;

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-resume-ledger-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MUONROI_CLI_HOME = path.join(tmpHome, ".muonroi-cli");
  delete process.env.MUONROI_BACKGROUND_CHILD;
  closeDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A prior process's session: persisted history, optionally compacted. */
function seedSession(opts: { compacted?: boolean; extra?: ModelMessage[] } = {}): string {
  const cwd = process.cwd();
  const store = new SessionStore(cwd);
  const session = store.createSession(MODEL, "agent", cwd);
  const seqs = appendMessages(session.id, [
    { role: "user", content: "Ship the docs engine" },
    { role: "assistant", content: "Dispatched a worker for Wave 2." },
    ...(opts.extra ?? []),
  ]);
  if (opts.compacted) appendCompaction(session.id, seqs[0]!, "## Goal\nShip docs engine. (forgot workers)", 1000);
  return session.id;
}

function jobDir(): string {
  const cwd = process.cwd();
  const base =
    path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  // Same derivation as delegations.ts getProjectId (registry scope = session.cwdAtStart).
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
  const dir = path.join(process.env.MUONROI_CLI_HOME!, "delegations", `${base}-${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJob(owner: string, record: Partial<StoredDelegation> & { id: string }): string {
  const dir = jobDir();
  const jobPath = path.join(dir, `${record.id}.json`);
  const full: StoredDelegation = {
    agent: "general",
    description: "Wave 2: Docs engine TCIS.MCP.Docs + unit tests",
    prompt: "fixture",
    cwd: process.cwd(),
    model: "fixture",
    sandboxMode: "off",
    maxToolRounds: 1,
    maxTokens: 1,
    status: "running",
    startedAt: "2026-11-04T02:07:34.000Z",
    outputPath: path.join(dir, `${record.id}.md`),
    parentSessionId: owner,
    // A live PID: the worker outlived the CLI process that dispatched it.
    pid: process.pid,
    ...record,
  };
  fs.writeFileSync(jobPath, JSON.stringify(full));
  return jobPath;
}

function resume(sessionId: string, executionRole: "orchestrator" | "worker" = "orchestrator") {
  return new Agent("sk-dummy", undefined, MODEL, undefined, {
    persistSession: true,
    session: sessionId,
    executionRole,
  });
}

const ledgersOf = (agent: Agent) => agent.getMessages().filter((m) => isDelegationLedgerMessage(m));

describe("delegation ledger is regenerated on --session resume (0ce416b0 gap, session 4edc02516a92)", () => {
  it("a running worker that outlived the CLI is in the ledger before the first model call", async () => {
    const sessionId = seedSession();
    writeJob(sessionId, { id: "steady-ivory-panda", writeScope: ["src/TCIS.MCP.Docs/**"] });

    const agent = resume(sessionId);
    // Reload alone carries nothing: the ledger was never persisted.
    expect(ledgersOf(agent)).toHaveLength(0);

    // The pre-stream / idle-tick seam.
    await agent.consumeBackgroundNotifications();

    const messages = agent.getMessages();
    expect(isDelegationLedgerMessage(messages[0])).toBe(true);
    expect(String(messages[0]!.content)).toContain(
      '- jobId=steady-ivory-panda agent=general startedAt=2026-11-04T02:07:34.000Z writeScope=["src/TCIS.MCP.Docs/**"]',
    );
    // Message region (never persisted), seqs kept in lockstep.
    const seqs = (agent as unknown as { messageSeqs: Array<number | null> }).messageSeqs;
    expect(seqs[0]).toBeNull();
    expect(seqs).toHaveLength(messages.length);
    expect(messages.slice(1).map((m) => m.content)).toEqual([
      "Ship the docs engine",
      "Dispatched a worker for Wave 2.",
    ]);

    // One-shot: later ticks do not re-insert or re-read.
    await agent.consumeBackgroundNotifications();
    expect(ledgersOf(agent)).toHaveLength(1);
  });

  it("is placed right after a leading compaction summary, as compaction places it", async () => {
    const sessionId = seedSession({ compacted: true });
    writeJob(sessionId, { id: "steady-ivory-panda" });

    const agent = resume(sessionId);
    expect(isCompactionSummaryMessage(agent.getMessages()[0])).toBe(true);
    await agent.consumeBackgroundNotifications();

    const messages = agent.getMessages();
    expect(isCompactionSummaryMessage(messages[0])).toBe(true);
    expect(isDelegationLedgerMessage(messages[1])).toBe(true);
    expect(ledgersOf(agent)).toHaveLength(1);
  });

  it("adds nothing when nothing is live", async () => {
    const sessionId = seedSession();
    writeJob("some-other-session", { id: "not-mine" });

    const agent = resume(sessionId);
    const before = agent.getMessages().length;
    await agent.consumeBackgroundNotifications();
    expect(ledgersOf(agent)).toHaveLength(0);
    expect(agent.getMessages()).toHaveLength(before);
  });

  it("replaces a stale ledger found in restored history instead of keeping it", async () => {
    const sessionId = seedSession({
      extra: [{ role: "system", content: `${DELEGATION_LEDGER_HEADER}\nstale jobId=long-gone-worker` }],
    });
    writeJob(sessionId, { id: "steady-ivory-panda" });

    const agent = resume(sessionId);
    expect(ledgersOf(agent)).toHaveLength(1);
    await agent.consumeBackgroundNotifications();

    const ledgers = ledgersOf(agent);
    expect(ledgers).toHaveLength(1);
    expect(String(ledgers[0]!.content)).toContain("jobId=steady-ivory-panda");
    expect(String(ledgers[0]!.content)).not.toContain("long-gone-worker");
    expect(isDelegationLedgerMessage(agent.getMessages()[0])).toBe(true);
  });

  it("is main-session only: a resumed worker gets no ledger and never reads the registry for one", async () => {
    const sessionId = seedSession();
    writeJob(sessionId, { id: "steady-ivory-panda" });

    const agent = resume(sessionId, "worker");
    const delegations = (agent as unknown as { delegations: { ledgerSnapshot: () => Promise<unknown> } }).delegations;
    const spy = vi.spyOn(delegations, "ledgerSnapshot");
    await agent.consumeBackgroundNotifications();
    expect(spy).not.toHaveBeenCalled();
    expect(ledgersOf(agent)).toHaveLength(0);
  });

  it("never inside a background child process", async () => {
    const sessionId = seedSession();
    writeJob(sessionId, { id: "steady-ivory-panda" });
    process.env.MUONROI_BACKGROUND_CHILD = "1";

    const agent = resume(sessionId);
    await agent.consumeBackgroundNotifications();
    expect(ledgersOf(agent)).toHaveLength(0);
  });

  it("a brand-new session (no --session) arms nothing", async () => {
    const agent = new Agent("sk-dummy", undefined, MODEL, undefined, { persistSession: true });
    expect((agent as unknown as { _delegationLedgerRestorePending: boolean })._delegationLedgerRestorePending).toBe(
      false,
    );
  });

  it("a job that finished while the CLI was down: the notice IS delivered on resume and agrees with the ledger", async () => {
    const sessionId = seedSession();
    const jobPath = writeJob(sessionId, { id: "steady-ivory-panda" });
    // The worker completes after the dispatching CLI process exited.
    await completeDelegation(jobPath, "Docs engine shipped; 12 tests pass.");
    const { resultVersion } = JSON.parse(fs.readFileSync(jobPath, "utf8")) as StoredDelegation;
    expect(resultVersion).toMatch(/\S+/);

    const agent = resume(sessionId);
    const notices = await agent.consumeBackgroundNotifications();

    // Delivered by the existing consumeNotifications path (notifiedAt was unset).
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Background agent complete: `steady-ivory-panda`");
    expect(notices[0]).toContain(`resultVersion=${resultVersion}`);
    const stored = JSON.parse(fs.readFileSync(jobPath, "utf8")) as StoredDelegation;
    expect(stored.notifiedAt).toMatch(/\S+/);
    expect(stored.deliveredVersion).toBe(resultVersion);

    // The ledger (taken before delivery) lists the same version as finished-unACKed,
    // never as running — both tell main to read then ACK the same result.
    const ledger = String(ledgersOf(agent)[0]!.content);
    expect(ledger).toContain("Running (0)");
    expect(ledger).toContain(`- jobId=steady-ivory-panda agent=general status=complete resultVersion=${resultVersion}`);

    // Ledger at the head of the restored region, notice appended at the tail.
    const messages = agent.getMessages();
    expect(isDelegationLedgerMessage(messages[0])).toBe(true);
    expect(String(messages.at(-1)!.content)).toContain("Background agent complete: `steady-ivory-panda`");
  });
});
