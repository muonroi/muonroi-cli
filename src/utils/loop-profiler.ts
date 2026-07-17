/**
 * src/utils/loop-profiler.ts
 *
 * Rolling V8 CPU profiler — the instrument that names the culprit when the
 * event loop blocks (see `event-loop-monitor.ts` for the incident this exists
 * for).
 *
 * Why a CPU profile and not a stack dump: while the JS thread is blocked, NO
 * JS can run — you cannot ask the process what it is doing, because asking is
 * itself JS. V8's sampling profiler runs on its OWN thread and samples the JS
 * thread regardless of whether that thread is stuck, so the profile taken
 * across a block contains the blocking frames. Verified under Bun 1.3.13: a
 * deliberate 400ms synchronous block yielded 54 samples.
 *
 * Rolling segments keep the retained profile small without losing the block:
 * rotation is loop-driven, so it CANNOT run during a block — whichever segment
 * is in flight when the loop freezes stays in flight for the whole freeze, and
 * is still open when the monitor detects the block right after. So `capture()`
 * always writes a profile containing the entire block, however long it ran.
 *
 * Off by default (`MUONROI_LOOP_PROFILE=1` to arm) — continuous profiling has a
 * real, if small, cost and this is a diagnostic, not a feature.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";

/** Minimal shape of the V8 CPU profile we consume (`Profiler.stop` result). */
interface CpuProfileNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  children?: number[];
}
interface CpuProfile {
  nodes: CpuProfileNode[];
  samples?: number[];
}

/** Frames V8 synthesises; naming one as the culprit tells nobody anything. */
const SYNTHETIC_FRAMES = new Set(["(root)", "(program)", "(idle)", "(garbage collector)", "(anonymous)", ""]);

/**
 * Reduce a CPU profile to the single hottest stack, leaf-first.
 *
 * Why not just the top frame: samples land on the LEAF, which for a blocking
 * loop is whatever primitive it calls (`Date.now`, a regex step, a syscall) —
 * true but useless. Verified on a synthetic 3s block: the leaf was `now` with
 * 188 samples while the actual culprit `theGuiltyFunction` had 4. The CALLERS
 * are the answer, so we walk up from the hottest leaf and return the chain.
 *
 * This is what makes the profile readable from debug.log alone, without
 * requiring anyone to open Chrome DevTools.
 *
 * Pure — unit-testable with a hand-built profile.
 *
 * @param maxFrames how many frames of the chain to return, leaf-first
 * @returns frames like `theGuiltyFunction (file.ts:12)`, or [] if unusable
 */
export function summarizeHotStack(profile: CpuProfile, maxFrames = 8): string[] {
  const samples = profile?.samples;
  const nodes = profile?.nodes;
  if (!Array.isArray(samples) || !Array.isArray(nodes) || samples.length === 0) return [];

  const byId = new Map<number, CpuProfileNode>();
  const parentOf = new Map<number, number>();
  for (const n of nodes) {
    byId.set(n.id, n);
    for (const c of n.children ?? []) parentOf.set(c, n.id);
  }

  const selfCounts = new Map<number, number>();
  for (const s of samples) selfCounts.set(s, (selfCounts.get(s) ?? 0) + 1);

  let hottest = -1;
  let best = -1;
  for (const [id, count] of selfCounts) {
    if (count > best) {
      best = count;
      hottest = id;
    }
  }
  if (hottest < 0) return [];

  const frames: string[] = [];
  const seen = new Set<number>();
  let cur: number | undefined = hottest;
  while (cur !== undefined && !seen.has(cur) && frames.length < maxFrames) {
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    const name = node.callFrame?.functionName ?? "";
    if (!SYNTHETIC_FRAMES.has(name)) {
      const url = node.callFrame?.url ?? "";
      const short = url ? `${url.split(/[\\/]/).pop()}:${(node.callFrame?.lineNumber ?? 0) + 1}` : "native";
      frames.push(`${name} (${short})`);
    }
    cur = parentOf.get(cur);
  }
  return frames;
}

/** What a successful {@link LoopProfiler.capture} produced. */
export interface CaptureResult {
  /** Path of the written `.cpuprofile` (open in Chrome DevTools for detail). */
  file: string;
  /** Hottest stack, leaf-first — readable without DevTools. See {@link summarizeHotStack}. */
  hotStack: string[];
}

