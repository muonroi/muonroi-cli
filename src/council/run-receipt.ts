import type { CouncilPanelLedgerEntry, CouncilStanceRow } from "../types/index.js";

/**
 * `council/run-receipt` — design S8. The one-line summary of what a debate
 * actually cost and achieved, plus the dissent the wrap-up card can offer to
 * re-run.
 *
 * Every segment is measured, never estimated, and a segment with no measurement
 * behind it is OMITTED rather than zero-filled. "$0.00" reads as "this was free"
 * when it usually means "no model in this run had catalog pricing", and
 * "0/0 criteria met" reads as total failure when it means no criteria were
 * pinned — both are worse than a shorter line.
 */

export interface RunReceiptInput {
  rounds: number;
  turns: number;
  criteriaMet?: number;
  criteriaTotal?: number;
  ledger?: readonly CouncilPanelLedgerEntry[];
  elapsedMs?: number;
}

/** `4m12s` / `48s` — the same compact form the council surface uses elsewhere. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function totalLedgerUsd(ledger: readonly CouncilPanelLedgerEntry[] = []): number {
  return ledger.reduce((sum, e) => sum + (Number.isFinite(e.usd) ? e.usd : 0), 0);
}

/** `2 rounds · 14 turns · 3/4 criteria met · $0.19 · 4m12s` */
export function formatRunReceipt(input: RunReceiptInput): string {
  const parts: string[] = [];
  if (input.rounds > 0) parts.push(`${input.rounds} round${input.rounds === 1 ? "" : "s"}`);
  if (input.turns > 0) parts.push(`${input.turns} turn${input.turns === 1 ? "" : "s"}`);
  if ((input.criteriaTotal ?? 0) > 0) parts.push(`${input.criteriaMet ?? 0}/${input.criteriaTotal} criteria met`);
  const usd = totalLedgerUsd(input.ledger);
  // Sub-cent is reported as "<$0.01" so a cheap run is not rounded to free.
  if (usd > 0) parts.push(usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
  const dur = formatDuration(input.elapsedMs ?? 0);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

export interface CouncilDissent {
  role: string;
  criterion: string;
  split?: string;
}

/**
 * The objection worth re-running as its own topic.
 *
 * Picks the criterion with the MOST opposition — the one where re-framing the
 * debate around the objection has the best chance of changing something. A row
 * with a recorded `split` reason wins ties, because that reason is what makes
 * the generated topic concrete instead of "skeptic disagreed".
 *
 * Returns null when nobody ended the run opposing, so the card never invents a
 * dissent to offer.
 */
export function pickLoudestDissent(
  rows: readonly CouncilStanceRow[] = [],
  roster: readonly string[] = [],
): CouncilDissent | null {
  let best: { row: CouncilStanceRow; opposers: string[] } | null = null;
  for (const row of rows) {
    if (row.met) continue;
    const opposers = roster.filter((r) => row.stances[r] === "-");
    if (opposers.length === 0) continue;
    const better =
      !best ||
      opposers.length > best.opposers.length ||
      (opposers.length === best.opposers.length && !!row.split && !best.row.split);
    if (better) best = { row, opposers };
  }
  if (!best) return null;
  return {
    role: best.opposers[0]!,
    criterion: best.row.criterion,
    ...(best.row.split ? { split: best.row.split } : {}),
  };
}
