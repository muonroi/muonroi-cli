// src/product-loop/ideal-trace.ts
//
// Env-gated diagnostic tracer for the /ideal → council → sprint path.
//
// WHY THIS EXISTS
// ---------------
// "blocker 5" — the observed but non-deterministic "Plan locked → idle" stall
// after the sprint-planning debate synthesis — could not be root-caused from a
// harness run because greenfield almost always halts at CB3 first, and the tail
// path (post-debate menu → persist → writeDecisionsLock → stats → return, then
// sprint-runner's Implementation stage) has no durable breadcrumb. When the flow
// goes idle mid-tail, there is nothing to say WHICH line was last reached.
//
// This tracer writes one synchronous JSONL line per choke point when
// `MUONROI_IDEAL_TRACE` is set. Synchronous (`appendFileSync`) is deliberate: if
// the process hangs or is killed at the stall, the LAST line in the file is the
// last point the flow reached — an async write could be lost to an unflushed
// buffer. Unset → zero behaviour change (no file, no stderr, single env read).
//
// USAGE
//   MUONROI_IDEAL_TRACE=1                         → <tmpdir>/muonroi-ideal-trace.jsonl
//   MUONROI_IDEAL_TRACE=/path/to/ideal-trace.log  → explicit path
// Then reproduce the stall and read the file; the trailing marker is the hang.

import { appendFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the trace sink for the CURRENT env value, or null when disabled.
 * Not cached — the flag is fixed for a CLI session, and re-reading env per call
 * is trivial on this (slow, non-hot) council path; caching would wrongly pin an
 * early "disabled" read for the whole process.
 */
function tracePath(): string | null {
  const raw = process.env.MUONROI_IDEAL_TRACE;
  if (!raw || raw === "0" || raw === "false") return null;
  return raw === "1" || raw === "true" ? path.join(os.tmpdir(), "muonroi-ideal-trace.jsonl") : raw;
}

export function isIdealTraceEnabled(): boolean {
  return tracePath() !== null;
}

/**
 * Emit one diagnostic breadcrumb. `marker` is a stable dotted label
 * (e.g. "council.persist.writeDecisionsLock.before"); `extra` carries small
 * scalar context (sessionId, answer, lengths) — keep it tiny, this runs inline.
 */
export function idealTrace(marker: string, extra?: Record<string, unknown>): void {
  const file = tracePath();
  if (!file) return;
  const record = { ts: new Date().toISOString(), marker, ...extra };
  const line = JSON.stringify(record);
  try {
    appendFileSync(file, `${line}\n`, "utf8");
  } catch (err) {
    // Best-effort diagnostics: a bad path must never break the council/sprint
    // flow. Surface once on stderr so a misconfigured path is noticed.
    process.stderr.write(`[ideal-trace] append failed (${file}): ${(err as Error)?.message}\n`);
  }
  // Mirror to stderr so it also lands in MUONROI_DEBUG_LLM_WIRE-style captures.
  process.stderr.write(`[ideal-trace] ${line}\n`);
}
