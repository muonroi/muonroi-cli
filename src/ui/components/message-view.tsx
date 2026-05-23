import { memo } from "react";
import type { ChatEntry } from "../../types/index";
import { Markdown } from "../markdown.js";
import { PlanView } from "../plan.js";
import type { Theme } from "../theme.js";
import { trunc } from "../utils/text.js";
import { describeMcpFsTool, toolArgs, toolLabel, tryParseArg } from "../utils/tools.js";
import { DiffView, ReadFilePreviewView } from "./diff-view.js";
import { LspDiagnosticsView, LspResultView } from "./lsp-views.js";
import { MediaAutoOpenView, MediaToolResultView } from "./media-views.js";
import { StructuredResponseView } from "./structured-response-view.js";
import { ToolGroupView } from "./tool-group.js";
import {
  BackgroundProcessLine,
  DelegationListView,
  DelegationResultView,
  InlineTool,
  ProcessLogsView,
  TaskResultView,
  ToolTextOutputView,
} from "./tool-result-views.js";

const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

const USER_MSG_COLLAPSED_LINES = 5;
// Long assistant blocks (model narration between tool batches) auto-collapse
// to this many lines to stop the chat scroll wall and cut markdown re-render
// cost. 8 fits comfortably on a short terminal and conveys the gist.
const ASSISTANT_MSG_COLLAPSED_LINES = 8;

export function AssistantMessageContent({ content, t, expanded }: { content: string; t: Theme; expanded: boolean }) {
  const lines = content.split("\n");
  const isLong = lines.length > ASSISTANT_MSG_COLLAPSED_LINES;
  if (!isLong) {
    return <Markdown content={content} t={t} />;
  }
  if (expanded) {
    return (
      <>
        <Markdown content={content} t={t} />
        <box marginTop={1}>
          <text fg={t.textDim}>
            {"ctrl+e "}
            <span style={{ fg: t.textMuted }}>{"collapse"}</span>
          </text>
        </box>
      </>
    );
  }
  const preview = lines.slice(0, ASSISTANT_MSG_COLLAPSED_LINES).join("\n");
  const hidden = lines.length - ASSISTANT_MSG_COLLAPSED_LINES;
  return (
    <>
      <Markdown content={preview} t={t} />
      <box marginTop={1}>
        <text fg={t.textDim}>
          {"ctrl+e "}
          <span style={{ fg: t.textMuted }}>{`expand (${hidden} more lines)`}</span>
        </text>
      </box>
    </>
  );
}

export function UserMessageContent({ content, t, expanded }: { content: string; t: Theme; expanded: boolean }) {
  const lines = content.split("\n");
  const isLong = lines.length > USER_MSG_COLLAPSED_LINES;

  if (!isLong) {
    return <text fg={t.text}>{content}</text>;
  }

  if (expanded) {
    return (
      <>
        <text fg={t.text}>{content}</text>
        <box marginTop={1}>
          <text fg={t.textDim}>
            {"ctrl+e "}
            <span style={{ fg: t.textMuted }}>{"collapse"}</span>
          </text>
        </box>
      </>
    );
  }

  const preview = lines.slice(0, USER_MSG_COLLAPSED_LINES).join("\n");
  const hiddenCount = lines.length - USER_MSG_COLLAPSED_LINES;
  return (
    <>
      <text fg={t.text}>{preview}</text>
      <box marginTop={1}>
        <text fg={t.textDim}>
          {"ctrl+e "}
          <span style={{ fg: t.textMuted }}>{`expand (${hiddenCount} more lines)`}</span>
        </text>
      </box>
    </>
  );
}

/** Per-index instructions for collapsing consecutive identical MCP fs calls. */
export interface McpRunInfo {
  /** True when this entry should NOT render (it's a continuation of an earlier run). */
  hidden: boolean;
  /** When set, this entry IS the head of a run with N entries — show the count badge. */
  count?: number;
  /** Extracted paths for the run (head only), used to render a compact list under the header. */
  paths?: string[];
}

/**
 * Walks the messages array once and computes a McpRunInfo per index. Two
 * consecutive `tool_result` entries belong to the same run iff their tool name
 * is the same MCP filesystem call. The first index in a run carries the count
 * and the path list; subsequent indices are marked hidden so they don't render.
 */
export function computeMcpRunInfo(messages: ChatEntry[]): McpRunInfo[] {
  const out: McpRunInfo[] = messages.map(() => ({ hidden: false }));
  let runStart = -1;
  let runName: string | null = null;
  const runPaths: string[] = [];

  const finalizeRun = () => {
    if (runStart >= 0 && runPaths.length > 1) {
      out[runStart] = { hidden: false, count: runPaths.length, paths: [...runPaths] };
      for (let k = runStart + 1; k < runStart + runPaths.length; k++) {
        out[k] = { hidden: true };
      }
    }
    runStart = -1;
    runName = null;
    runPaths.length = 0;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const tc = m.toolCall;
    const isMcpFsResult = m.type === "tool_result" && tc && describeMcpFsTool(tc.function.name) !== null;
    if (isMcpFsResult) {
      const name = tc!.function.name;
      const path = toolArgs(tc) || "";
      if (runName === name) {
        runPaths.push(path);
      } else {
        finalizeRun();
        runStart = i;
        runName = name;
        runPaths.push(path);
      }
    } else {
      finalizeRun();
    }
  }
  finalizeRun();
  return out;
}

