import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ResumeEntry } from "../../types/index.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

/**
 * Recent-sessions picker. Opened by `/sessions` or `/session`. Selecting a
 * row relaunches the CLI with `--session <id>` (see ui/utils/relaunch.ts) so
 * the user does not need to remember the id or restart by hand.
 */
export function SessionPickerModal({
  t,
  sessions,
  focusIndex,
  width,
  height,
}: {
  t: Theme;
  sessions: ResumeEntry[];
  focusIndex: number;
  width: number;
  height: number;
}) {
  const panelWidth = Math.min(80, width - 6);
  const rowCount = Math.max(sessions.length, 1);
  // 4 chrome lines (title row + spacer + footer + paddings) + the rows
  const contentHeight = rowCount + 4;
  const maxH = Math.floor(height * 0.7);
  const panelHeight = Math.min(contentHeight, maxH);
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  return (
    <Semantic id="session-picker" role="dialog" name="Resume session" isModal>
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={top}
        backgroundColor={overlayBg}
      >
        <box
          width={panelWidth}
          height={panelHeight}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
            <text fg={t.primary}>
              <b>{"Resume session"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <scrollbox flexGrow={1} minHeight={0}>
            {sessions.length === 0 ? (
              <box paddingLeft={2} paddingRight={2} paddingTop={1}>
                <text fg={t.textMuted}>{"No prior sessions in this workspace."}</text>
              </box>
            ) : (
              sessions.map((s, idx) => {
                const focused = idx === focusIndex;
                const ts = formatTimestamp(s.updatedAt);
                const titleRaw = s.title?.trim() || "(untitled)";
                const titleMax = Math.max(8, panelWidth - 38);
                const title = titleRaw.length > titleMax ? `${titleRaw.slice(0, titleMax - 1)}…` : titleRaw;
                // Short 8-char id — the tree's root id, enough to disambiguate
                // rows without crowding the model column.
                const idLabel = s.id.slice(0, 8);
                return (
                  <Semantic
                    key={s.id}
                    id={`session-item-${idx}`}
                    role="listitem"
                    name={`${title} ${idLabel}`}
                    value={s.id}
                    selected={focused || undefined}
                  >
                    <box
                      backgroundColor={focused ? t.selectedBg : undefined}
                      paddingLeft={2}
                      paddingRight={2}
                      width="100%"
                      flexDirection="row"
                      justifyContent="space-between"
                    >
                      <text fg={focused ? t.selected : t.text}>{`${ts}  ${title}`}</text>
                      <text fg={focused ? t.primary : t.textMuted}>{`${s.model}  ${idLabel}`}</text>
                    </box>
                  </Semantic>
                );
              })
            )}
          </scrollbox>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.textMuted}>{"↑↓ navigate · enter resume (restarts CLI) · esc cancel"}</text>
          </box>
        </box>
      </box>
    </Semantic>
  );
}

/**
 * Compact MM-DD HH:MM timestamp for the picker rows. Trades the year for
 * space — the picker is workspace-scoped + lists the latest 20 sessions, so
 * a year boundary is rare and an obvious context.
 */
function formatTimestamp(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}
