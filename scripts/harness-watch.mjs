#!/usr/bin/env bun
/**
 * harness-watch.mjs — generic harness event-milestone watcher.
 *
 * Replaces bespoke per-task monitor scripts. Tails the JSONL sink written by
 * the MCP harness (MUONROI_HARNESS_EVENT_LOG) and exits when ANY of the
 * requested event kinds appears — waking a background-task agent at the exact
 * milestone instead of it blocking on a long synchronous wait.
 *
 * Unlike a DB-poll watcher, this catches modal pauses (askcard-open) and any
 * mid-flight event, because it reads the harness event stream directly. For
 * ephemeral kinds the harness attaches a `visualText` snapshot, so the wake
 * payload carries the exact frame that flashed.
 *
 * Usage:
 *   bun scripts/harness-watch.mjs <eventLogPath> --kinds <k1,k2,...> \
 *       [--from-line N] [--max-polls N] [--poll-ms N]
 *
 * Exit: prints "MILESTONE <kind> ..." on match (with visual if present), or
 * "HEARTBEAT ..." after the poll budget. Always exit code 0 so the harness
 * treats completion as a normal wake, not a failure.
 */
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const [logPath, ...rest] = argv;
  const opts = { logPath, kinds: [], fromLine: 0, maxPolls: 30, pollMs: 8000 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--kinds")
      opts.kinds = (rest[++i] ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    else if (a === "--from-line") opts.fromLine = Number(rest[++i] ?? 0);
    else if (a === "--max-polls") opts.maxPolls = Number(rest[++i] ?? 30);
    else if (a === "--poll-ms") opts.pollMs = Number(rest[++i] ?? 8000);
  }
  return opts;
}

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch (err) {
    // Missing file just means no events yet — not fatal.
    if (err?.code !== "ENOENT") {
      console.error(`[harness-watch] read failed (${path}): ${err?.message}`);
    }
    return null;
  }
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.logPath || opts.kinds.length === 0) {
  console.error(
    "usage: bun harness-watch.mjs <eventLogPath> --kinds k1,k2 [--from-line N] [--max-polls N] [--poll-ms N]",
  );
  process.exit(2);
}
const wanted = new Set(opts.kinds);

for (let poll = 0; poll < opts.maxPolls; poll++) {
  const lines = readLines(opts.logPath);
  if (lines) {
    for (let i = opts.fromLine; i < lines.length; i++) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue; // skip a partially-written trailing line
      }
      if (wanted.has(rec.kind)) {
        console.log(`MILESTONE ${rec.kind} line=${i} ts=${rec.ts} (poll ${poll})`);
        if (rec.visualText) console.log(`--- visual snapshot ---\n${rec.visualText}`);
        else console.log(JSON.stringify(rec.event));
        process.exit(0);
      }
    }
  }
  await Bun.sleep(opts.pollMs);
}

const lines = readLines(opts.logPath);
const total = lines ? lines.length : 0;
console.log(
  `HEARTBEAT no [${opts.kinds.join(",")}] after ${((opts.maxPolls * opts.pollMs) / 1000).toFixed(0)}s — ${total} event lines total`,
);
process.exit(0);
