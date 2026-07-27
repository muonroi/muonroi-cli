/**
 * src/ui/slash/council-cost.ts
 *
 * Design S10 — the `/cost --council [sessionId]` forensics view: where a
 * council run's money went, split by PHASE and by SPEAKER.
 *
 * The renderer is pure (summary in, markdown out) so the numbers are testable
 * without a database; only `handleCouncilCost` touches storage.
 *
 * Attribution comes from the per-call spend log (council/spend-log.ts). The
 * headline total comes from `usage_events`, which is authoritative — any
 * difference between the two is printed as `unattributed` rather than absorbed,
 * so an unwired call path shows up as a number instead of a smaller bill.
 */

import {
  type CouncilSpendSummary,
  readCouncilSpend,
  readCouncilUsageTotalUsd,
  type SpendBucket,
  summarizeCouncilSpend,
} from "../../council/spend-log.js";
import { COUNCIL_SIGILS } from "../components/role-palette.js";

const BAR_CELL = "▌";
const MAX_BAR = 12;

/** Proportional bar for a bucket, sized against the biggest bucket in the set. */
export function spendBar(usd: number, max: number, width = MAX_BAR): string {
  if (!(max > 0) || !(usd > 0)) return "";
  return BAR_CELL.repeat(Math.max(1, Math.round((usd / max) * width)));
}

const money = (usd: number) => `$${usd.toFixed(4)}`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const padStart = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

/**
 * Flag a panelist whose output does not justify its bill.
 *
 * Requires BOTH a low word count and a non-trivial spend, deliberately: a terse
 * CHEAP speaker is efficient, not wasteful, and flagging it would push the user
 * to drop the panelist that costs them nothing. Returns null when nothing
 * qualifies — no advice beats manufactured advice.
 */
export function poorValueSpeaker(
  bySpeaker: readonly SpendBucket[],
  opts: { minUsd?: number; minWordsPerDollar?: number } = {},
): { key: string; words: number; usd: number } | null {
  const minUsd = opts.minUsd ?? 0.005;
  const floor = opts.minWordsPerDollar ?? 6000;
  let worst: { key: string; words: number; usd: number } | null = null;
  for (const s of bySpeaker) {
    if (s.usd < minUsd) continue;
    // ~0.75 words per output token — a proxy, and labelled "~" wherever shown.
    const words = Math.round(s.outputTokens * 0.75);
    if (words / s.usd >= floor) continue;
    if (!worst || words / s.usd < worst.words / worst.usd) worst = { key: s.key, words, usd: s.usd };
  }
  return worst;
}

export function renderCouncilSpendReport(sessionId: string, summary: CouncilSpendSummary): string {
  const total = summary.totalUsd ?? summary.attributedUsd;
  const lines: string[] = [
    `**Council spend · ${money(total)}${summary.totalCalls ? ` · ${summary.totalCalls} calls` : ""}** — session \`${sessionId}\``,
  ];

  if (summary.byPhase.length === 0 && summary.bySpeaker.length === 0) {
    lines.push("");
    lines.push(
      summary.totalUsd === null || summary.totalUsd === 0
        ? "No council usage recorded for this session."
        : // The total is real but nothing was attributed. Say which, instead of
          // printing an empty breakdown that reads as "the run was free".
          `Total council spend was ${money(total)}, but no per-phase attribution was recorded — sessions from before per-call attribution shipped have totals only.`,
    );
    return lines.join("\n");
  }

  if (summary.byPhase.length > 0) {
    const max = Math.max(...summary.byPhase.map((p) => p.usd));
    lines.push("", "**By phase**", "```");
    for (const p of summary.byPhase) {
      lines.push(`${pad(p.key, 14)}${padStart(money(p.usd), 11)}  ${spendBar(p.usd, max)}`);
    }
    lines.push("```");
  }

  if (summary.bySpeaker.length > 0) {
    lines.push("", "**By speaker**", "```");
    summary.bySpeaker.forEach((s, i) => {
      const sigil = COUNCIL_SIGILS[i % COUNCIL_SIGILS.length] ?? "•";
      lines.push(`${pad(`${sigil} ${s.key}`, 18)}${pad(s.model ?? "", 22)}${padStart(money(s.usd), 11)}`);
    });
    lines.push("```");
  }

  const extras: string[] = [];
  if (summary.cacheReadTokens > 0) extras.push(`cache read ${(summary.cacheReadTokens / 1000).toFixed(1)}K`);
  if (summary.unattributedUsd !== null) {
    extras.push(`${money(summary.unattributedUsd)} unattributed (clarify / plan / synthesis calls)`);
  }
  if (extras.length > 0) lines.push("", extras.join(" · "));

  const poor = poorValueSpeaker(summary.bySpeaker);
  if (poor) {
    lines.push(`◐ ${poor.key} produced ~${poor.words} words for ${money(poor.usd)} — consider dropping it next run`);
  }

  return lines.join("\n");
}

/** `/cost --council [sessionId]`. Falls back to the current session id. */
export function handleCouncilCost(sessionId: string | undefined): string {
  if (!sessionId) {
    return "No session id available — run `/cost --council <sessionId>` with an explicit id.";
  }
  const summary = summarizeCouncilSpend(readCouncilSpend(sessionId), readCouncilUsageTotalUsd(sessionId));
  return renderCouncilSpendReport(sessionId, summary);
}
