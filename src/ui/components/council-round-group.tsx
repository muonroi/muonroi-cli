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
export function CouncilRoundGroup({ record, children, selected = false, theme }: CouncilRoundGroupProps) {
  const running = record.state === "running";
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
            {hasCriteria && (
              <text fg={outcomeColor} attributes={1}>
                {`${outcomeMark} Outcome: ${met}/${total} criteria met`}
              </text>
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
}

/** One-line overview above the round groups: totals + emergent count. */
export function CouncilRoundsOverview({ rounds, theme }: CouncilRoundsOverviewProps) {
  const total = rounds.length;
  const emergent = rounds.filter((r) => r.emergent).length;
  const members = new Set<string>();
  for (const r of rounds) for (const p of r.participants) members.add(p);
  return (
    <Semantic id="council-rounds-overview" role="region" props={{ total, emergent, members: members.size }}>
      <text fg={theme.textMuted} attributes={1}>
        {`Debate: ${total} round${total === 1 ? "" : "s"}${emergent ? ` (${emergent} emergent)` : ""} · ${members.size} members`}
      </text>
    </Semantic>
  );
}
