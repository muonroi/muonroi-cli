/**
 * src/utils/event-loop-monitor.ts
 *
 * Event-loop block detector.
 *
 * Root cause it addresses (observed live, 2026-07-16, session 90c3ff533826):
 * the TUI froze for 304.5s mid-turn — keystrokes and mouse clicks produced
 * nothing during the freeze, then ALL replayed at once when it ended (the
 * signature of a blocked event loop, not a stalled render). Crucially the
 * 120s provider stall watchdog (tool-engine.ts) did NOT rescue the turn at its
 * deadline: `stall_rescue` landed at 09:05:47, 6.7s AFTER the loop recovered at
 * 09:05:41. A setTimeout cannot fire while the loop is blocked, so every
 * existing guard in this codebase is blind to this failure mode BY
 * CONSTRUCTION — they are all loop-driven. Same pattern measured across 4
 * models / 4 providers (grok-composer 304.5s, deepseek-v4-flash 320.2s,
 * kimi-k2.7-code 329.7s + 314.8s), so it is not a provider quirk.
 *
 * This module is the missing instrument: a timer that measures its OWN lateness.
 * It cannot prevent a block (it is loop-driven too), but the drift it observes
 * on the first tick AFTER the loop frees up measures the block that just
 * happened. Pair it with the CPU profiler in `loop-profiler.ts`, whose V8
 * sampling thread runs INDEPENDENTLY of the JS thread and therefore captures
 * the culprit stack DURING the block.
 *
 * Deliberately dependency-free and cheap: one unref'd interval, no allocation
 * per tick. `detectBlock` is pure so the drift maths is unit-testable without
 * timers.
 */

import { logger } from "./logger.js";

/** A detected event-loop block, reported to `onBlock`. */
export interface EventLoopBlock {
  /**
   * How long the loop was blocked, in ms. Measured as the monitor tick's own
   * lateness, so it UNDER-reports by up to one tick interval (a block shorter
   * than the tick can hide entirely between two ticks). Treat it as a lower
   * bound.
   */
  blockedMs: number;
  /** What the process last said it was doing — see {@link setLoopBreadcrumb}. */
  breadcrumb: string | null;
  /** ISO timestamp of the tick that observed the block (i.e. after it ended). */
  detectedAt: string;
}

/**
 * Decide whether an interval tick's lateness constitutes a block.
 *
 * A healthy tick fires ~`tickMs` after the previous one; the loop being busy
 * pushes it later. Lateness beyond `thresholdMs` is reported as a block of that
 * duration. Pure so the drift maths is testable without real timers.
 *
 * @param expectedAt when this tick was due (monotonic ms)
 * @param actualAt when it actually ran (monotonic ms)
 * @param thresholdMs report only blocks at least this long; <= 0 disables
 * @returns block duration in ms, or null when the tick was on time
 */
export function detectBlock(expectedAt: number, actualAt: number, thresholdMs: number): number | null {
  if (!(thresholdMs > 0)) return null;
  const lateBy = actualAt - expectedAt;
  if (!Number.isFinite(lateBy) || lateBy < thresholdMs) return null;
  return Math.round(lateBy);
}

let _breadcrumb: string | null = null;

/**
 * Record what the process is about to do, so a block report can name a suspect
 * instead of just a duration. Call it around anything that could plausibly run
 * long and synchronously (tool execution, a stream step). Cheap — a single
 * assignment; safe to call on a hot path.
 *
 * Pass null to clear. Not a stack: last writer wins, by design — the goal is a
 * hint for the profile, and the profile is the real evidence.
 */
export function setLoopBreadcrumb(label: string | null): void {
  _breadcrumb = label;
}

/** The current breadcrumb, or null. */
export function getLoopBreadcrumb(): string | null {
  return _breadcrumb;
}

/** Options for {@link startEventLoopMonitor}. */
export interface EventLoopMonitorOpts {
  /** Report blocks at least this long. <= 0 disables the monitor entirely. */
  thresholdMs: number;
  /**
   * How often to check. Bounds both the detection granularity and the amount a
   * block can be under-reported by. 500ms costs ~2 wakeups/sec.
   */
  tickMs?: number;
  /** Called once per detected block. Must not throw (it is guarded anyway). */
  onBlock: (block: EventLoopBlock) => void;
}

/**
 * Start watching for event-loop blocks. Returns a stop function (idempotent).
 *
 * The interval is unref'd so it never keeps the process alive on its own.
 */
export function startEventLoopMonitor(opts: EventLoopMonitorOpts): () => void {
  const { thresholdMs, onBlock } = opts;
  const tickMs = opts.tickMs && opts.tickMs > 0 ? opts.tickMs : 500;
  if (!(thresholdMs > 0)) return () => {};

  let expectedAt = performance.now() + tickMs;

  const timer = setInterval(() => {
    const actualAt = performance.now();
    const blockedMs = detectBlock(expectedAt, actualAt, thresholdMs);
    expectedAt = actualAt + tickMs;
    if (blockedMs === null) return;
    try {
      onBlock({
        blockedMs,
        breadcrumb: getLoopBreadcrumb(),
        detectedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error("cli", `[event-loop-monitor] onBlock handler threw: ${(err as Error)?.message}`, {
        error: err,
        blockedMs,
      });
    }
  }, tickMs);

  (timer as unknown as { unref?: () => void }).unref?.();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
