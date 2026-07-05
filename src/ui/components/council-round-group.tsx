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
  /** Live turn nodes for this round — rendered only while the round is running. */
  children?: ReactNode;
  theme: Theme;
}

/**
 * One debate round in the round-grouped transcript (P6). The running round auto-
 * opens and streams its turns live; a done round collapses to an expanded-inline
 * summary — input (topic + members), outcome (criteria met/total), and the
 * leader's decision — so a finished round always shows what it achieved instead
 * of a bare "done". No click-to-open accordion (the feed has no selection
 * cursor); the summary is always visible.
 */
export function CouncilRoundGroup({ record, children, theme }: CouncilRoundGroupProps) {
  const running = record.state === "running";
  const headParts = [`Round ${record.round}`];
  if (record.topic) headParts.push(record.topic);
  if (record.emergent) headParts.push("(emergent)");

  return (
    <Semantic
      id={`council-round-${record.round}`}
      role="region"
      name={`Round ${record.round}`}
      props={{
        state: record.state,
        emergent: record.emergent,
        criteriaMet: record.criteriaMet ?? -1,
        criteriaTotal: record.criteriaTotal ?? -1,
        decision: record.leaderDecision ?? "",
      }}
    >
      <box
        flexDirection="column"
        marginBottom={1}
        border={["left"]}
        borderColor={running ? theme.accent : theme.councilLeaderBorder}
        paddingLeft={2}
      >
        <text fg={running ? theme.accent : theme.textMuted} attributes={1}>
          {`${running ? "> " : "✓ "}${headParts.join(" · ")}`}
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
          // Done round: outcome + leader decision summary.
          <box flexDirection="column">
            {typeof record.criteriaTotal === "number" && record.criteriaTotal >= 0 && (
              <text fg={theme.textMuted}>
                {`Outcome: ${record.criteriaMet ?? 0}/${record.criteriaTotal} criteria met`}
              </text>
            )}
            {record.leaderDecision && (
              <text fg={theme.textMuted}>{`Leader: ${DECISION_LABEL[record.leaderDecision]}`}</text>
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
