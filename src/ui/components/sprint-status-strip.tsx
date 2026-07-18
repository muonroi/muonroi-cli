import { Semantic } from "@muonroi/agent-harness-opentui";
import type { SprintProgressSegment } from "../../state/status-bar-store.js";
import type { Theme } from "../theme.js";
import { formatSprintStripHeadline, formatSprintStripLine, type SprintStageInfo } from "./sprint-stage.js";

export interface SprintStatusStripProps {
  t: Theme;
  /** Active sprint stage (deriveSprintStage) — strip renders only when set. */
  info: SprintStageInfo;
  sprint?: SprintProgressSegment;
  /** Rolling ring of recent sub-agent activity details (most-recent-last). */
  activity: readonly string[];
  /** Ticking clock (app.tsx 1s interval) so elapsed updates continuously. */
  now: number;
  width: number;
}

/**
 * Live status strip pinned under the transcript during an /ideal sprint. The
 * main panel must NEVER go silent while plan/research/implement runs — this
 * strip ticks elapsed time every second and echoes the latest sub-agent
 * activity ("wrote src/…", "running tsc…") even when the isolated implement
 * stage absorbs its own streaming output.
 */
export function SprintStatusStrip({ t, info, sprint, activity, now, width }: SprintStatusStripProps) {
  const headline = formatSprintStripHeadline(info, now);
  const summary = formatSprintStripLine(info, sprint, now);
  const rule = "─".repeat(Math.max(8, Math.min(width - 6, 40)));
  return (
    <Semantic
      id="sprint-status-strip"
      role="region"
      name="Sprint status"
      value={summary}
      props={{
        stage: info.stage,
        headline,
        activityCount: activity.length,
        lastActivity: activity[activity.length - 1] ?? "",
      }}
    >
      <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} marginBottom={1}>
        <text fg={t.text}>{headline}</text>
        {activity.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: bounded rolling ring; index+text is stable enough
          <text key={`${i}-${a.slice(0, 24)}`} fg={t.textMuted}>
            {"  · "}
            {a.length > Math.max(20, width - 10) ? `${a.slice(0, Math.max(19, width - 11))}…` : a}
          </text>
        ))}
        <text fg={t.textDim}>{rule}</text>
        <text fg={t.textMuted}>{summary}</text>
      </box>
    </Semantic>
  );
}
