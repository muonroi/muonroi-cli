/**
 * The autopilot state rides with the `/ideal` run record (`__ideal_run`) through
 * the real Agent and real SQLite: armed by `/ideal start`, durable across a CLI
 * restart, stopped by the user (Esc / typed message / `/ideal abort`), re-armed by
 * `/ideal resume`, and shown by `/ideal status`.
 *
 * Only the model turn and the delegation ledger are stubbed (as in
 * ideal-run-persistence.test.ts, whose setup this mirrors).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { getLastIdealRun, persistIdealRun } from "../../storage/transcript.js";
import { Agent } from "../orchestrator.js";

const MODEL = "deepseek-v4-flash";
const GOAL = "Build the parser";
const FLAGS = { doneThreshold: 90 };

let tmpHome: string;
let prevHome: string | undefined;
let prevProfile: string | undefined;

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-ideal-autopilot-"));
  prevHome = process.env.HOME;
  prevProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  closeDatabase();
  getDatabase(); // migrate the temp DB
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevProfile;
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
  vi.spyOn((agent as any).delegations, "ledgerSnapshot").mockResolvedValue([]);
  return agent;
}

const run = (agent: Agent, subcommand: "start" | "status" | "resume" | "abort") =>
  drain(agent.runProductLoopV1({ subcommand, idea: subcommand === "start" ? GOAL : undefined, flags: FLAGS }) as never);
const status = async (agent: Agent) => (await run(agent, "status"))[0]!.content!;

describe("storage: autopilot block of the run record", () => {
  it("round-trips, and a block this build cannot read does not take the run down with it", () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workspaces (id, scope_key, canonical_path, display_name, last_seen_at) VALUES ('w', 'scope', '/w', 'w', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at) VALUES ('s-ap', 'w', 'm', 'agent', '/w', '/w', 'active', ?, ?)",
    ).run(now, now);
    const autopilot = {
      status: "stopped" as const,
      armedAt: "2026-11-09T10:00:00.000Z",
      turns: 4,
      totalTurns: 6,
      noProgressStreak: 2,
      signals: { workspace: "abc", delegationsStarted: 3, delegationsFinished: 2, flow: "plan|verified|missing|-|-" },
      spentUsd: 1.5,
      stop: { reason: "no_progress" as const, detail: "3 turns", at: "2026-11-09T11:00:00.000Z" },
    };
    expect(persistIdealRun("s-ap", { goal: "g", startedAt: "2026-11-09T10:00:00.000Z", autopilot })).toBe(true);
    expect(getLastIdealRun("s-ap")).toEqual({ goal: "g", startedAt: "2026-11-09T10:00:00.000Z", autopilot });

    expect(
      persistIdealRun("s-ap", {
        goal: "g2",
        startedAt: "2026-11-09T12:00:00.000Z",
        autopilot: { ...autopilot, stop: { ...autopilot.stop, reason: "bogus" as never } },
      }),
    ).toBe(true);
    expect(getLastIdealRun("s-ap")).toEqual({ goal: "g2", startedAt: "2026-11-09T12:00:00.000Z" });
  });
});

describe("Agent: autopilot over the run record", () => {
  it("/ideal start arms it; a turn end continues with a host-tagged prompt; a restarted agent resumes the count", async () => {
    const first = newAgent();
    const sessionId = first.getSessionId()!;
    await run(first, "start");
    expect(getLastIdealRun(sessionId)?.autopilot).toMatchObject({ status: "running", turns: 0 });
    expect(first.isIdealAutopilotRunning()).toBe(true);

    const decision = await first.idealAutopilotAfterTurn({});
    expect(decision).toMatchObject({ action: "continue" });
    expect(decision.action === "continue" && decision.prompt).toContain("[host: /ideal autopilot");
    expect(getLastIdealRun(sessionId)?.autopilot).toMatchObject({ status: "running", turns: 1 });
    await first.cleanup();

    // "Restart": a brand-new Agent over the same session.
    const resumed = newAgent(sessionId);
    expect(resumed.isIdealAutopilotRunning()).toBe(true);
    const text = await status(resumed);
    expect(text).toContain("Autopilot: running");
    expect(text).toContain("turn 1/");
    await resumed.cleanup();
  });

  it("Esc and a typed message stop it durably; status names the reason; resume re-arms with the total kept", async () => {
    const agent = newAgent();
    const sessionId = agent.getSessionId()!;
    await run(agent, "start");
    await agent.idealAutopilotAfterTurn({});

    agent.abort(); // Esc / Ctrl+C
    expect(agent.isIdealAutopilotRunning()).toBe(false);
    expect(getLastIdealRun(sessionId)?.autopilot).toMatchObject({
      status: "stopped",
      stop: { reason: "user_interrupt" },
    });
    expect(await agent.idealAutopilotAfterTurn({})).toEqual({ action: "none" });
    expect(await status(agent)).toContain("stopped (user_interrupt)");

    await run(agent, "resume");
    expect(getLastIdealRun(sessionId)?.autopilot).toMatchObject({ status: "running", turns: 0, totalTurns: 1 });

    agent.yieldIdealAutopilot("user_message");
    expect(getLastIdealRun(sessionId)?.autopilot?.stop?.reason).toBe("user_message");
    await agent.cleanup();
  });

  it("/ideal abort stops the autopilot before closing the run", async () => {
    const agent = newAgent();
    await run(agent, "start");
    await run(agent, "abort");
    expect(agent.isIdealAutopilotRunning()).toBe(false);
    expect(getLastIdealRun(agent.getSessionId()!)).toBeNull();
    expect(await agent.idealAutopilotAfterTurn({})).toEqual({ action: "none" });
    await agent.cleanup();
  });

  it("MUONROI_IDEAL_AUTOPILOT=0 never arms one: the old one-turn-per-human-message behaviour", async () => {
    vi.stubEnv("MUONROI_IDEAL_AUTOPILOT", "0");
    const off = newAgent();
    await run(off, "start");
    expect(getLastIdealRun(off.getSessionId()!)?.autopilot).toBeUndefined();
    expect(await off.idealAutopilotAfterTurn({})).toEqual({ action: "none" });
    expect(await status(off)).toContain("Autopilot: off");
    await off.cleanup();
  });

  it("a non-orchestrator agent never has an autopilot", async () => {
    const plain = new Agent("fixture-key", undefined, MODEL, 1, { persistSession: true });
    expect(await plain.idealAutopilotAfterTurn({})).toEqual({ action: "none" });
    expect(plain.isIdealAutopilotRunning()).toBe(false);
    await plain.cleanup();
  });
});
