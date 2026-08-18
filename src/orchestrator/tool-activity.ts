/**
 * src/orchestrator/tool-activity.ts
 *
 * Liveness signal for "a tool call is running right now, and is still inside
 * its own deadline".
 *
 * The top-level turn watchdog (turn-watchdog.ts) resets its idle timer only on
 * YIELDED CHUNKS. A single long tool call yields nothing while it runs, so the
 * watchdog cannot tell "wedged" from "working". Session 708f0fc4ac8b hit the
 * degenerate case exactly: the agent ran `bun test` via bash with
 * `timeout: 120000` while `MUONROI_TURN_IDLE_MS` also defaults to 120_000, so
 * the watchdog fired at the same instant the tool would have returned and killed
 * a perfectly healthy turn ("produced no output for 120s — treated as hung").
 *
 * The watchdog must NOT simply be disabled during tool calls — catching a tool
 * that never returns is the reason it exists (session 578b2eae7099). So this
 * registry suppresses only while the tool is still WITHIN its own declared
 * deadline plus a small grace, letting the tool's own timeout win the race.
 * Once a tool overruns its deadline the suppression lapses and the watchdog
 * guards again.
 *
 * Time is passed in (not read here) so the behaviour is testable without fakes.
 */

/** In-flight tool calls → the wall-clock instant their suppression lapses. */
const inFlight = new Map<number, number>();
let nextId = 1;

/**
 * Ceiling for a tool that declares no deadline of its own, and the grace added
 * to every deadline so a tool's own timeout always settles before the watchdog.
 * Both env-overridable; invalid/absent values fall back to the defaults.
 */
export function toolActivityBudgetMs(): { defaultMs: number; graceMs: number } {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    defaultMs: parse(process.env.MUONROI_TOOL_ACTIVITY_MAX_MS, 300_000),
    graceMs: parse(process.env.MUONROI_TOOL_ACTIVITY_GRACE_MS, 5_000),
  };
}

/**
 * Register a tool call as in flight. `declaredTimeoutMs` is the tool's own
 * timeout when it has one (bash passes `timeout`); null/invalid falls back to
 * the default ceiling. Returns a handle for {@link endToolActivity}.
 */
export function beginToolActivity(declaredTimeoutMs: number | null | undefined, now = Date.now()): number {
  const { defaultMs, graceMs } = toolActivityBudgetMs();
  const declared =
    typeof declaredTimeoutMs === "number" && Number.isFinite(declaredTimeoutMs) && declaredTimeoutMs > 0
      ? declaredTimeoutMs
      : defaultMs;
  const id = nextId++;
  inFlight.set(id, now + declared + graceMs);
  return id;
}

/** Mark a tool call finished. Safe to call with an unknown/duplicate handle. */
export function endToolActivity(id: number): void {
  inFlight.delete(id);
}

/**
 * True when at least one in-flight tool call is still inside its own deadline —
 * i.e. the turn is working, not hung, and the idle watchdog should re-arm.
 */
export function isToolActivityLive(now = Date.now()): boolean {
  for (const lapsesAt of inFlight.values()) {
    if (now <= lapsesAt) return true;
  }
  return false;
}

/** Test-only: drop all in-flight registrations. */
export function __resetToolActivityForTests(): void {
  inFlight.clear();
}