function MessageViewImpl({
  entry,
  index,
  t,
  modeColor,
  expandedMessages,
  mcpRun,
}: {
  entry: ChatEntry;
  index: number;
  t: Theme;
  modeColor: string;
  expandedMessages?: Set<number>;
  mcpRun?: McpRunInfo;
}) {
  if (mcpRun?.hidden) return null;
  switch (entry.type) {
    case "user":
      return (
        <box
          border={["left"]}
          customBorderChars={SPLIT}
          borderColor={entry.modeColor || modeColor}
          marginTop={index === 0 ? 0 : 1}
          marginBottom={1}
        >
          <box
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={t.backgroundPanel}
            flexShrink={0}
            flexDirection="column"
          >
            {entry.sourceLabel ? <text fg={t.textMuted}>{entry.sourceLabel}</text> : null}
            <UserMessageContent content={entry.content} t={t} expanded={expandedMessages?.has(index) ?? false} />
          </box>
        </box>
      );

    case "assistant":
      return (
        <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
          {entry.sourceLabel ? <text fg={t.textMuted}>{entry.sourceLabel}</text> : null}
          <AssistantMessageContent content={entry.content} t={t} expanded={expandedMessages?.has(index) ?? false} />
        </box>
      );

    case "tool_call":
      return (
        <box paddingLeft={3} marginTop={1}>
          <text>
            <span style={{ fg: entry.modeColor || modeColor }}>{"▣ "}</span>
            <span style={{ fg: t.textMuted }}>{entry.content.replace("▣  ", "")}</span>
          </text>
        </box>
      );

    case "tool_group":
      return (
        <ToolGroupView entry={entry} t={t} expanded={expandedMessages?.has(index) ?? false} modeColor={modeColor} />
      );

    case "tool_result": {
      const name = entry.toolCall?.function.name || "tool";
      const args = toolArgs(entry.toolCall);
      const diff = entry.toolResult?.diff;
      const plan = entry.toolResult?.plan;

      if (name === "generate_plan" && plan) {
        return <PlanView plan={plan} t={t} />;
      }

      if (name === "task" && entry.toolResult?.task) {
        return <TaskResultView t={t} entry={entry} />;
      }

      if (name === "delegate" && entry.toolResult?.delegation) {
        return <DelegationResultView t={t} entry={entry} />;
      }

      if (name === "delegation_list") {
        return <DelegationListView t={t} content={entry.content} />;
      }

      if (name === "delegation_read") {
        return <ToolTextOutputView t={t} label={toolLabel(entry.toolCall!)} content={entry.content} />;
      }

      if (name === "lsp") {
        const lspOp = tryParseArg(entry.toolCall, "operation") || "query";
        const lspFile = tryParseArg(entry.toolCall, "filePath") || "";
        const lspLine = tryParseArg(entry.toolCall, "line");
        const lspPos = lspLine ? `:${lspLine}` : "";
        return (
          <box gap={0} marginTop={1}>
            <InlineTool t={t} pending={false}>
              {`lsp ${lspOp} ${lspFile}${lspPos}`}
            </InlineTool>
            <LspResultView t={t} operation={lspOp} filePath={lspFile} position={lspPos} content={entry.content} />
          </box>
        );
      }

      if ((entry.toolResult?.media?.length ?? 0) > 0) {
        if (name === "generate_image" || name === "generate_video") {
          return <MediaAutoOpenView t={t} label={toolLabel(entry.toolCall!)} toolResult={entry.toolResult!} />;
        }
        return <MediaToolResultView t={t} label={toolLabel(entry.toolCall!)} toolResult={entry.toolResult!} />;
      }

      if (name === "write_file" || name === "edit_file") {
        const filePath =
          diff?.filePath || tryParseArg(entry.toolCall, "file_path") || tryParseArg(entry.toolCall, "path") || args;
        const label = name === "write_file" ? `Write ${filePath}` : `Edit ${filePath}`;
        return (
          <box gap={0}>
            <InlineTool t={t} pending={false}>
              {label}
            </InlineTool>
            {diff && <DiffView t={t} diff={diff} />}
            {(entry.toolResult?.lspDiagnostics?.length ?? 0) > 0 && (
              <LspDiagnosticsView t={t} diagnostics={entry.toolResult?.lspDiagnostics ?? []} />
            )}
          </box>
        );
      }

      if (name === "bash" && entry.toolResult?.backgroundProcess) {
        const bp = entry.toolResult.backgroundProcess;
        return <BackgroundProcessLine t={t} id={bp.id} pid={bp.pid} command={bp.command} />;
      }

      if (name === "process_logs") {
        return <ProcessLogsView t={t} content={entry.content} />;
      }

      if (name === "process_stop" || name === "process_list") {
        return (
          <InlineTool t={t} pending={false}>
            {entry.content}
          </InlineTool>
        );
      }

      if (name === "read_file") {
        // PIL-L6 v2 — render only the action line. The file body is for the
        // model, not the user — showing a 10-line preview per read_file call
        // crowds the TUI when the agent fans out across many files in a
        // single debug turn (session 127140a47b56 had 27 read_file calls).
        // Error strings still surface via ReadFilePreviewView when the read
        // failed.
        const readPath = tryParseArg(entry.toolCall, "file_path") || tryParseArg(entry.toolCall, "path") || args;
        const body = (entry.content ?? "").trimEnd();
        const failed = body.startsWith("File not found:") || body.startsWith("Failed to read file:");
        return (
          <box gap={0}>
            <InlineTool t={t} pending={false}>{`Read ${trunc(readPath, 60)}`}</InlineTool>
            {failed && <ReadFilePreviewView t={t} filePath={readPath} content={entry.content} />}
          </box>
        );
      }
      if (name === "grep")
        return (
          <InlineTool t={t} pending={false}>
            {`Grep ${trunc(args, 60)}`}
          </InlineTool>
        );
      if (name === "search_web" || name === "search_x")
        return (
          <InlineTool t={t} pending={false}>
            {name === "search_web" ? "Web" : "X"}
            {` Search "${trunc(args, 60)}"`}
          </InlineTool>
        );

      // MCP filesystem tools — render a friendly label, and collapse consecutive
      // identical calls into a single header line + compact path list.
      const mcpDesc = entry.toolCall ? describeMcpFsTool(name) : null;
      if (mcpDesc) {
        if (mcpRun?.count && mcpRun.count > 1 && mcpRun.paths) {
          const PREVIEW = 4;
          const head = mcpRun.paths.slice(0, PREVIEW);
          const rest = mcpRun.paths.length - head.length;
          return (
            <box flexDirection="column" gap={0}>
              <InlineTool t={t} pending={false}>
                {`MCP ${mcpDesc.ns} ${mcpDesc.verb} × ${mcpRun.count}`}
              </InlineTool>
              {head.map((p, i) => (
                <box key={`mcprun-${index}-${i}`} paddingLeft={5}>
                  <text fg={t.textDim}>{`· ${trunc(p || "(no path)", 80)}`}</text>
                </box>
              ))}
              {rest > 0 && (
                <box paddingLeft={5}>
                  <text fg={t.textDim}>{`· … +${rest} more`}</text>
                </box>
              )}
            </box>
          );
        }
        return (
          <InlineTool t={t} pending={false}>
            {`MCP ${mcpDesc.ns} ${mcpDesc.verb}${args ? ` ${trunc(args, 60)}` : ""}`}
          </InlineTool>
        );
      }

      return (
        <InlineTool t={t} pending={false}>
          {trunc(name === "bash" ? args : `${name} ${args}`, 80)}
        </InlineTool>
      );
    }

    case "structured_response": {
      const sr = entry.structuredResponse;
      if (!sr) return <text fg={t.textMuted}>{entry.content}</text>;
      return <StructuredResponseView t={t} sr={sr} modeColor={entry.modeColor || modeColor} />;
    }

    default:
      return <text fg={t.textMuted}>{entry.content}</text>;
  }
}

// React.memo wrapper — message log re-renders on every keystroke + every
// 60Hz harness tick. Without memo, every assistant block re-runs its
// Markdown parser per frame; an 11KB CoT block froze the renderer in
// session 7b6f6ea1b719. The comparator skips re-render when:
//   - the entry reference is identical (append-only log → safe)
//   - the per-index expanded flag is unchanged
//   - mcpRun shape (hidden + count) hasn't shifted
// Theme + modeColor are module-level constants so they don't need to
// drive re-renders.
export const MessageView = memo(MessageViewImpl, (prev, next) => {
  if (prev.entry !== next.entry) return false;
  if (prev.index !== next.index) return false;
  if (prev.modeColor !== next.modeColor) return false;
  const prevExpanded = prev.expandedMessages?.has(prev.index) ?? false;
  const nextExpanded = next.expandedMessages?.has(next.index) ?? false;
  if (prevExpanded !== nextExpanded) return false;
  const prevMcp = prev.mcpRun;
  const nextMcp = next.mcpRun;
  if ((prevMcp?.hidden ?? false) !== (nextMcp?.hidden ?? false)) return false;
  if ((prevMcp?.count ?? 0) !== (nextMcp?.count ?? 0)) return false;
  return true;
});
