import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ReactNode } from "react";
import type { CouncilRoundRecord } from "../../types/index.js";
import type { Theme } from "../theme.js";

const DECISION_LABEL: Record<NonNullable<CouncilRoundRecord["leaderDecision"]>, string> = {
  continue: "continue",
  stop: "sufficient — stop",
  extend: "extend (emergent round)",
  aborted: "aborted",
  "circuit-break": "circuit breaker",
  "eval-unavailable": "evaluation unavailable",
};

/**
 * S6 — one line of the round receipt. A finished round used to end at
 * `◐ Outcome: 2/4 criteria met`, a number you cannot map back to anything after
 * round 3. The receipt says WHICH criteria the round settled, who held the
 * minority view on the ones it did not, and what the round actually contributed.
 */
export interface RoundReceipt {
  /** Criteria that flipped to met IN THIS round. */
  locked: Array<{ criterion: string; agree: number; of: number; silent: string[] }>;
  /** Criteria still unmet, split into argued-and-contested vs never-reached. */
  open: Array<{
    criterion: string;
    supports: number;
    opposes: number;
    argued: boolean;
    split?: string;
    minority: string[];
  }>;
  /** Consensus delta: met going in → met coming out. */
  before: number;
  after: number;
  total: number;
}

/**
 * Derive the receipt from a done round's frozen stance snapshot.
 *
 * Returns null when the round carries no stance data (an older record, or an
 * eval that failed) — the caller then falls back to the plain outcome line
 * rather than rendering an empty, authoritative-looking receipt.
 */
export function buildRoundReceipt(record: CouncilRoundRecord, roster: readonly string[]): RoundReceipt | null {
  const rows = record.stanceRows;
  if (!rows || rows.length === 0) return null;
  const prev = record.prevCriteriaMet ?? [];
  const locked: RoundReceipt["locked"] = [];
  const open: RoundReceipt["open"] = [];

  rows.forEach((row, i) => {
    let supports = 0;
    let opposes = 0;
    const silent: string[] = [];
    const minority: string[] = [];
    for (const role of roster) {
      const mark = row.stances[role] ?? null;
      if (mark === "+" || mark === "~") supports++;
      else if (mark === "-") {
        opposes++;
        minority.push(role);
      } else silent.push(role);
    }
    if (row.met) {
      // Only rounds that FLIPPED it count as locked here — a criterion carried
      // in from an earlier round is not this round's contribution.
      if (!prev[i]) locked.push({ criterion: row.criterion, agree: supports, of: roster.length, silent });
      return;
    }
    open.push({
      criterion: row.criterion,
      supports,
      opposes,
      // "Contested" and "never reached" are different failures that today look
      // identical; keeping them apart is the point of this block.
      argued: supports > 0 || opposes > 0,
      split: row.split,
      minority,
    });
  });

  const before = prev.filter(Boolean).length;
  const after = rows.filter((r) => r.met).length;
  return { locked, open, before, after, total: rows.length };
}

