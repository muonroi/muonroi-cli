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
 * Selection is by click (OpenTUI onMouseDown per row, same as
 * council-rail-rounds.tsx) — clicking the open row closes it again.
 */

import { ListItem, Region } from "../primitives/semantic-primitives.js";
import type { ActivityStatus, AgentActivity } from "../utils/agent-activities.js";
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
  width: number;
  t: Theme;
}

export function AgentRailActivities({ activities, selected, onSelect, width, t }: AgentRailActivitiesProps) {
  if (activities.length === 0) return null;

  const running = activities.filter((a) => a.status === "running").length;

  return (
    <Region
      id="agent-rail-activities"
      name="Agents"
      value={`${activities.length}`}
      props={{
        count: activities.length,
        running,
        selected: selected ?? "",
        ids: activities.map((a) => a.id).join(","),
      }}
    >
      <box flexDirection="column" flexShrink={0}>
        <text fg={t.textMuted} attributes={1}>
          {running > 0 ? `Agents (${running} running)` : "Agents"}
        </text>
        {activities.map((a) => {
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
      </box>
    </Region>
  );
}
