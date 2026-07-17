/**
 * src/ui/utils/group-tool-entries.ts
 *
 * Rebuild the tool_group panels when a flat transcript is (re)loaded.
 *
 * WHY: the live turn renders tool calls inside a `tool_group` ChatEntry, but the
 * persisted transcript stores one `tool_result` entry per call. Anything that
 * replaces the message list with `agent.getChatEntries()` — the end-of-turn
 * resync in finalizeActiveTurn, session load, resume — therefore DESTROYED the
 * group and dropped the transcript back to one flat "→ <tool>" line per call.
 * That is what a user sees after the answer lands, so the nice
 * "Read 2 files, ran 1 shell command" recap only ever existed mid-turn.
 *
 * This folds consecutive tool_result entries back into a done/failed group.
 */

import type { ChatEntry, ToolGroupItem } from "../../types/index";

/**
 * Tool results whose own renderer shows something a tool-group item line cannot
 * (a plan, a sub-agent run, an image, streaming process logs). These stay as
 * standalone entries and also break a run, so ordering is preserved.
 */
function rendersRichResult(entry: ChatEntry): boolean {
  const name = entry.toolCall?.function.name ?? "";
  const r = entry.toolResult;
  if (!r) return true;
  if (r.plan || r.task || r.delegation || r.backgroundProcess || (r.media?.length ?? 0) > 0) return true;
  return (
    name === "generate_plan" ||
    name === "task" ||
    name === "delegate" ||
    name === "delegation_list" ||
    name === "delegation_read" ||
    name === "lsp" ||
    name === "process_logs" ||
    name === "process_stop" ||
    name === "process_list"
  );
}

function groupable(entry: ChatEntry): boolean {
  return entry.type === "tool_result" && !!entry.toolCall && !rendersRichResult(entry);
}

function toItem(entry: ChatEntry): ToolGroupItem {
  const at = entry.timestamp instanceof Date ? entry.timestamp.getTime() : Date.now();
  const failed = entry.toolResult?.success === false;
  return {
    toolCall: entry.toolCall!,
    result: entry.toolResult,
    startedAt: at,
    finishedAt: at,
    ...(failed ? { failed: true } : {}),
  };
}

/**
 * Fold runs of consecutive groupable tool_result entries into one tool_group
 * entry each. Non-tool entries and rich results pass through untouched, so the
 * transcript keeps its order. A run of one is still grouped: the recap line
 * ("Read 1 file") is what stays visible once collapsed.
 *
 * `tool_call` entries are dropped inside a run — they are the pending twin of a
 * result that is already represented by the item.
 */
export function groupToolEntries(entries: ChatEntry[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  let run: ChatEntry[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const items = run.map(toItem);
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const startedAt = items[0]!.startedAt;
    const finishedAt = items[items.length - 1]!.finishedAt ?? startedAt;
    out.push({
      type: "tool_group",
      content: "",
      timestamp: first.timestamp,
      ...(first.modeColor ? { modeColor: first.modeColor } : {}),
      ...(first.remoteKey ? { remoteKey: first.remoteKey } : {}),
      ...(first.sourceLabel ? { sourceLabel: first.sourceLabel } : {}),
      toolGroup: {
        // Deterministic id: the same transcript must rebuild to the same ids, or
        // React remounts every group on each resync and expansion state is lost.
        id: `tg-restored-${startedAt}-${items.length}-${last.toolCall?.id ?? "x"}`,
        state: items.some((i) => i.failed) ? "failed" : "done",
        items,
        startedAt,
        finishedAt,
        // The persisted entries carry a write-time timestamp, not the tool's real
        // wall-clock span, so any duration derived here is fiction (a 10s turn
        // rebuilt as "23ms"). Flag it and let the header omit the number rather
        // than print a confident lie.
        restored: true,
      },
    });
    run = [];
  };

  for (const entry of entries) {
    if (groupable(entry)) {
      run.push(entry);
      continue;
    }
    // A pending tool_call adjacent to a run is already covered by the run's
    // items; dropping it prevents a duplicate line above the group.
    if (entry.type === "tool_call" && run.length > 0) continue;
    flush();
    out.push(entry);
  }
  flush();
  return out;
}
