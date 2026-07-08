/**
 * src/orchestrator/turn-watchdog.ts
 *
 * Generic idle + total watchdog for a turn generator.
 *
 * The per-chunk stall watchdog (stall-watchdog.ts) only guards streamText's
 * chunk flow — a dead socket between provider bytes. It does NOT cover a turn
 * that WEDGES inside a tool call (a `task` sub-agent or a `bash` that never
 * returns) or one that keeps emitting heartbeat chunks while making no progress.
 * Session 578b2eae7099 hung exactly there: an (unwanted) implementation turn
 * spawned a sub-agent and the UI froze at "Council working… elapsed 0s" with no
 * rescue.
 *
 * This wrapper races each `gen.next()` against two timers:
 *   - `idleMs` — reset on every yielded chunk; catches a fully silent stall.
 *   - `totalMs` — armed ONCE at entry, NOT reset by chunks; a hard ceiling that
 *     fires even when heartbeat chunks keep the idle guard alive.
 * `timeoutMs <= 0` disables that guard. On fire it throws {@link TurnStallError};
 * the caller decides how to surface it (abort the controller, yield a toast, …).
 *
 * Modelled on sprint-runner's proven `withImplIdleWatchdog`, generalised so any
 * turn generator can be guarded without coupling to the product loop.
 */
import type { StreamChunk } from "../types/index.js";

export class TurnStallError extends Error {
  constructor(
    readonly kind: "idle" | "total",
    message: string,
  ) {
    super(message);
    this.name = "TurnStallError";
  }
}

export interface TurnWatchdogOptions {
  /** Reset on every yielded chunk. <= 0 disables. */
  idleMs: number;
  /** Armed once at entry, never reset. <= 0 disables. */
  totalMs: number;
  /** Human label used in the thrown error (e.g. "council continuation turn"). */
  label: string;
}

export async function* withTurnWatchdog(
  gen: AsyncGenerator<StreamChunk, void, unknown>,
  opts: TurnWatchdogOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  const { idleMs, totalMs, label } = opts;
  const it = gen[Symbol.asyncIterator]();

  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const total =
    totalMs > 0
      ? new Promise<never>((_, reject) => {
          totalTimer = setTimeout(() => {
            reject(
              new TurnStallError(
                "total",
                `${label} exceeded ${Math.round(totalMs / 1000)}s total watchdog — treated as hung`,
              ),
            );
          }, totalMs);
          (totalTimer as { unref?: () => void }).unref?.();
        })
      : null;

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle =
        idleMs > 0
          ? new Promise<never>((_, reject) => {
              idleTimer = setTimeout(() => {
                reject(
                  new TurnStallError(
                    "idle",
                    `${label} produced no output for ${Math.round(idleMs / 1000)}s — treated as hung`,
                  ),
                );
              }, idleMs);
              (idleTimer as { unref?: () => void }).unref?.();
            })
          : null;
      const racers: Array<Promise<IteratorResult<StreamChunk, void>>> = [it.next()];
      if (idle) racers.push(idle);
      if (total) racers.push(total);
      let res: IteratorResult<StreamChunk, void>;
      try {
        res = await Promise.race(racers);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
  }
}
