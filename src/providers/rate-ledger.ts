/**
 * src/providers/rate-ledger.ts
 *
 * Machine-wide provider budget — one ledger per provider shared by EVERY
 * muonroi process on this machine, enforcing the catalog's declared
 * `concurrency`, `requests_per_minute` AND `tokens_per_minute`.
 *
 * WHY THE IN-PROCESS PACER WAS NOT ENOUGH
 * ---------------------------------------
 * `rate-limiter.ts` paces calls inside ONE process. A provider's limits are an
 * ACCOUNT counter, but a background delegation runs as its own CLI process
 * (`--background-task-file`) with its own copy of that pacer. Six explore agents
 * plus the main agent therefore ran with seven full budgets against one account:
 * concurrency 5 became 35 permitted in-flight requests, and the provider's 429s
 * arrived with nothing on our side able to see why. The ledger is the shared
 * state those processes were missing; the in-process pacer stays in front of it
 * for in-process FIFO fairness.
 *
 * WHY TPM IS ENFORCED HERE
 * ------------------------
 * `rate-limiter.ts` skipped TPM because the declared value had three orders of
 * magnitude of headroom over one call. That reasoning is per-call; the budget is
 * per-ACCOUNT-per-minute. Parallel sub-agents each sending ~50k-token prompts
 * exhaust a 500k TPM budget in ~10 calls — well inside the RPM budget — so TPM
 * becomes the binding limit exactly when the agent fans out. A call's cost is
 * not known up front, so the ledger RESERVES an estimate (the gate's chars/4
 * estimate × {@link TPM_ESTIMATE_CALIBRATION}) and corrects it with the
 * provider-reported usage when the call ends.
 *
 * MECHANICS
 * ---------
 * `~/.muonroi-cli/rate-ledger/<provider>.json` holds recent dispatches
 * `{id, pid, at, tokens, inFlight}`. Each acquire takes a short file lock,
 * prunes, and either records a dispatch or computes how long until one fits.
 * Waiting callers poll; cross-process FIFO is not guaranteed (the in-process
 * pacer already gives FIFO within a process).
 *
 * Crash safety: an in-flight entry whose pid is dead, or that outlived
 * {@link IN_FLIGHT_STALE_MS}, stops counting toward concurrency; an abandoned
 * lock file is broken after {@link LOCK_STALE_MS}.
 *
 * Fail-open: any ledger fault (unwritable home dir, corrupt file) degrades to
 * the in-process pacer only — a broken ledger must never stop calls.
 *
 * Disable with `MUONROI_RATE_LIMIT=0` (all pacing) or `MUONROI_RATE_LEDGER=0`
 * (this layer only).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelRateLimits } from "../types/index.js";
import { withFileLock } from "../utils/file-lock.js";
import { RATE_LIMIT_WINDOW_MS } from "./rate-limiter.js";

/** chars/4 under-counts real provider tokens ~2× (see the metered gate notes). */
export const TPM_ESTIMATE_CALIBRATION = 2;

/** An in-flight entry older than this no longer holds a concurrency slot. */
export const IN_FLIGHT_STALE_MS = 15 * 60_000;

/** A lock file older than this is from a crashed holder. The critical section is a few ms. */
const LOCK_STALE_MS = 5_000;

/** Longest single sleep between polls, so a freed slot is noticed promptly. */
const MAX_POLL_MS = 2_000;
const MIN_POLL_MS = 100;

export type LedgerWaitKind = "concurrency" | "requests-per-minute" | "tokens-per-minute";

export interface LedgerWait {
  kind: LedgerWaitKind;
  limit: number;
  /** Planned hold before the next attempt, in ms. */
  waitMs: number;
}

interface LedgerEntry {
  id: string;
  pid: number;
  /** Dispatch time, epoch ms. */
  at: number;
  /** Tokens counted against the TPM window (estimate until corrected). */
  tokens: number;
  inFlight: boolean;
}

interface LedgerFile {
  v: 1;
  entries: LedgerEntry[];
}

export interface LedgerLease {
  /** Replace this call's reserved token count with what the provider reported. */
  settle: (actualTokens: number | undefined) => void;
  /** Free the concurrency slot. Idempotent. */
  release: () => void;
}

/** Injection seams for tests. */
export interface LedgerDeps {
  dir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  pid: number;
}

const NOOP_LEASE: LedgerLease = { settle: () => {}, release: () => {} };

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but not ours — alive. Only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function defaultLedgerDeps(): LedgerDeps {
  return {
    // Resolved lazily and through MUONROI_CLI_HOME, like every other home path,
    // so the test-suite home pin applies.
    dir: path.join(process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli"), "rate-ledger"),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isAlive: defaultIsAlive,
    pid: process.pid,
  };
}

export function ledgerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MUONROI_RATE_LIMIT === "0" || env.MUONROI_RATE_LEDGER === "0";
}

function ledgerPath(dir: string, provider: string): string {
  return path.join(dir, `${provider.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`);
}

async function readLedger(file: string): Promise<LedgerFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as LedgerFile;
    return parsed && Array.isArray(parsed.entries) ? parsed : { v: 1, entries: [] };
  } catch {
    // Missing (first use) or torn by a crash mid-write — start a fresh window.
    return { v: 1, entries: [] };
  }
}

async function writeLedger(file: string, ledger: LedgerFile): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ledger), "utf8");
  await fs.rename(tmp, file);
}