/** `▓▓░░` progress bar for the consensus delta, sized to `width` cells. */
export function consensusBar(met: number, total: number, width = 4): string {
  if (total <= 0) return "";
  const filled = Math.max(0, Math.min(width, Math.round((met / total) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * S3 — the pending row that closes the leader's lane while a round is still in
 * flight: what it is waiting on, and the three decisions it can take.
 *
 * Returns null when the round's turn denominator is unknown, so an older round
 * record renders nothing instead of "waiting on NaN of 0 turns". The two states
 * are worth distinguishing: turns still outstanding means the panel is talking,
 * while every turn landed means the leader itself is the thing you are waiting
 * on — the same silence, two very different reasons.
 */
export interface LeaderPendingRow {
  headline: string;
  sub: string;
}

export function leaderPendingRow(opts: {
  turnsDone: number;
  turnsExpected?: number | null;
  criteriaTotal?: number | null;
}): LeaderPendingRow | null {
  const expected = opts.turnsExpected ?? 0;
  if (!(expected > 0)) return null;
  const done = Math.max(0, opts.turnsDone);
  const remaining = Math.max(0, expected - done);
  const criteria = opts.criteriaTotal ?? 0;
  const grade = criteria > 0 ? `Will grade ${criteria} criteria` : "Will grade the round";
  return {
    headline:
      remaining > 0 ? `Leader · waiting on ${remaining} of ${expected} turns` : "Leader · grading the round now",
    sub: `${grade}, then decide: continue · extend · stop`,
  };
}

export interface CouncilRoundGroupProps {
  record: CouncilRoundRecord;
  /**
   * Turn nodes for this round. Rendered while the round is running (live stream)
   * OR when the round is selected in the rail (inspect a finished round's debate).
   */
  children?: ReactNode;
  /** True when this round is the one selected in the rail — highlight + expand. */
  selected?: boolean;
  theme: Theme;
  /**
   * Panel roles in palette-slot order, for the receipt's agree counts and
   * minority attribution. Omit to fall back to the plain outcome line.
   */
  roster?: readonly string[];
  /** Stable role → sigil resolver, so a named minority matches the transcript. */
  resolveSigil?: (role: string) => string;
  /**
   * Debate turns that have LANDED in this round, for the leader's pending row.
   * Only meaningful while the round is running.
   */
  turnsDone?: number;
  /** Pinned criteria count, so the pending row can say what the leader will grade. */
  criteriaTotal?: number;
}

/**
 * F2 — header that frames a DONE round's persisted directive as its *opening*
 * brief. Without it the directive's "Unmet (n/m)" line reads as current state and
 * contradicts the "✓ Outcome: m/m met" line below on a converged round. When the
 * round met everything, say so ("resolved below") so brief + outcome cohere.
 */
export function openingBriefHeader(allMet: boolean): string {
  return `Opening brief${allMet ? " — resolved below" : ""}:`;
}

/** Color the leader's decision by whether the round landed well. */
function decisionColor(decision: NonNullable<CouncilRoundRecord["leaderDecision"]>, theme: Theme): string {
  switch (decision) {
    case "stop":
      return theme.diffAddedFg; // sufficient — a clean landing
    case "aborted":
    case "circuit-break":
    case "eval-unavailable":
      return theme.diffRemovedFg; // ended abnormally
    default:
      return theme.accent; // continue / extend — still in progress
  }
}

/**
 * One debate round in the round-grouped transcript (P6). The running round auto-
 * opens and streams its turns live; a done round collapses to an expanded-inline
 * summary — input (topic + members), outcome (criteria met/total), and the
 * leader's decision — so a finished round always shows what it achieved instead
 * of a bare "done". When `selected` (P2/D — the round chosen in the rail), a
 * finished round also expands its debate turns and highlights.
 */
export function CouncilRoundGroup({
  record,
  children,
  selected = false,
  theme,
  roster,
  resolveSigil,
  turnsDone = 0,
  criteriaTotal,
}: CouncilRoundGroupProps) {
  const running = record.state === "running";
  const pending = running ? leaderPendingRow({ turnsDone, turnsExpected: record.turnsExpected, criteriaTotal }) : null;
  const receipt = !running && roster && roster.length > 0 ? buildRoundReceipt(record, roster) : null;
  const sigil = (role: string) => (resolveSigil ? `${resolveSigil(role)} ` : "");
  const headParts = [`Round ${record.round}`];
  if (record.topic) headParts.push(record.topic);
  if (record.emergent) headParts.push("(emergent)");

  // Outcome verdict: how many acceptance criteria the round met. Colored + marked
  // so a scan of the transcript shows at a glance which rounds landed cleanly.
  const total = record.criteriaTotal ?? -1;
  const met = record.criteriaMet ?? 0;
  const hasCriteria = total > 0;
  const allMet = hasCriteria && met >= total;
  const noneMet = hasCriteria && met === 0;
  const outcomeColor = allMet ? theme.diffAddedFg : noneMet ? theme.diffRemovedFg : theme.mdItalic;
  const outcomeMark = allMet ? "✓" : noneMet ? "✗" : "◐";

  return (
    <Semantic
      id={`council-round-${record.round}`}
      role="region"
      name={`Round ${record.round}`}
      props={{
        state: record.state,
        emergent: record.emergent,
        selected,
        criteriaMet: record.criteriaMet ?? -1,
        criteriaTotal: record.criteriaTotal ?? -1,
        decision: record.leaderDecision ?? "",
        directive: record.directive ?? "",
      }}
    >
      <box
        flexDirection="column"
        marginBottom={1}
        border={["left"]}
        borderColor={running || selected ? theme.accent : theme.councilLeaderBorder}
        paddingLeft={2}
      >
        <text fg={running || selected ? theme.accent : theme.textMuted} attributes={1}>
          {`${running ? "> " : selected ? "› " : "✓ "}${headParts.join(" · ")}`}
        </text>
        {/* Members / input line. */}
        {record.participants.length > 0 && (
          <text fg={theme.textMuted}>{`${record.participants.length} members: ${record.participants.join(", ")}`}</text>
        )}
        {running ? (
          // Running round streams its turns live.
          <box flexDirection="column" marginTop={1}>
            {children}
            {/* The leader's lane closes the round: muted border to match the
                mid-round notes, so the conductor reads as one continuous voice
                rather than three unrelated blocks. */}
            {pending ? (
              <box
                flexDirection="column"
                marginTop={1}
                border={["left"]}
                borderColor={theme.councilLeaderBorder}
                paddingLeft={2}
              >
                <text fg={theme.textMuted} attributes={1}>
                  {pending.headline}
                </text>
                <text fg={theme.textMuted}>{pending.sub}</text>
              </box>
            ) : null}
          </box>
        ) : (
          // Done round: expanded debate turns (when selected in the rail) followed
          // by the outcome verdict + leader decision summary.
          <box flexDirection="column">
            {children ? (
              <box flexDirection="column" marginTop={1} marginBottom={1}>
                {children}
              </box>
            ) : null}
            {/* B5 — the leader's pre-round directive, persisted on the record so
                the conductor's opening steer survives into this collapsed summary
                (not just the ephemeral live bubble). Accent + ▶ so the leader
                visibly opens the round. F2 — on a DONE round the directive is the
                round's *opening* brief; without a temporal label its "Unmet (n/m)"
                line reads as current state and contradicts the "✓ Outcome: m/m met"
                line below on a converged round. The muted header frames it as the
                pre-round steer, so brief + outcome tell a coherent story. */}
            {/* S6 — with a receipt the pre-round steer is HISTORY: it collapses
                to one dim line so the round's actual result owns the space (it
                is also what made the brief contradict the outcome). Without a
                receipt the full directive stays, as before. */}
            {record.directive && receipt ? (
              <text fg={theme.textDim}>
                {`▸ ${openingBriefHeader(allMet)} ${record.directive.split("\n")[0]?.slice(0, 80) ?? ""}`}
              </text>
            ) : (
              <>
                {record.directive && <text fg={theme.textMuted}>{openingBriefHeader(allMet)}</text>}
                {record.directive &&
                  record.directive.split("\n").map((line, i) => (
                    <text key={`dir-${i}`} fg={theme.accent} attributes={i === 0 ? 1 : 0}>
                      {i === 0 ? `▶ ${line}` : `  ${line}`}
                    </text>
                  ))}
              </>
            )}

            {receipt ? (
              <box flexDirection="column">
                {receipt.locked.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg={theme.diffAddedFg} attributes={1}>
                      Locked this round
                    </text>
                    {receipt.locked.map((l, i) => (
                      <text key={`lock-${i}`}>
                        <span style={{ fg: theme.diffAddedFg }}>{"✓ "}</span>
                        <span style={{ fg: theme.text }}>{l.criterion}</span>
                        <span style={{ fg: theme.diffAddedFg }}>{`  ${l.agree}/${l.of} agree`}</span>
                        {/* Abstentions are NAMED so 4/5 is not read as one
                            panelist opposing. */}
                        {l.silent.length > 0 ? (
                          <span style={{ fg: theme.textMuted }}>
                            {`  · ${l.silent.map((r) => `${sigil(r)}${r}`).join(", ")} silent`}
                          </span>
                        ) : null}
                      </text>
                    ))}
                  </box>
                )}
                {receipt.open.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg={theme.mdItalic} attributes={1}>
                      Still open
                    </text>
                    {receipt.open.map((o, i) => (
                      <box key={`open-${i}`} flexDirection="column">
                        <text>
                          <span style={{ fg: o.argued ? theme.mdItalic : theme.textMuted }}>
                            {o.argued ? "◐ " : "○ "}
                          </span>
                          <span style={{ fg: theme.text }}>{o.criterion}</span>
                          <span style={{ fg: o.argued ? theme.diffRemovedFg : theme.textMuted }}>
                            {o.argued ? `  ${o.supports} vs ${o.opposes}` : "  not argued"}
                          </span>
                        </text>
                        {o.minority.length > 0 || o.split ? (
                          <text fg={theme.textMuted}>
                            {`    ${o.minority.map((r) => `${sigil(r)}${r}`).join(", ")}${
                              o.split ? `: ${o.split}` : ""
                            }`}
                          </text>
                        ) : null}
                      </box>
                    ))}
                  </box>
                )}
                {/* Consensus delta — the round's actual contribution. A round
                    that moves nothing is instantly visible here, and that is the
                    signal to stop paying for more rounds. */}
                <box marginTop={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{"Consensus  "}</span>
                    <span
                      style={{ fg: theme.text }}
                    >{`${receipt.before}/${receipt.total} → ${receipt.after}/${receipt.total}  `}</span>
                    <span style={{ fg: theme.diffAddedFg }}>{`${consensusBar(receipt.after, receipt.total)}  `}</span>
                    <span
                      style={{
                        fg: receipt.after > receipt.before ? theme.diffAddedFg : theme.textMuted,
                      }}
                    >
                      {receipt.after > receipt.before
                        ? `+${receipt.after - receipt.before} this round`
                        : "no movement this round"}
                    </span>
                  </text>
                </box>
              </box>
            ) : (
              hasCriteria && (
                <text fg={outcomeColor} attributes={1}>
                  {`${outcomeMark} Outcome: ${met}/${total} criteria met`}
                </text>
              )
            )}
            {record.leaderDecision && (
              <text fg={decisionColor(record.leaderDecision, theme)} attributes={1}>
                {`Decision: ${DECISION_LABEL[record.leaderDecision]}`}
              </text>
            )}
            {record.leaderReason && <text fg={theme.textMuted}>{record.leaderReason}</text>}
            {record.nextRoundFocus && <text fg={theme.textMuted}>{`Next focus: ${record.nextRoundFocus}`}</text>}
          </box>
        )}
      </box>
    </Semantic>
  );
}

export interface CouncilRoundsOverviewProps {
  rounds: CouncilRoundRecord[];
  theme: Theme;
  /** Optional session id appended to the overview so it stays visible above the debate transcript. */
  sessionId?: string;
}

/**
 * S6 — the run ledger. Maps every round to what it SETTLED and how it ended:
 * the after-N-rounds view, and the same rows the conclusion's Dissent section
 * draws from. Rendered below the round groups.
 *
 * Reads only fields already on `CouncilRoundRecord`, so it degrades gracefully:
 * a round with no stance snapshot still shows its criteria count and decision.
 */
export function CouncilRunLedger({
  rounds,
  roster,
  theme,
  resolveSigil,
}: {
  rounds: CouncilRoundRecord[];
  roster?: readonly string[];
  theme: Theme;
  resolveSigil?: (role: string) => string;
}) {
  const done = rounds.filter((r) => r.state === "done");
  if (done.length === 0) return null;
  const sigil = (role: string) => (resolveSigil ? `${resolveSigil(role)} ` : "");

  return (
    <Semantic id="council-run-ledger" role="listbox" name="Run ledger" props={{ rounds: done.length }}>
      <box flexDirection="column" marginTop={1}>
        <text fg={theme.textMuted} attributes={1}>
          Run ledger
        </text>
        {done.map((rec) => {
          const receipt = roster && roster.length > 0 ? buildRoundReceipt(rec, roster) : null;
          const settled = receipt?.locked.map((l) => l.criterion).join(" · ") ?? "";
          const dissenting = receipt?.open.filter((o) => o.opposes > 0) ?? [];
          return (
            <box key={`ledger-r${rec.round}`} flexDirection="column">
              <text>
                <span style={{ fg: theme.textMuted }}>{`  R${rec.round}  `}</span>
                <span style={{ fg: settled ? theme.diffAddedFg : theme.textMuted }}>
                  {settled ? `✓ ${settled}` : "— nothing settled"}
                </span>
                <span style={{ fg: theme.text }}>
                  {typeof rec.criteriaTotal === "number" ? `  ${rec.criteriaMet ?? 0}/${rec.criteriaTotal}` : ""}
                </span>
                <span
                  style={{
                    fg: rec.leaderDecision ? decisionColor(rec.leaderDecision, theme) : theme.textMuted,
                  }}
                >
                  {rec.leaderDecision ? `  ${DECISION_LABEL[rec.leaderDecision]}` : ""}
                </span>
              </text>
              {/* Dissent carried out of the round — the position a converged
                  verdict would otherwise erase. */}
              {dissenting.map((o, i) => (
                <text key={`ledger-d-${rec.round}-${i}`} fg={theme.diffRemovedFg}>
                  {`      ◐ ${o.criterion} — dissent ${o.minority.map((r) => `${sigil(r)}${r}`).join(", ")}`}
                </text>
              ))}
            </box>
          );
        })}
      </box>
    </Semantic>
  );
}

/** One-line overview above the round groups: totals + emergent count + session id. */
export function CouncilRoundsOverview({ rounds, theme, sessionId }: CouncilRoundsOverviewProps) {
  const total = rounds.length;
  const emergent = rounds.filter((r) => r.emergent).length;
  const members = new Set<string>();
  for (const r of rounds) for (const p of r.participants) members.add(p);
  const parts = [`Debate: ${total} round${total === 1 ? "" : "s"}`, `${members.size} members`];
  if (emergent > 0) parts.push(`${emergent} emergent`);
  if (sessionId) parts.push(`session ${sessionId}`);
  return (
    <Semantic id="council-rounds-overview" role="region" props={{ total, emergent, members: members.size, sessionId }}>
      <text fg={theme.textMuted} attributes={1}>
        {parts.join(" · ")}
      </text>
    </Semantic>
  );
}