/** A rolling CPU profiler. All methods are best-effort and never throw. */
export interface LoopProfiler {
  /**
   * Discard the current segment and start a fresh one. Call periodically from
   * the event loop to bound profile size — it is a no-op during a block, which
   * is exactly what preserves the evidence.
   */
  rotate(): void;
  /**
   * Stop the current segment, write it to disk, and start a fresh one.
   *
   * Async because the inspector delivers `Profiler.stop` on a later tick
   * (measured under Bun 1.3.13 — the callback does NOT run synchronously). The
   * loop is already free by the time this is called, so awaiting is safe.
   *
   * @returns the profile path plus the hottest stack, or null on failure.
   */
  capture(reason: string): Promise<CaptureResult | null>;
  /** Stop profiling and disconnect. Idempotent. */
  dispose(): void;
}

/** Options for {@link createLoopProfiler}. */
export interface LoopProfilerOpts {
  /**
   * V8 sampling interval in microseconds. 10_000 (10ms) is ~100 samples/sec —
   * plenty to identify a multi-second blocking frame, at a fraction of the cost
   * of the 1ms default.
   */
  samplingIntervalUs?: number;
  /** Directory for `.cpuprofile` files. Defaults to `~/.muonroi-cli/profiles`. */
  dir?: string;
}

/**
 * Create and arm a rolling CPU profiler.
 *
 * Returns null when the inspector is unavailable (some runtimes/builds) — the
 * caller keeps the block detector, just without stacks. Never throws.
 */
export async function createLoopProfiler(opts: LoopProfilerOpts = {}): Promise<LoopProfiler | null> {
  const samplingIntervalUs = opts.samplingIntervalUs ?? 10_000;
  const dir = opts.dir ?? path.join(os.homedir(), ".muonroi-cli", "profiles");

  let session: import("node:inspector").Session;
  try {
    const inspector = await import("node:inspector");
    session = new inspector.Session();
    session.connect();
  } catch (err) {
    logger.warn(
      "cli",
      `[loop-profiler] inspector unavailable — block reports will have no stacks: ${(err as Error)?.message}`,
      { error: err },
    );
    return null;
  }

  /** Promise-free post: the profiler is driven from timer callbacks. */
  const post = (method: string, params?: Record<string, unknown>): void => {
    try {
      (session.post as (m: string, p?: unknown, cb?: (err: Error | null) => void) => void)(method, params, (err) => {
        if (err) {
          logger.warn("cli", `[loop-profiler] ${method} failed: ${err.message}`, { error: err });
        }
      });
    } catch (err) {
      logger.warn("cli", `[loop-profiler] ${method} threw: ${(err as Error)?.message}`, { error: err });
    }
  };

  let disposed = false;

  const start = (): void => {
    post("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
    post("Profiler.start");
  };

  try {
    post("Profiler.enable");
    start();
  } catch (err) {
    logger.warn("cli", `[loop-profiler] failed to arm: ${(err as Error)?.message}`, { error: err });
    return null;
  }

  /**
   * Stop the current segment and resolve with its profile (null on failure).
   * Restarts a fresh segment unless disposing.
   */
  const stopSegment = (restart: boolean): Promise<unknown | null> =>
    new Promise((resolve) => {
      try {
        (session.post as (m: string, cb: (err: Error | null, res?: { profile?: unknown }) => void) => void)(
          "Profiler.stop",
          (err, res) => {
            if (err) {
              logger.warn("cli", `[loop-profiler] Profiler.stop failed: ${err.message}`, { error: err });
              resolve(null);
            } else {
              resolve(res?.profile ?? null);
            }
            if (restart && !disposed) start();
          },
        );
      } catch (err) {
        logger.warn("cli", `[loop-profiler] Profiler.stop threw: ${(err as Error)?.message}`, { error: err });
        resolve(null);
      }
    });

  return {
    rotate(): void {
      if (disposed) return;
      // Drop the segment on the floor — it contained no block worth keeping.
      void stopSegment(true);
    },

    async capture(reason: string): Promise<CaptureResult | null> {
      if (disposed) return null;
      const profile = await stopSegment(true);
      if (!profile) return null;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const safeReason = reason.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
        const file = path.join(dir, `loop-block-${stamp}-${safeReason}.cpuprofile`);
        fs.writeFileSync(file, JSON.stringify(profile), "utf8");
        return { file, hotStack: summarizeHotStack(profile as CpuProfile) };
      } catch (err) {
        logger.error("cli", `[loop-profiler] failed to write profile: ${(err as Error)?.message}`, {
          error: err,
          dir,
        });
        return null;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      void stopSegment(false);
      try {
        post("Profiler.disable");
        session.disconnect();
      } catch (err) {
        logger.warn("cli", `[loop-profiler] disconnect failed: ${(err as Error)?.message}`, { error: err });
      }
    },
  };
}
