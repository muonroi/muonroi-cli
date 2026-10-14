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
 * PROVIDER COOLDOWN (the reactive half)
 * -------------------------------------
 * The declared budget is our MODEL of the account; the provider's 429 is the
 * truth. When any process gets a rate-limit answer from provider P, it records
 * `cooldown.until` in P's ledger ({@link noteProviderRateLimited}) — from the
 * provider's Retry-After when sent, else the backoff step — and every process's
 * next call to P holds until it passes ({@link acquireLedgerSlot}). Without it,
 * six background agents that each got their own 429 would each retry on their
 * own schedule and keep the window full for one another. This applies to EVERY
 * provider, including those whose catalog entry declares no `rate_limits`: for
 * them the acquire is a single lock-free read of the ledger file (ENOENT when
 * the provider has never pushed back), so the common path stays cheap.
 * Consecutive refusals escalate the cooldown (`strikes`); a 429 that lands while
 * a cooldown is still active (a request dispatched before it began) does not.
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
import { rateLimitBackoffMs } from "./rate-limit-backoff.js";
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

export type LedgerWaitKind = "concurrency" | "requests-per-minute" | "tokens-per-minute" | "provider-cooldown";

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

/** The provider said 429: every process holds calls to it until `until`. */
interface LedgerCooldown {
  /** Epoch ms the cooldown lifts. */
  until: number;
  /** Consecutive refusals that each outlasted the previous cooldown. */
  strikes: number;
  /** When it was last set or extended, epoch ms. */
  at: number;
}

interface LedgerFile {
  v: 1;
  entries: LedgerEntry[];
  cooldown?: LedgerCooldown;
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
    if (!parsed || typeof parsed !== "object") return { v: 1, entries: [] };
    // Keep the cooldown even when entries are missing — it is the shared 429 state.
    return { ...parsed, v: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
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

/**
 * Lease settle/release writes are fire-and-forget: a call must not wait on
 * bookkeeping after its stream ended. They are still TRACKED, so whoever owns
 * the ledger directory's lifetime can wait for them before removing it —
 * without that, a release still holding the lock file or a temp file races the
 * removal (seen on macOS as `ENOTEMPTY` from `rmSync` after a test).
 */
const pendingLedgerWrites = new Set<Promise<unknown>>();

function trackLedgerWrite(write: Promise<unknown>): void {
  pendingLedgerWrites.add(write);
  void write.finally(() => pendingLedgerWrites.delete(write));
}

/** Resolve once every lease write started so far has landed (or failed and been logged). */
export async function settleLedgerWrites(): Promise<void> {
  while (pendingLedgerWrites.size > 0) await Promise.allSettled([...pendingLedgerWrites]);
}

let warnedFault = false;
function warnFaultOnce(err: unknown): void {
  if (warnedFault) return;
  warnedFault = true;
  console.error(
    `[rate-ledger] shared provider budget unavailable — pacing this process only: ${(err as Error)?.message ?? err}`,
  );
}

/** The active provider cooldown as a wait, or null when none is in force. */
function cooldownWait(ledger: LedgerFile, now: number): LedgerWait | null {
  const until = ledger.cooldown?.until;
  if (typeof until !== "number" || !Number.isFinite(until) || until <= now) return null;
  // `limit` names a declared ceiling for the other kinds; a cooldown has none.
  return { kind: "provider-cooldown", limit: 0, waitMs: until - now };
}

/**
 * Hold until provider P's cooldown (if any) has passed. Lock-free: a reader
 * that races a writer sees either the old or the new file (writes are an atomic
 * rename), and either answer is safe — the worst case is one extra poll.
 */
async function waitOutCooldown(
  file: string,
  onWait: ((wait: LedgerWait) => void) | undefined,
  deps: LedgerDeps,
): Promise<void> {
  let announced = false;
  while (true) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      // ENOENT is the common case: this provider never pushed back.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") warnFaultOnce(err);
      return;
    }
    let wait: LedgerWait | null;
    try {
      wait = cooldownWait(JSON.parse(raw) as LedgerFile, deps.now());
    } catch {
      // Torn/corrupt file — no cooldown can be read, so none is enforced.
      return;
    }
    if (!wait) return;
    if (!announced) {
      announced = true;
      onWait?.(wait);
    }
    await deps.sleep(Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, wait.waitMs)));
  }
}

