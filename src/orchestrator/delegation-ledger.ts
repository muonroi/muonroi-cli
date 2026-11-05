/**
 * src/orchestrator/delegation-ledger.ts
 *
 * Host-carried live delegation ledger, re-emitted verbatim after every
 * summarizing compaction of the main session.
 *
 * Root cause (session 4edc02516a92): worker `steady-ivory-panda` ("Wave 2: Docs
 * engine TCIS.MCP.Docs + unit tests") was dispatched at 02:07:34Z and ran until
 * 02:28Z. Compaction id=343 (02:09:26Z, first_kept_seq 796) and id=344
 * (02:12:54Z) summaries never mentioned it — whether live delegation state
 * survived compaction depended on the summarizing MODEL choosing to copy it.
 * At 02:16:54Z the orchestrator, believing nothing was in flight, dispatched
 * `steady-indigo-heron` for the same work and the two workers collided on the
 * same files.
 *
 * The fix takes the summarizer out of the loop: the registry
 * (`DelegationManager.ledgerSnapshot`) is the source of truth, and this module
 * renders it deterministically into a system message that `compactForContext`
 * places directly after the compaction summary — in the compacted MESSAGE
 * region, never the system prompt, so the stable cached prefix is untouched and
 * the block only changes when a compaction rewrites history anyway.
 */
import type { ModelMessage } from "ai";
import type { DelegationLedgerEntry } from "./delegations.js";

export const DELEGATION_LEDGER_HEADER = "[Live delegation ledger — host-carried across compaction]";

/** Entry cap: the ledger must stay a bounded, cheap block on every request. */
export const DELEGATION_LEDGER_MAX_ENTRIES = 12;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_SCOPE_PATHS = 6;

export interface FormatDelegationLedgerOptions {
  /** Snapshot time printed in the header (defaults to now). */
  now?: Date;
  maxEntries?: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function formatScope(scope: string[] | undefined): string {
  if (scope === undefined) return "unscoped";
  const shown = scope.slice(0, MAX_SCOPE_PATHS);
  const rest = scope.length - shown.length;
  return `${JSON.stringify(shown)}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

function runningLine(e: DelegationLedgerEntry): string {
  const question = e.pendingQuestionId ? ` pendingQuestion messageId=${e.pendingQuestionId}` : "";
  return `- jobId=${e.id} agent=${e.agent} startedAt=${e.startedAt} writeScope=${formatScope(e.writeScope)}${question} — ${clip(e.description, MAX_DESCRIPTION_CHARS)}`;
}

function unackedLine(e: DelegationLedgerEntry): string {
  return `- jobId=${e.id} agent=${e.agent} status=${e.status} resultVersion=${e.resultVersion} — ${clip(e.description, MAX_DESCRIPTION_CHARS)}`;
}

/**
 * Render the ledger, or `null` when there is nothing live to carry (no running
 * job and no un-ACKed result) — an empty registry must add zero bytes.
 */
export function formatDelegationLedger(
  entries: readonly DelegationLedgerEntry[],
  opts: FormatDelegationLedgerOptions = {},
): string | null {
  const max = Math.max(1, opts.maxEntries ?? DELEGATION_LEDGER_MAX_ENTRIES);
  // Oldest first: the longest-running job is the one a summary most likely dropped.
  const byStart = [...entries].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const running = byStart.filter((e) => e.status === "running");
  const unacked = byStart.filter((e) => e.status !== "running" && !!e.resultVersion && !e.acknowledged);
  if (running.length === 0 && unacked.length === 0) return null;

  // Running jobs (and their open questions) take priority over un-ACKed results:
  // forgetting a live worker is what causes a duplicate dispatch.
  const shownRunning = running.slice(0, max);
  const shownUnacked = unacked.slice(0, max - shownRunning.length);
  const omitted = running.length - shownRunning.length + (unacked.length - shownUnacked.length);

  const lines = [
    DELEGATION_LEDGER_HEADER,
    `Snapshot from the delegation registry at ${(opts.now ?? new Date()).toISOString()}. Authoritative over the summary above; it may have changed since — call delegation_list for current state.`,
    `Running (${running.length}) — do NOT dispatch another worker for the same work or overlapping writeScope:`,
    ...(shownRunning.length > 0 ? shownRunning.map(runningLine) : ["- none"]),
  ];
  if (shownUnacked.length > 0) {
    lines.push(`Finished, not yet acknowledged (${unacked.length}) — read with delegation_read, then delegation_ack:`);
    lines.push(...shownUnacked.map(unackedLine));
  }
  if (omitted > 0) lines.push(`… ${omitted} more — call delegation_list.`);
  return lines.join("\n");
}

export function createDelegationLedgerMessage(text: string): ModelMessage {
  return { role: "system", content: text };
}

export function isDelegationLedgerMessage(message: ModelMessage | undefined): boolean {
  return (
    message?.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith(DELEGATION_LEDGER_HEADER)
  );
}
