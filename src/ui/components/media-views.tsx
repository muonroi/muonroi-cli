import { useEffect, useRef } from "react";
import type { ToolResult } from "../../types/index";
import { Markdown } from "../markdown";
import type { Theme } from "../theme";
import { InlineTool } from "./tool-result-views.js";

export function openMediaFile(filePath: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    require("child_process").execFile(cmd, [filePath]);
  } catch {}
}

export function MediaAutoOpenView({ t, label, toolResult }: { t: Theme; label: string; toolResult: ToolResult }) {
  const media = toolResult.media ?? [];
  const openedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const asset of media) {
      if (!openedRef.current.has(asset.path)) {
        openedRef.current.add(asset.path);
        openMediaFile(asset.path);
      }
    }
  }, [media]);

  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
    </box>
  );
}

export function MediaToolResultView({ t, label, toolResult }: { t: Theme; label: string; toolResult: ToolResult }) {
  const media = toolResult.media ?? [];

  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
      {toolResult.output ? (
        <box paddingLeft={5} marginTop={1} flexShrink={0}>
          <Markdown content={toolResult.output} t={t} />
        </box>
      ) : null}
      {media.length > 0 ? (
        <box paddingLeft={5} marginTop={toolResult.output ? 1 : 0} flexDirection="column">
          {media.map((asset) => (
            <box
              key={`${asset.path}-${asset.url ?? ""}-${asset.sourcePath ?? ""}-${asset.sourceUrl ?? ""}`}
              flexDirection="column"
            >
              <text fg={t.text}>{asset.path}</text>
              {asset.url ? <text fg={t.textMuted}>{`url: ${asset.url}`}</text> : null}
              {asset.sourcePath ? <text fg={t.textMuted}>{`source: ${asset.sourcePath}`}</text> : null}
              {asset.sourceUrl ? <text fg={t.textMuted}>{`source_url: ${asset.sourceUrl}`}</text> : null}
            </box>
          ))}
        </box>
      ) : null}
    </box>
  );
}