/**
 * Record that provider P just answered with a rate limit, and return how long
 * this caller should wait before trying again — the time until the SHARED
 * cooldown lifts, which every process honours.
 *
 * - The provider's Retry-After (`hintMs`) wins when present.
 * - A refusal that arrives after the previous cooldown already lifted (within a
 *   window) escalates `strikes`, and the backoff with it: the last pause was not
 *   long enough. One that arrives WHILE a cooldown is active was dispatched
 *   before it began; it neither escalates nor shortens anything.
 * - The cooldown only ever extends (`max`), never shrinks.
 *
 * Ledger disabled or faulty → the caller's own proposal: it waits alone.
 */
export async function noteProviderRateLimited(
  provider: string,
  proposal: { proposedMs: number; hintMs: number | null },
  deps: LedgerDeps = defaultLedgerDeps(),
): Promise<number> {
  const fallback = Math.max(0, proposal.hintMs ?? proposal.proposedMs);
  if (ledgerDisabled()) return fallback;
  const file = ledgerPath(deps.dir, provider);
  try {
    await fs.mkdir(deps.dir, { recursive: true });
    return await withFileLock(
      file,
      async () => {
        const ledger = await readLedger(file);
        const now = deps.now();
        const prev = ledger.cooldown;
        let strikes: number;
        let delay: number;
        if (prev && prev.until > now) {
          strikes = prev.strikes;
          delay = proposal.hintMs ?? 0;
        } else {
          strikes = prev && now - prev.until < RATE_LIMIT_WINDOW_MS ? prev.strikes + 1 : 1;
          delay = proposal.hintMs ?? Math.max(proposal.proposedMs, rateLimitBackoffMs(strikes));
        }
        const until = Math.max(prev?.until ?? 0, now + Math.max(0, delay));
        ledger.cooldown = { until, strikes, at: now };
        await writeLedger(file, ledger);
        return until - now;
      },
      { staleMs: LOCK_STALE_MS },
    );
  } catch (err) {
    warnFaultOnce(err);
    return fallback;
  }
}

/**
 * Hold until a call needing ~`estTokens` fits the provider's machine-wide
 * budget, then record it. The returned lease MUST be released.
 *
 * A provider cooldown (see {@link noteProviderRateLimited}) holds the call
 * first — also for a provider that declares no limits at all, which then gets
 * the cheap lock-free check and a no-op lease.
 */
export async function acquireLedgerSlot(
  provider: string,
  limits: ModelRateLimits | undefined,
  estTokens: number,
  onWait?: (wait: LedgerWait) => void,
  deps: LedgerDeps = defaultLedgerDeps(),
): Promise<LedgerLease> {
  if (ledgerDisabled()) return NOOP_LEASE;
  const file = ledgerPath(deps.dir, provider);
  if (!limits || (!limits.concurrency && !limits.requestsPerMinute && !limits.tokensPerMinute)) {
    await waitOutCooldown(file, onWait, deps);
    return NOOP_LEASE;
  }

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
          const blocked =
            cooldownWait(ledger, deps.now()) ?? evaluateBudget(ledger.entries, limits, tokens, deps.now());
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
    trackLedgerWrite(
      withFileLock(
        file,
        async () => {
          const ledger = await readLedger(file);
          const entry = ledger.entries.find((e) => e.id === id);
          if (!entry) return;
          fn(entry);
          await writeLedger(file, ledger);
        },
        { staleMs: LOCK_STALE_MS },
      ).catch(warnFaultOnce),
    );
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