/** Drop entries outside the window; demote in-flight entries whose holder is gone. */
function prune(ledger: LedgerFile, deps: LedgerDeps): void {
  const now = deps.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  for (const e of ledger.entries) {
    if (e.inFlight && (now - e.at > IN_FLIGHT_STALE_MS || (e.pid !== deps.pid && !deps.isAlive(e.pid)))) {
      e.inFlight = false;
    }
  }
  ledger.entries = ledger.entries.filter((e) => e.inFlight || e.at > cutoff);
}

/**
 * Whether a call needing `tokens` fits now. Pure — exported for tests.
 * Returns null when it fits, else the binding limit and how long until it may.
 */
export function evaluateBudget(
  entries: readonly LedgerEntry[],
  limits: ModelRateLimits,
  tokens: number,
  now: number,
): LedgerWait | null {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const inWindow = entries.filter((e) => e.at > windowStart).sort((a, b) => a.at - b.at);

  const concurrency = limits.concurrency;
  if (concurrency && concurrency > 0) {
    const inFlight = entries.filter((e) => e.inFlight).length;
    // A slot frees when some other call ends — unknowable, so poll.
    if (inFlight >= concurrency) return { kind: "concurrency", limit: concurrency, waitMs: 500 };
  }

  const rpm = limits.requestsPerMinute;
  if (rpm && rpm > 0 && inWindow.length >= rpm) {
    const ageOut = inWindow[inWindow.length - rpm]!.at + RATE_LIMIT_WINDOW_MS;
    return { kind: "requests-per-minute", limit: rpm, waitMs: Math.max(0, ageOut - now) };
  }

  const tpm = limits.tokensPerMinute;
  if (tpm && tpm > 0 && inWindow.length > 0) {
    let used = inWindow.reduce((sum, e) => sum + e.tokens, 0);
    // One call bigger than the whole budget is let through on an empty window —
    // waiting could never make it fit, and the provider is the judge of it.
    if (used + tokens > tpm) {
      for (const e of inWindow) {
        used -= e.tokens;
        if (used + tokens <= tpm || used <= 0) {
          return { kind: "tokens-per-minute", limit: tpm, waitMs: Math.max(0, e.at + RATE_LIMIT_WINDOW_MS - now) };
        }
      }
    }
  }
  return null;
}

let warnedFault = false;
function warnFaultOnce(err: unknown): void {
  if (warnedFault) return;
  warnedFault = true;
  console.error(
    `[rate-ledger] shared provider budget unavailable — pacing this process only: ${(err as Error)?.message ?? err}`,
  );
}

/**
 * Hold until a call needing ~`estTokens` fits the provider's machine-wide
 * budget, then record it. The returned lease MUST be released.
 */
export async function acquireLedgerSlot(
  provider: string,
  limits: ModelRateLimits | undefined,
  estTokens: number,
  onWait?: (wait: LedgerWait) => void,
  deps: LedgerDeps = defaultLedgerDeps(),
): Promise<LedgerLease> {
  if (!limits || ledgerDisabled()) return NOOP_LEASE;
  if (!limits.concurrency && !limits.requestsPerMinute && !limits.tokensPerMinute) return NOOP_LEASE;

  const file = ledgerPath(deps.dir, provider);
  const id = randomUUID();
  const tokens = Math.max(0, Math.round(estTokens));
  let lastKind: LedgerWaitKind | null = null;

  try {
    await fs.mkdir(deps.dir, { recursive: true });
    while (true) {
      const wait = await withFileLock(
        file,
        async () => {
          const ledger = await readLedger(file);
          prune(ledger, deps);
          const blocked = evaluateBudget(ledger.entries, limits, tokens, deps.now());
          if (!blocked) {
            ledger.entries.push({ id, pid: deps.pid, at: deps.now(), tokens, inFlight: true });
          }
          await writeLedger(file, ledger);
          return blocked;
        },
        { staleMs: LOCK_STALE_MS },
      );
      if (!wait) break;
      // Announce once per distinct reason, not on every poll.
      if (wait.kind !== lastKind) {
        lastKind = wait.kind;
        onWait?.(wait);
      }
      await deps.sleep(Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, wait.waitMs)));
    }
  } catch (err) {
    warnFaultOnce(err);
    return NOOP_LEASE;
  }

  const update = (fn: (e: LedgerEntry) => void) => {
    void withFileLock(
      file,
      async () => {
        const ledger = await readLedger(file);
        const entry = ledger.entries.find((e) => e.id === id);
        if (!entry) return;
        fn(entry);
        await writeLedger(file, ledger);
      },
      { staleMs: LOCK_STALE_MS },
    ).catch(warnFaultOnce);
  };
  let released = false;
  return {
    settle: (actual) => {
      if (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) {
        update((e) => {
          e.tokens = Math.round(actual);
        });
      }
    },
    release: () => {
      if (released) return;
      released = true;
      update((e) => {
        e.inFlight = false;
      });
    },
  };
}

/**
 * Total tokens a finished call cost, from an AI-SDK usage object. Handles the
 * flat (`inputTokens: number`) and nested (`inputTokens: {total}`) shapes.
 */
export function usageTotalTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const pick = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && typeof (v as { total?: unknown }).total === "number") {
      return (v as { total: number }).total;
    }
    return undefined;
  };
  const input = pick(u.inputTokens);
  const output = pick(u.outputTokens);
  if (input === undefined && output === undefined) {
    return typeof u.totalTokens === "number" ? u.totalTokens : undefined;
  }
  return (input ?? 0) + (output ?? 0);
}
