/**
 * src/ui/components/tool-group.tsx
 *
 * Claude-Code-style "tool streak" panel — replaces the previous one-line-per-
 * tool render. Lifecycle:
 *   - active  → header "● <Verb>… (N tools · Ms)" + indented item list
 *   - done    → collapsed "● Done (N tool uses · Ms)  ctrl+e to expand"
 *   - failed  → always-expanded header + items, error item flagged red
 *
 * The active group lives at the tail of the message stream as a regular
 * ChatEntry of type "tool_group"; closing the streak (assistant text arrives
 * or stream ends) flips its state to done/failed in place.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ChatEntry, ToolGroupItem } from "../../types/index";
import type { Theme } from "../theme.js";
import { trunc } from "../utils/text.js";
import { dominantVerb, toolLabel } from "../utils/tools.js";
import { DiffView } from "./diff-view.js";

// Tools whose result carries a FileDiff worth rendering inline under the item
// line. Mirrors the per-tool branch in message-view.tsx so grouped edits show
// the same +/- diff a non-grouped tool_result would.
const DIFF_TOOLS = new Set(["write_file", "edit_file"]);

// Max items rendered inline while a group is active. Anything beyond gets a
// "+N more (ctrl+e expand)" affordance — matches Claude Code's overflow line.
const ACTIVE_INLINE_LIMIT = 8;

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remS = Math.floor(s % 60);
  return `${m}m ${remS.toString().padStart(2, "0")}s`;
}

function itemGlyph(item: ToolGroupItem): string {
  if (item.failed) return "✗";
  if (item.result) return "✓";
  return "▸";
}

function itemColor(item: ToolGroupItem, t: Theme): string {
  if (item.failed) return t.diffRemovedFg;
  if (item.result) return t.diffAddedFg;
  return t.textMuted;
}

export interface ToolGroupViewProps {
  entry: ChatEntry;
  t: Theme;
  expanded: boolean;
  modeColor: string;
}

export function ToolGroupView({ entry, t, expanded, modeColor }: ToolGroupViewProps) {
  const g = entry.toolGroup;
  if (!g) return null;

  const verb = dominantVerb(g.items.map((it) => it.toolCall.function.name));
  const elapsed = (g.finishedAt ?? Date.now()) - g.startedAt;
  const errorCount = g.items.filter((it) => it.failed).length;
  const total = g.items.length;

  // Decide whether the items list is visible. Active and failed always show
  // items; done collapses unless user expanded with ctrl+e.
  const showItems = g.state === "active" || g.state === "failed" || expanded;

  // Header text mirrors Claude Code phrasing:
  //   active: "Reading…"
  //   done:   "Done"
  //   failed: "Failed (k errors)"
  let headerVerb: string;
  let headerColor: string;
  if (g.state === "active") {
    headerVerb = `${verb}…`;
    headerColor = entry.modeColor || modeColor || t.accent;
  } else if (g.state === "failed") {
    headerVerb = errorCount > 0 ? `Failed (${errorCount} error${errorCount > 1 ? "s" : ""})` : "Failed";
    headerColor = t.diffRemovedFg;
  } else {
    headerVerb = "Done";
    headerColor = t.diffAddedFg;
  }

  const stats = `${total} tool${total !== 1 ? "s" : ""} · ${fmtElapsed(elapsed)}`;

  // Items to render: active capped at ACTIVE_INLINE_LIMIT (overflow line);
  // expanded done/failed shows everything.
  const overflow = g.state === "active" && total > ACTIVE_INLINE_LIMIT ? total - ACTIVE_INLINE_LIMIT : 0;
  const visibleItems = overflow > 0 ? g.items.slice(g.items.length - ACTIVE_INLINE_LIMIT) : g.items;

  return (
    <Semantic id={`tool-group-${g.id}`} role="region" name={headerVerb} state={g.state}>
      <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
        <text>
          <span style={{ fg: headerColor }}>{"● "}</span>
          <span style={{ fg: t.text }}>{headerVerb}</span>
          <span style={{ fg: t.textMuted }}>{`  (${stats})`}</span>
        </text>

        {showItems && visibleItems.length > 0 && (
          <box paddingLeft={2} flexDirection="column">
            {overflow > 0 && (
              <text
                fg={t.textMuted}
              >{`… +${overflow} earlier ${overflow > 1 ? "tools" : "tool"} (ctrl+e to expand)`}</text>
            )}
            {visibleItems.map((it) => {
              const label = trunc(toolLabel(it.toolCall), 90);
              const errSuffix =
                it.failed && it.result?.error ? `  — ${trunc(it.result.error.replace(/\s+/g, " "), 60)}` : "";
              const diff = !it.failed && DIFF_TOOLS.has(it.toolCall.function.name) ? it.result?.diff : undefined;
              return (
                <box key={it.toolCall.id} flexDirection="column">
                  <text>
                    <span style={{ fg: itemColor(it, t) }}>{`${itemGlyph(it)} `}</span>
                    <span style={{ fg: t.textMuted }}>{label}</span>
                    {errSuffix && <span style={{ fg: t.diffRemovedFg }}>{errSuffix}</span>}
                  </text>
                  {diff && <DiffView t={t} diff={diff} />}
                </box>
              );
            })}
          </box>
        )}

        {g.state === "done" && !expanded && total > 0 && (
          <box paddingLeft={2}>
            <text fg={t.textDim}>{"ctrl+e to expand"}</text>
          </box>
        )}
      </box>
    </Semantic>
  );
}
