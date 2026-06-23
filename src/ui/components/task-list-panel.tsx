/**
 * src/ui/components/task-list-panel.tsx
 *
 * Claude-Code-style sticky checklist panel. Renders the agent's current todo
 * snapshot (from `todo_write` tool calls) at the top of the chat log:
 *
 *     ┌ Todos ────────────────────────────────────────────────────┐
 *     │ ◉ Wiring askcard answer handler                            │
 *     │ ○ Add tests + self-verify                                  │
 *     │ ✓ ~~Define ToolGroupEntry types~~                          │
 *     │ ✓ ~~Define TaskListSnapshot type~~                         │
 *     │ … +3 more (ctrl+e to expand)                               │
 *     │ 4 completed · 2 queued · 1 in progress                     │
 *     └────────────────────────────────────────────────────────────┘
 *
 * Sort order: in_progress (top) → pending → completed (bottom). Each call to
 * todo_write fully replaces the snapshot — the panel re-renders from scratch.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type { TaskListItem, TaskListSnapshot } from "../../types/index";
import type { Theme } from "../theme.js";
import { trunc } from "../utils/text.js";

// Show at most this many items inline before collapsing the tail into
// "… +N more". Larger lists rarely fit on screen and add noise.
const MAX_VISIBLE = 8;

const STATUS_ORDER: Record<TaskListItem["status"], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

function sortItems(items: ReadonlyArray<TaskListItem>): TaskListItem[] {
  // Stable sort by status bucket. Preserves original order within a bucket so
  // the agent's authored order is kept when many items share the same state.
  return [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

interface ItemRowProps {
  item: TaskListItem;
  t: Theme;
}

function ItemRow({ item, t }: ItemRowProps) {
  let glyph: string;
  let glyphColor: string;
  let textColor: string;
  const label = item.status === "in_progress" ? (item.activeForm ?? item.subject) : item.subject;

  if (item.status === "completed") {
    glyph = "✓";
    glyphColor = t.diffAddedFg;
    textColor = t.textMuted;
  } else if (item.status === "in_progress") {
    glyph = "◉";
    glyphColor = t.accent;
    textColor = t.text;
  } else {
    glyph = "○";
    glyphColor = t.textMuted;
    textColor = t.text;
  }

  return (
    <Semantic id={`task-${item.id}`} role="listitem" name={label} state={item.status}>
      <box width="100%">
        <text fg={textColor}>
          <span style={{ fg: glyphColor }}>{`${glyph} `}</span>
          {trunc(label, 70)}
        </text>
      </box>
    </Semantic>
  );
}

export interface TaskListPanelProps {
  snapshot: TaskListSnapshot;
  t: Theme;
  expanded: boolean;
}

export function TaskListPanel({ snapshot, t, expanded }: TaskListPanelProps) {
  if (snapshot.items.length === 0) return null;
  const sorted = sortItems(snapshot.items);
  const overflow = !expanded && sorted.length > MAX_VISIBLE ? sorted.length - MAX_VISIBLE : 0;
  const visible = overflow > 0 ? sorted.slice(0, MAX_VISIBLE) : sorted;

  const { completed, inProgress, pending } = snapshot.counts;
  const footerParts: string[] = [];
  if (completed > 0) footerParts.push(`${completed} completed`);
  if (inProgress > 0) footerParts.push(`${inProgress} in progress`);
  if (pending > 0) footerParts.push(`${pending} queued`);
  const footer = footerParts.length > 0 ? footerParts.join(" · ") : "0 todos";

  return (
    <Semantic id="task-list" role="listbox" name="Todos">
      <box
        border
        borderColor={t.border}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={0}
        paddingBottom={0}
        marginBottom={1}
        flexDirection="column"
      >
        <box paddingBottom={1}>
          <text fg={t.textMuted}>
            <b>{"Todos"}</b>
          </text>
        </box>
        <box flexDirection="column">
          {visible.map((it) => (
            <ItemRow key={it.id} item={it} t={t} />
          ))}
        </box>
        {overflow > 0 && (
          <box marginTop={1}>
            <text fg={t.textMuted}>{`… +${overflow} more (ctrl+e to expand)`}</text>
          </box>
        )}
        <box marginTop={1} paddingTop={1} border={["top"]} borderColor={t.border}>
          <text fg={t.textDim}>{footer}</text>
        </box>
      </box>
    </Semantic>
  );
}

export const __TEST_ONLY__ = { sortItems, MAX_VISIBLE };
