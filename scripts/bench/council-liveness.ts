/**
 * Council liveness for the bench runner's "settled" rule (scripts/bench/replay-tcis.ts).
 *
 * The in-process council (verify / debate) shows no UI change and no detached worker for
 * minutes while a model call is in flight, yet the CLI is alive and working. Its only external
 * trace is the heartbeat in `<muonroi home>/council-breadcrumbs.jsonl`
 * (src/council/crash-breadcrumb.ts): one `council.heartbeat` record per
 * DEFAULT_HEARTBEAT_MS (5 s) while `inFlightCount > 0`, stamped with the writer's pid and
 * session id. No heartbeat is written once the last call settles, so "recent heartbeat with
 * inFlightCount > 0" is exactly "a council call is in flight right now".
 *
 * Evidence: run ideal6-M-tcis-mcpdocs (session 26516fe0c62e, CLI pid 48736) — heartbeats with
 * `inFlight:[{marker:"council.research",elapsedMs:300320}]` ran 10:19:02-10:24:02 while the
 * runner's 300 s quiet rule killed the CLI mid-verify.
 *
 * Standalone on purpose (no src/ imports): the runner script executes main() on import, so the
 * pure decision lives here where a unit test can load it.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const BREADCRUMB_BASENAME = "council-breadcrumbs.jsonl";
/** Mirrors DEFAULT_HEARTBEAT_MS in src/council/crash-breadcrumb.ts. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** A heartbeat older than this many intervals no longer proves liveness (covers one missed beat + poll jitter). */
export const STALE_AFTER_INTERVALS = 4;
/** Tail window read per poll; a heartbeat line is ~0.5-2 KB, so this holds many beats. */
const TAIL_BYTES = 256 * 1024;

export interface CouncilRunIdentity {
  /** pid of the CLI process the runner spawned. */
  pid?: number;
  /** Every session id belonging to the run. */
  sessionIds: ReadonlySet<string>;
}

export interface CouncilLiveness {
  alive: boolean;
  /** Marker names of the calls in flight (for the log line). */
  markers: string[];
  /** Age of the deciding heartbeat. */
  ageMs?: number;
}

interface HeartbeatRecord {
  ts?: string;
  marker?: string;
  pid?: number;
  sessionId?: string;
  inFlightCount?: number;
  inFlight?: Array<{ marker?: string }>;
}

/**
 * Pure decision. `lines` are raw JSONL lines (unparseable lines are reported through
 * `onParseError` and skipped). Alive = the NEWEST `council.heartbeat` belonging to this run
 * (pid match OR session-id match) is at most `staleAfterMs` old and reports `inFlightCount > 0`.
 * Heartbeats of other processes/sessions are ignored.
 */
export function councilLiveness(
  lines: readonly string[],
  run: CouncilRunIdentity,
  nowMs: number,
  opts: { staleAfterMs?: number; onParseError?: (err: unknown, line: string) => void } = {},
): CouncilLiveness {
  const staleAfterMs = opts.staleAfterMs ?? HEARTBEAT_INTERVAL_MS * STALE_AFTER_INTERVALS;
  let newest: { rec: HeartbeatRecord; at: number } | undefined;
  for (const line of lines) {
    if (!line.includes("council.heartbeat")) continue;
    let rec: HeartbeatRecord;
    try {
      rec = JSON.parse(line) as HeartbeatRecord;
    } catch (err) {
      opts.onParseError?.(err, line);
      continue;
    }
    if (rec.marker !== "council.heartbeat") continue;
    const mine =
      (run.pid !== undefined && rec.pid === run.pid) ||
      (rec.sessionId !== undefined && run.sessionIds.has(rec.sessionId));
    if (!mine) continue;
    const at = Date.parse(rec.ts ?? "");
    if (!Number.isFinite(at)) continue;
    if (!newest || at >= newest.at) newest = { rec, at };
  }
  if (!newest) return { alive: false, markers: [] };
  const ageMs = nowMs - newest.at;
  const inFlight = newest.rec.inFlightCount ?? 0;
  if (ageMs > staleAfterMs || !(inFlight > 0)) return { alive: false, markers: [], ageMs };
  return { alive: true, markers: (newest.rec.inFlight ?? []).map((c) => c.marker ?? "?"), ageMs };
}

/** Last `TAIL_BYTES` of the file as complete lines (the first, possibly torn, line is dropped when cut mid-file). */
function readTailLines(file: string): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the run's breadcrumb file and decide. A missing file is normal (no council ran yet):
 * `debug` is told, never an error. Any other failure is reported through `warn` and counts as
 * "not alive" so the existing settle rule applies unchanged.
 */
export function readCouncilLiveness(
  home: string,
  run: CouncilRunIdentity,
  hooks: { debug: (msg: string) => void; warn: (msg: string) => void },
  nowMs: number = Date.now(),
): CouncilLiveness {
  const file = process.env.MUONROI_COUNCIL_BREADCRUMB_FILE?.trim() || join(home, BREADCRUMB_BASENAME);
  if (!existsSync(file)) {
    hooks.debug(`[council-liveness] no breadcrumb file at ${file} (no council activity yet)`);
    return { alive: false, markers: [] };
  }
  try {
    return councilLiveness(readTailLines(file), run, nowMs, {
      onParseError: (err) =>
        hooks.warn(
          `[council-liveness] parse heartbeat line in ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
  } catch (err) {
    hooks.warn(
      `[council-liveness] read ${file} failed: ${err instanceof Error ? err.message : String(err)}; using the normal settle rule`,
    );
    return { alive: false, markers: [] };
  }
}
