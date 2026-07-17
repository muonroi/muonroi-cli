/**
 * src/ui/components/tool-group.tsx
 *
 * Claude-Code-style "tool streak" panel — replaces the previous one-line-per-
 * tool render. Lifecycle:
 *   - active  → header "● Reading 2 files… (N tools · Ms)" + indented item list
 *   - done    → collapsed "● Read 2 files, ran 1 shell command  ctrl+e to expand"
 *   - failed  → always-expanded header + items, error item flagged red
 *
 * The header names the work per CATEGORY (see utils/tool-summary.ts) rather
 * than saying "Done": once the group collapses that line is all the user has,
 * so it has to carry the meaning. Items add the detail a glance needs — the
 * full shell command for bash, "Wrote N lines to <path>" before a write diff.
 *
 * The active group lives at the tail of the message stream as a regular
 * ChatEntry of type "tool_group"; closing the streak (assistant text arrives
 * or stream ends) flips its state to done/failed in place.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type { ChatEntry, FileDiff, ToolCall, ToolGroupItem } from "../../types/index";
import type { Theme } from "../theme.js";
import { trunc } from "../utils/text.js";
import { activeToolGroupHeader, doneToolGroupSummary } from "../utils/tool-summary.js";
import { toolLabel } from "../utils/tools.js";
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

// Max command lines rendered inline for a bash item; the rest are elided so a
// 40-line heredoc can't take over the transcript.
const BASH_INLINE_LINES = 8;

/** The command a bash item ran, split for multi-line display. Null when absent. */
export function bashCommandLines(tc: ToolCall): string[] | null {
  let cmd: unknown;
  try {
    cmd = JSON.parse(tc.function.arguments)?.command;
  } catch (err) {
    // Arguments stream in as partial JSON while the call is still assembling —
    // an unparseable value here is expected, not an error worth surfacing.
    return null;
  }
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  const lines = cmd.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= BASH_INLINE_LINES) return lines;
  const hidden = lines.length - BASH_INLINE_LINES;
  return [...lines.slice(0, BASH_INLINE_LINES), `… +${hidden} more line${hidden > 1 ? "s" : ""}`];
}

/**
 * One-line prose outcome for a write/edit, e.g. "Wrote 161 lines to a.ts" or
 * "Edited a.ts (+12 -3)". Null when the tool isn't a file mutation.
 */
export function writeOutcomeLine(toolName: string, diff: FileDiff): string | null {
  if (toolName === "write_file") {
    const n = diff.additions;
    return `Wrote ${n} line${n === 1 ? "" : "s"} to ${diff.filePath}`;
  }
  if (toolName === "edit_file") {
    return `Edited ${diff.filePath} (+${diff.additions} -${diff.removals})`;
  }
  return null;
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

  const toolNames = g.items.map((it) => it.toolCall.function.name);
  const elapsed = (g.finishedAt ?? Date.now()) - g.startedAt;
  const errorCount = g.items.filter((it) => it.failed).length;
  const total = g.items.length;

  // Decide whether the items list is visible. Active and failed always show
  // items; done collapses unless user expanded with ctrl+e.
  const showItems = g.state === "active" || g.state === "failed" || expanded;

  // Header names the actual work, counted per category:
  //   active: "Reading 2 files…"
  //   done:   "Read 2 files, ran 1 shell command"
  //   failed: "Failed (k errors)"
  // A bare "Done" told the user nothing about what just happened; the recap is
  // the only line left once the group collapses, so it carries the meaning.
  let headerVerb: string;
  let headerColor: string;
  if (g.state === "active") {
    headerVerb = activeToolGroupHeader(toolNames);
    headerColor = entry.modeColor || modeColor || t.accent;
  } else if (g.state === "failed") {
    headerVerb = errorCount > 0 ? `Failed (${errorCount} error${errorCount > 1 ? "s" : ""})` : "Failed";
    headerColor = t.diffRemovedFg;
  } else {
    headerVerb = doneToolGroupSummary(toolNames);
    headerColor = t.diffAddedFg;
  }

  // A restored group's timestamps are write-time, not a measured span — print
  // the count only rather than a fabricated duration.
  const stats = g.restored
    ? `${total} tool${total !== 1 ? "s" : ""}`
    : `${total} tool${total !== 1 ? "s" : ""} · ${fmtElapsed(elapsed)}`;

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
              // A bash call's whole point is WHICH command ran; truncating it to
              // one elided line hides that. Show every line, indented under the
              // item, the way a shell transcript reads.
              const bashLines = it.toolCall.function.name === "bash" ? bashCommandLines(it.toolCall) : null;
              // Shell transcript shape: "$ <first line>" on the item line, any
              // continuation lines aligned under it.
              const headLine = bashLines ? `$ ${bashLines[0]}` : label;
              const restLines = bashLines ? bashLines.slice(1) : [];
              return (
                <box key={it.toolCall.id} flexDirection="column">
                  <text>
                    <span style={{ fg: itemColor(it, t) }}>{`${itemGlyph(it)} `}</span>
                    <span style={{ fg: t.textMuted }}>{trunc(headLine, 100)}</span>
                    {errSuffix && <span style={{ fg: t.diffRemovedFg }}>{errSuffix}</span>}
                  </text>
                  {restLines.map((line, li) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: command lines are positional and immutable
                    <box key={`${it.toolCall.id}-cmd-${li}`} paddingLeft={2}>
                      <text fg={t.textMuted}>{trunc(line, 100)}</text>
                    </box>
                  ))}
                  {/* State the outcome in words before the diff renders it in
                    numbers — "Wrote 161 lines to x.ts" is what the user asked
                    for, and it is the only part that survives a glance. */}
                  {diff && writeOutcomeLine(it.toolCall.function.name, diff) && (
                    <box paddingLeft={2}>
                      <text fg={t.textMuted}>{writeOutcomeLine(it.toolCall.function.name, diff)}</text>
                    </box>
                  )}
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
