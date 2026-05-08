/**
 * EE PreToolUse inline warning renderer.
 *
 * EE-02: decision='allow' with matches[] emits ⚠ [Experience] lines
 * via a pluggable render sink (default: console.warn).
 *
 * Format per match (5 lines with visual border):
 *   ┌─ ⚠ Experience Warning ──────────────────────┐
 *   │ [{confidence}] {message}
 *   │ Why: {why}
 *   │ Scope: {scope_label}
 *   └──────────────────────────────────────────────┘
 */
import type { InterceptMatch } from "./types.js";
import type { StreamChunk } from "../types/index.js";

const BORDER_WIDTH = 46;
const TOP_BORDER = `┌─ ⚠ Experience Warning ${"─".repeat(BORDER_WIDTH - 22)}┐`;
const BOTTOM_BORDER = `└${"─".repeat(BORDER_WIDTH - 1)}┘`;

export type RenderSink = (lineOrChunk: string | StreamChunk) => void;
let _sink: RenderSink = (lineOrChunk) => {
  // Default: string → console.warn; StreamChunk → ignore (no active TUI)
  if (typeof lineOrChunk === "string") console.warn(lineOrChunk);
};

export function setRenderSink(fn: RenderSink): void {
  _sink = fn;
}
export function getRenderSink(): RenderSink {
  return _sink;
}

export function renderInterceptWarning(m: InterceptMatch): string {
  const conf = (m.confidence * 100).toFixed(0);
  const lines = [
    TOP_BORDER,
    `│ [${conf}%] ${m.message}`,
    `│ Why:   ${m.why}`,
    `│ Scope: ${m.scope_label}`,
    BOTTOM_BORDER,
  ];
  return lines.join("\n");
}

/**
 * Convert an InterceptMatch to an experience_warning StreamChunk.
 * Used by the TUI sink to render collapsible warning blocks.
 */
export function warningToChunk(m: InterceptMatch): StreamChunk {
  return {
    type: "experience_warning" as StreamChunk["type"],
    content: renderInterceptWarning(m),
    experienceWarning: {
      confidence: m.confidence,
      message: m.message,
      why: m.why,
      scopeLabel: m.scope_label,
      principleUuid: m.principle_uuid,
    },
  } as StreamChunk;
}

export function emitMatches(matches: InterceptMatch[] | undefined): void {
  if (!matches?.length) return;
  for (const m of matches) _sink(warningToChunk(m));
}
