/**
 * Host-carried delegation ledger across the MAIN session's summarizing
 * compaction (`Agent.compactForContext`).
 *
 * Measured defect (session 4edc02516a92): worker steady-ivory-panda was
 * dispatched at 02:07:34Z; compaction id=343 (02:09:26Z) and id=344 dropped
 * it, and at 02:16:54Z the orchestrator dispatched steady-indigo-heron for the
 * same work. The summarizer is mocked here to return a summary that never
 * mentions the job — the ledger must still be present afterwards.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTestProviderFactories } from "../../__test-helpers__/catalog-fixtures.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";

const summarizerInputs: unknown[] = [];
vi.mock("../compaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compaction.js")>();
  return {
    ...actual,
    proposeCompaction: vi.fn(async () => null),
    generateCompactionSummary: vi.fn(async (_modelId: string, preparation: unknown) => {
      summarizerInputs.push(preparation);
      return {
        summary: "## Goal\nShip docs engine. (summary forgot every worker)",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    }),
  };
});

import { __resetCompactionModelCooldownForTests } from "../compaction-model-cooldown.js";
import { DELEGATION_LEDGER_HEADER, isDelegationLedgerMessage } from "../delegation-ledger.js";
import {
  completeDelegation,
  type DelegationLedgerEntry,
  DelegationManager,
  type StoredDelegation,
} from "../delegations.js";
import { Agent } from "../orchestrator.js";

beforeAll(async () => {
  await loadCatalog();
  registerTestProviderFactories();
});

beforeEach(() => {
  summarizerInputs.length = 0;
  __resetCompactionModelCooldownForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  try {
    closeDatabase();
  } catch (err) {
    // The DB may never have been opened by a test that bailed early.
    console.debug(`[compaction-delegation-ledger.test] closeDatabase: ${(err as Error).message}`);
  }
});

function longConversation(): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < 60; i++) {
    out.push({ role: "user", content: `Question ${i}: ${"detail ".repeat(2000)}` });
    out.push({ role: "assistant", content: `Answer ${i}: ${"context ".repeat(2000)}` });
  }
  return out;
}

const RUNNING: DelegationLedgerEntry = {
  id: "steady-ivory-panda",
  agent: "general",
  description: "Wave 2: Docs engine TCIS.MCP.Docs + unit tests",
  status: "running",
  startedAt: "2026-11-04T02:07:34.000Z",
  writeScope: ["src/TCIS.MCP.Docs/**"],
  acknowledged: false,
};

function makeAgent(snapshot: () => Promise<DelegationLedgerEntry[]>, role: "orchestrator" | "worker" = "orchestrator") {
  const agent = new Agent("sk-dummy", undefined, "deepseek-v4-pro", undefined, {
    persistSession: true,
    executionRole: "infrastructure",
  });
  // biome-ignore lint/suspicious/noExplicitAny: private state is the pragmatic seam (mirrors compact-summary-failure.test.ts)
  const a = agent as any;
  a.executionRole = role;
  a.delegations = { ledgerSnapshot: vi.fn(snapshot) };
  a.messages = longConversation();
  a.messageSeqs = a.messages.map((_: unknown, i: number) => i + 1);
  return a;
}

const compact = (a: { compactForContext: (...args: unknown[]) => Promise<boolean> }) =>
  a.compactForContext("deepseek", "You are a helpful assistant.", 8000, new AbortController().signal, undefined, true);

describe("compactForContext carries the live delegation ledger (session 4edc02516a92, compaction id=343)", () => {
  it("appends the ledger right after the summary even though the summary omits the running job", async () => {
    const a = makeAgent(async () => [RUNNING]);
    expect(await compact(a)).toBe(true);

    const messages = a.messages as ModelMessage[];
    expect(String(messages[0]!.content)).not.toContain("steady-ivory-panda");
    expect(isDelegationLedgerMessage(messages[1])).toBe(true);
    expect(String(messages[1]!.content)).toContain(
      '- jobId=steady-ivory-panda agent=general startedAt=2026-11-04T02:07:34.000Z writeScope=["src/TCIS.MCP.Docs/**"]',
    );
    expect(a.messageSeqs[1]).toBeNull();
    expect(a.messageSeqs).toHaveLength(messages.length);
  }, 15_000);

  it("adds nothing when no job is live", async () => {
    const a = makeAgent(async () => []);
    expect(await compact(a)).toBe(true);
    expect((a.messages as ModelMessage[]).some(isDelegationLedgerMessage)).toBe(false);
  }, 15_000);

  it("still compacts, without a ledger, when the registry read fails", async () => {
    const a = makeAgent(async () => {
      throw new Error("fixture EACCES");
    });
    expect(await compact(a)).toBe(true);
    expect((a.messages as ModelMessage[]).some(isDelegationLedgerMessage)).toBe(false);
  }, 15_000);

  it("is main-session only: a worker's compaction carries no ledger", async () => {
    const a = makeAgent(async () => [RUNNING], "worker");
    expect(await compact(a)).toBe(true);
    expect(a.delegations.ledgerSnapshot).not.toHaveBeenCalled();
    expect((a.messages as ModelMessage[]).some(isDelegationLedgerMessage)).toBe(false);
  }, 15_000);

  it("replaces a stale ledger instead of summarizing or keeping it", async () => {
    let live: DelegationLedgerEntry[] = [RUNNING];
    const a = makeAgent(async () => live);
    expect(await compact(a)).toBe(true);

    // The job finishes; history grows again behind [summary, ledger].
    live = [{ ...RUNNING, status: "complete", resultVersion: "v-final", completedAt: "2026-11-04T02:28:00.000Z" }];
    a.messages = [...(a.messages as ModelMessage[]).slice(0, 2), ...longConversation()];
    a.messageSeqs = (a.messages as ModelMessage[]).map((_: unknown, i: number) => (i < 2 ? null : 1000 + i));
    summarizerInputs.length = 0;
    expect(await compact(a)).toBe(true);

    const prep = summarizerInputs[0] as { messagesToSummarize: ModelMessage[]; turnPrefixMessages: ModelMessage[] };
    expect([...prep.messagesToSummarize, ...prep.turnPrefixMessages].some(isDelegationLedgerMessage)).toBe(false);
    const ledgers = (a.messages as ModelMessage[]).filter(isDelegationLedgerMessage);
    expect(ledgers).toHaveLength(1);
    expect(String(ledgers[0]!.content)).toContain("status=complete resultVersion=v-final");
    expect(String(ledgers[0]!.content)).toContain("Running (0)");
  }, 15_000);

  it("manual /compact re-attaches a fresh ledger after the summary and drops a stale one", async () => {
    const a = makeAgent(async () => [RUNNING]);
    a.setMessages([
      { role: "system", content: "[Context checkpoint summary]\nmanual" },
      { role: "system", content: `${DELEGATION_LEDGER_HEADER}\nstale` },
    ]);
    await a.carryDelegationLedgerAfterCompaction();
    const messages = a.messages as ModelMessage[];
    expect(messages).toHaveLength(2);
    expect(isDelegationLedgerMessage(messages[1])).toBe(true);
    expect(String(messages[1]!.content)).toContain("jobId=steady-ivory-panda");
    expect(String(messages[1]!.content)).not.toContain("stale");
    expect(a.messageSeqs).toEqual([null, null]);
  });
});

describe("DelegationManager.ledgerSnapshot", () => {
  let home: string;
  let cwd: string;
  let dir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-ledger-"));
    cwd = path.join(home, "workspace");
    dir = path.join(home, "delegations", `workspace-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    vi.stubEnv("MUONROI_CLI_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function write(record: Partial<StoredDelegation> & { id: string }): string {
    const jobPath = path.join(dir, `${record.id}.json`);
    const full: StoredDelegation = {
      agent: "general",
      description: `job ${record.id}`,
      prompt: "p",
      cwd,
      model: "fixture",
      sandboxMode: "off",
      maxToolRounds: 1,
      maxTokens: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath: path.join(dir, `${record.id}.md`),
      parentSessionId: "owner",
      pid: process.pid,
      ...record,
    };
    fs.writeFileSync(jobPath, JSON.stringify(full));
    return jobPath;
  }

  it("reports running scope, open questions and un-ACKed results for the owner only, without marking delivery", async () => {
    const now = Date.now();
    write({
      id: "steady-ivory-panda",
      startedAt: new Date(now - 60_000).toISOString(),
      writeScope: ["src/a.ts"],
      mailbox: {
        nextSequence: 2,
        totalBytes: 10,
        messages: [
          {
            id: "q-1",
            sequence: 1,
            sender: "worker",
            kind: "question",
            text: "Which file?",
            toolCallId: "tc",
            createdAt: new Date(now).toISOString(),
            deadlineAt: new Date(now + 60_000).toISOString(),
          },
        ],
      },
    });
    const donePath = write({ id: "calm-blue-panda", startedAt: new Date(now - 120_000).toISOString() });
    await completeDelegation(donePath, "Done.");
    write({ id: "other-owner", parentSessionId: "someone-else" });

    const manager = new DelegationManager(
      () => cwd,
      () => "owner",
    );
    const snapshot = await manager.ledgerSnapshot();
    expect(snapshot.map((e) => e.id)).toEqual(["calm-blue-panda", "steady-ivory-panda"]);
    const runningEntry = snapshot.find((e) => e.id === "steady-ivory-panda")!;
    expect(runningEntry).toMatchObject({ status: "running", writeScope: ["src/a.ts"], pendingQuestionId: "q-1" });
    const done = snapshot.find((e) => e.id === "calm-blue-panda")!;
    expect(done.status).toBe("complete");
    expect(done.resultVersion).toMatch(/\S+/);
    expect(done.acknowledged).toBe(false);
    expect(done.writeScope).toBeUndefined();

    const stored = JSON.parse(fs.readFileSync(donePath, "utf8")) as StoredDelegation;
    expect(stored.deliveredVersion).toBeUndefined();
    expect(stored.notifiedAt).toBeUndefined();
  });
});
