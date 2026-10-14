/**
 * src/ui/components/agent-rail-activities.tsx
 *
 * Rail block listing every sub-agent / background job this session spawned.
 *
 * Before this, a spawned agent was visible only as a transient line in the
 * transcript: it scrolled away, and once done there was nowhere to see WHAT it
 * was asked or what it returned. The rail keeps the roster on screen, and a row
 * opens to show the prompt and the result.
 *
 * Only RUNNING work is listed: a finished row leaves the rail and is counted in
 * a one-line summary, so the block reads as "what is working right now" rather
 * than an ever-growing wall of checkmarks. Every job, finished or not, stays
 * reachable in the /jobs view — the summary line opens it.
 *
 * Selection is by click (OpenTUI onMouseDown per row, same as
 * council-rail-rounds.tsx) — clicking the open row closes it again.
 */

import { ListItem, Region } from "../primitives/semantic-primitives.js";
import { type ActivityStatus, type AgentActivity, partitionForRail } from "../utils/agent-activities.js";
import type { Theme } from "../theme.js";
import { trunc } from "../utils/text.js";

/** Characters of detail shown when a row is open. Keeps the rail scrollable. */
const DETAIL_LIMIT = 600;

const GLYPH: Record<ActivityStatus, string> = { running: "▸", done: "✓", failed: "✗" };

function statusColor(status: ActivityStatus, t: Theme): string {
  if (status === "failed") return t.diffRemovedFg;
  if (status === "done") return t.diffAddedFg;
  return t.accent;
}

/** Row prefix naming what was spawned: the agent type, or "shell" for a job. */
export function activityPrefix(a: AgentActivity): string {
  if (a.kind === "background") return "shell";
  return a.agent || (a.kind === "delegate" ? "delegate" : "sub-agent");
}

export interface AgentRailActivitiesProps {
  activities: AgentActivity[];
  /** Tool-call id of the open row, or null when all are collapsed. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Opens the /jobs view (summary line click). */
  onOpenJobs?: () => void;
  width: number;
  t: Theme;
}

/** "3 done · 1 failed" — null when nothing has finished. */
export function finishedSummary(done: number, failed: number): string | null {
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function AgentRailActivities({
  activities,
  selected,
  onSelect,
  onOpenJobs,
  width,
  t,
}: AgentRailActivitiesProps) {
  if (activities.length === 0) return null;

  const { running: runningRows, done, failed } = partitionForRail(activities);
  const running = runningRows.length;
  const summary = finishedSummary(done, failed);

  return (
    <Region
      id="agent-rail-activities"
      name="Agents"
      value={`${activities.length}`}
      props={{
        count: activities.length,
        running,
        done,
        failed,
        selected: selected ?? "",
        ids: runningRows.map((a) => a.id).join(","),
      }}
    >
      <box flexDirection="column" flexShrink={0}>
        <text fg={t.textMuted} attributes={1}>
          {running > 0 ? `Agents (${running} running)` : "Agents"}
        </text>
        {runningRows.map((a) => {
          const isOpen = selected === a.id;
          return (
            <ListItem
              key={a.id}
              id={`rail-agent-${a.id}`}
              name={`${activityPrefix(a)} ${a.label}`}
              state={a.status}
              selected={isOpen || undefined}
            >
              <box flexDirection="column" flexShrink={0}>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI mouse routing on a plain box */}
                <box flexDirection="row" onMouseDown={() => onSelect(isOpen ? null : a.id)}>
                  <text>
                    <span style={{ fg: statusColor(a.status, t) }}>{`${GLYPH[a.status]} `}</span>
                    <span style={{ fg: t.textMuted }}>{`${activityPrefix(a)}  `}</span>
                    <span style={{ fg: t.text }}>{trunc(a.label, Math.max(8, width - 12))}</span>
                  </text>
                </box>
                {isOpen && (
                  <box paddingLeft={2} flexDirection="column">
                    {/* No detail is itself information — a running job that has
                      printed nothing yet must not look like a render bug. */}
                    <text fg={t.textDim}>{a.detail.trim() ? trunc(a.detail, DETAIL_LIMIT) : "(no output yet)"}</text>
                  </box>
                )}
              </box>
            </ListItem>
          );
        })}
        {summary && (
          <ListItem id="rail-agent-finished" name={summary} value={`${done + failed}`}>
            <box flexDirection="row" onMouseDown={() => onOpenJobs?.()}>
              <text>
                <span style={{ fg: failed > 0 ? t.diffRemovedFg : t.diffAddedFg }}>{failed > 0 ? "✗ " : "✓ "}</span>
                <span style={{ fg: t.textMuted }}>{`${summary} — /jobs`}</span>
              </text>
            </box>
          </ListItem>
        )}
      </box>
    </Region>
  );
}
