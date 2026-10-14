/**
 * The ledger is the budget shared by every muonroi process. These tests stand
 * in for several processes by giving each caller its own pid against one
 * ledger directory, on a fake clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLedgerSlot,
  evaluateBudget,
  type LedgerDeps,
  noteProviderRateLimited,
  usageTotalTokens,
} from "../rate-ledger.js";

let dir: string;
let clock: number;
let alive: Set<number>;
const prevEnv = process.env.MUONROI_RATE_LEDGER;

function deps(pid: number, sleeps: number[] = []): LedgerDeps {
  return {
    dir,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    isAlive: (p) => alive.has(p),
    pid,
  };
}

/** Let the lease's fire-and-forget ledger update land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-ledger-"));
  clock = 1_000_000;
  alive = new Set([1, 2, 3]);
  process.env.MUONROI_RATE_LEDGER = "1";
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.MUONROI_RATE_LEDGER;
  else process.env.MUONROI_RATE_LEDGER = prevEnv;
});

describe("evaluateBudget", () => {
  const e = (at: number, tokens = 0, inFlight = false) => ({ id: `${at}`, pid: 1, at, tokens, inFlight });

  it("fits an empty window", () => {
    expect(evaluateBudget([], { concurrency: 1, requestsPerMinute: 1, tokensPerMinute: 10 }, 5, 0)).toBeNull();
  });

  it("blocks on concurrency while slots are in flight", () => {
    expect(evaluateBudget([e(0, 0, true)], { concurrency: 1 }, 0, 10)?.kind).toBe("concurrency");
  });

  it("waits for the oldest request to age out of the RPM window", () => {
    const w = evaluateBudget([e(0), e(10_000)], { requestsPerMinute: 2 }, 0, 20_000);
    expect(w).toEqual({ kind: "requests-per-minute", limit: 2, waitMs: 40_000 });
  });

  it("waits until enough tokens age out of the TPM window", () => {
    const w = evaluateBudget([e(0, 300), e(30_000, 300)], { tokensPerMinute: 700 }, 200, 40_000);
    // Dropping the first entry (at 0) frees enough: 300 + 200 <= 700.
    expect(w).toEqual({ kind: "tokens-per-minute", limit: 700, waitMs: 20_000 });
  });

  it("lets an oversized call through only once the window is empty", () => {
    expect(evaluateBudget([e(0, 10)], { tokensPerMinute: 100 }, 500, 1_000)?.waitMs).toBe(59_000);
    expect(evaluateBudget([], { tokensPerMinute: 100 }, 500, 1_000)).toBeNull();
  });
});

describe("acquireLedgerSlot across processes", () => {
  it("shares one concurrency budget between processes", async () => {
    const limits = { concurrency: 2 };
    const a = await acquireLedgerSlot("stepfun", limits, 0, undefined, deps(1));
    await acquireLedgerSlot("stepfun", limits, 0, undefined, deps(2));

    // Process 3 must wait until one of the other two releases.
    const waits: string[] = [];
    const third = acquireLedgerSlot("stepfun", limits, 0, (w) => waits.push(w.kind), deps(3));
    await new Promise((r) => setTimeout(r, 30));
    a.release();
    await third;
    expect(waits).toEqual(["concurrency"]);
  });

  it("frees the slot of a process that died without releasing", async () => {
    await acquireLedgerSlot("stepfun", { concurrency: 1 }, 0, undefined, deps(1));
    alive.delete(1);
    const sleeps: number[] = [];
    await acquireLedgerSlot("stepfun", { concurrency: 1 }, 0, undefined, deps(2, sleeps));
    expect(sleeps).toEqual([]);
  });

  it("holds a call that would exceed the shared TPM budget, then admits it", async () => {
    const limits = { tokensPerMinute: 100_000 };
    (await acquireLedgerSlot("stepfun", limits, 80_000, undefined, deps(1))).release();
    const sleeps: number[] = [];
    const waits: string[] = [];
    await acquireLedgerSlot("stepfun", limits, 50_000, (w) => waits.push(w.kind), deps(2, sleeps));
    expect(waits).toEqual(["tokens-per-minute"]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it("corrects the reservation with the reported usage", async () => {
    const limits = { tokensPerMinute: 100_000 };
    const lease = await acquireLedgerSlot("stepfun", limits, 90_000, undefined, deps(1));
    lease.settle(1_000);
    lease.release();
    await flush();
    const sleeps: number[] = [];
    await acquireLedgerSlot("stepfun", limits, 50_000, undefined, deps(2, sleeps));
    expect(sleeps).toEqual([]);
  });

  it("is a no-op when disabled or when nothing is declared", async () => {
    process.env.MUONROI_RATE_LEDGER = "0";
    await acquireLedgerSlot("stepfun", { concurrency: 1 }, 0, undefined, deps(1));
    await acquireLedgerSlot("stepfun", { concurrency: 1 }, 0, undefined, deps(2));
    process.env.MUONROI_RATE_LEDGER = "1";
    await acquireLedgerSlot("other", {}, 0, undefined, deps(1));
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("provider cooldown (a 429 anywhere holds every process)", () => {
  it("holds another process's next call until the cooldown lifts — declared limits", async () => {
    const wait = await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: null }, deps(1));
    expect(wait).toBeGreaterThanOrEqual(4_000);
    const sleeps: number[] = [];
    const waits: Array<{ kind: string; limit: number }> = [];
    const lease = await acquireLedgerSlot(
      "acme",
      { concurrency: 5 },
      0,
      (w) => waits.push({ kind: w.kind, limit: w.limit }),
      deps(2, sleeps),
    );
    lease.release();
    expect(waits).toEqual([{ kind: "provider-cooldown", limit: 0 }]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(wait);
  });

  it("also holds a provider whose catalog declares NO limits", async () => {
    await noteProviderRateLimited("undeclared", { proposedMs: 5_000, hintMs: 30_000 }, deps(1));
    const sleeps: number[] = [];
    const waits: string[] = [];
    await acquireLedgerSlot("undeclared", undefined, 0, (w) => waits.push(w.kind), deps(2, sleeps));
    expect(waits).toEqual(["provider-cooldown"]);
    // The provider's Retry-After (30s) set the shared deadline.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30_000);
    // Once lifted, the next call goes straight through.
    const after: number[] = [];
    await acquireLedgerSlot("undeclared", {}, 0, undefined, deps(3, after));
    expect(after).toEqual([]);
  });

  it("escalates when a refusal follows a lifted cooldown, not while one is active", async () => {
    const first = await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: null }, deps(1));
    // A concurrent in-flight request refused DURING the cooldown: no escalation,
    // and the deadline is shared (this caller waits for the same instant).
    clock += 1_000;
    const concurrent = await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: null }, deps(2));
    expect(concurrent).toBe(first - 1_000);
    // After it lifted, refused again: the pause was too short → longer one.
    clock += first;
    const second = await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: null }, deps(1));
    expect(second).toBeGreaterThanOrEqual(6_400); // strike 2 → 8s ± 20%
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, "acme.json"), "utf8"));
    expect(ledger.cooldown.strikes).toBe(2);
  });

  it("only extends, never shortens, the shared deadline", async () => {
    const long = await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: 50_000 }, deps(1));
    const short = await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: 1_000 }, deps(2));
    expect(long).toBe(50_000);
    expect(short).toBe(50_000);
  });

  it("disabled ledger: the caller waits on its own proposal and nothing is written", async () => {
    process.env.MUONROI_RATE_LEDGER = "0";
    expect(await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: null }, deps(1))).toBe(4_000);
    expect(await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: 9_000 }, deps(1))).toBe(9_000);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps the cooldown when the declared-limit path rewrites the file", async () => {
    await noteProviderRateLimited("acme", { proposedMs: 4_000, hintMs: 20_000 }, deps(1));
    // A dispatch record written by the slot path must not drop the cooldown.
    clock += 21_000;
    (await acquireLedgerSlot("acme", { requestsPerMinute: 100 }, 0, undefined, deps(2))).release();
    await flush();
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, "acme.json"), "utf8"));
    expect(ledger.cooldown).toMatchObject({ strikes: 1 });
    expect(ledger.entries).toHaveLength(1);
  });
});

describe("usageTotalTokens", () => {
  it("reads flat and nested AI-SDK usage shapes", () => {
    expect(usageTotalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15);
    expect(usageTotalTokens({ inputTokens: { total: 10 }, outputTokens: { total: 7 } })).toBe(17);
    expect(usageTotalTokens({ totalTokens: 9 })).toBe(9);
    expect(usageTotalTokens(undefined)).toBeUndefined();
  });
});
