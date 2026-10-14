/**
 * src/ui/modals/jobs-modal.tsx
 *
 * `/jobs` — every sub-agent and background job this session spawned, running
 * ones first. The rail lists only running work; this is where a finished job's
 * prompt and result stay reachable, and where a running background job can be
 * stopped.
 *
 * Keys (handled in use-app-logic): ↑/↓ select · enter open/close the detail ·
 * ctrl+x stop the selected background job · esc close.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { activityPrefix } from "../components/agent-rail-activities.js";
import type { Theme } from "../theme";
import type { ActivityStatus, AgentActivity } from "../utils/agent-activities.js";
import { trunc } from "../utils/text.js";

/** Characters of detail shown for the open row. */
const DETAIL_LIMIT = 2_000;

const GLYPH: Record<ActivityStatus, string> = { running: "▸", done: "✓", failed: "✗" };

/** Only a spawned background job can be stopped from here — a foreground task is part of the turn. */
export function canStopJob(a: AgentActivity | undefined): boolean {
  return !!a && a.status === "running" && !!a.job;
}

export function JobsModal({
  t,
  width,
  height,
  rows,
  selectedIndex,
  expandedId,
  focused,
}: {
  t: Theme;
  width: number;
  height: number;
  /** Already in display order (orderForJobsView). */
  rows: AgentActivity[];
  selectedIndex: number;
  /** Id of the row whose detail is open, or null. */
  expandedId: string | null;
  /** True when this surface owns the keyboard (see src/ui/modal-focus.ts). */
  focused?: boolean;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    const selected = rows[selectedIndex];
    if (!selected) return;
    listRef.current?.scrollChildIntoView(`job-${selected.id}`);
  }, [rows, selectedIndex]);

  const running = rows.filter((r) => r.status === "running").length;
  const panelHeight = Math.max(10, Math.floor(height * 0.75));
  const panelWidth = Math.min(100, width - 6);
  const labelWidth = Math.max(10, panelWidth - 20);
  const overlayBg = "#000000cc" as string;

  const statusColor = (s: ActivityStatus) =>
    s === "failed" ? t.diffRemovedFg : s === "done" ? t.diffAddedFg : t.accent;

  return (
    <Semantic
      id="jobs-modal"
      role="dialog"
      name="Background jobs"
      value={`${rows.length}`}
      props={{ count: rows.length, running }}
      focus={focused || undefined}
      isModal
    >
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={Math.max(1, Math.floor((height - panelHeight) / 2))}
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
              <b>{running > 0 ? `Background jobs (${running} running)` : "Background jobs"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <Semantic id="jobs-list" role="listbox">
            <scrollbox ref={listRef} flexGrow={1} minHeight={0} paddingTop={1}>
              {rows.map((a, idx) => {
                const selected = idx === selectedIndex;
                const open = expandedId === a.id;
                return (
                  <Semantic
                    key={`job-${a.id}`}
                    id={`job-${a.id}`}
                    role="listitem"
                    name={`${activityPrefix(a)} ${a.label}`}
                    state={a.status}
                    selected={selected || undefined}
                  >
                    <box
                      id={`job-${a.id}`}
                      width="100%"
                      flexDirection="column"
                      backgroundColor={selected ? t.selectedBg : undefined}
                      paddingLeft={2}
                      paddingRight={2}
                    >
                      <text>
                        <span style={{ fg: statusColor(a.status) }}>{`${GLYPH[a.status]} `}</span>
                        <span style={{ fg: t.textMuted }}>{`${activityPrefix(a).padEnd(9)} `}</span>
                        <span style={{ fg: selected ? t.primary : t.text }}>{trunc(a.label, labelWidth)}</span>
                      </text>
                      {open && (
                        <box paddingLeft={2} paddingBottom={1}>
                          <text fg={t.textDim}>
                            {a.detail.trim() ? trunc(a.detail, DETAIL_LIMIT) : "(no output yet)"}
                          </text>
                        </box>
                      )}
                    </box>
                  </Semantic>
                );
              })}
              {rows.length === 0 ? (
                <box paddingLeft={2} paddingRight={2}>
                  <text fg={t.textMuted}>{"No sub-agents or background jobs in this session yet"}</text>
                </box>
              ) : null}
            </scrollbox>
          </Semantic>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text>
              <span style={{ fg: t.primary }}>{"↑↓ "}</span>
              <span style={{ fg: t.textMuted }}>{"select · "}</span>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"details · "}</span>
              <span style={{ fg: canStopJob(rows[selectedIndex]) ? t.primary : t.textMuted }}>{"ctrl+x "}</span>
              <span style={{ fg: t.textMuted }}>{"stop job"}</span>
            </text>
          </box>
        </box>
      </box>
    </Semantic>
  );
}
