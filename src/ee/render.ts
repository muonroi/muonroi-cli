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

const BORDER_WIDTH = 46;
const TOP_BORDER = `┌─ ⚠ Experience Warning ${"─".repeat(BORDER_WIDTH - 22)}┐`;
const BOTTOM_BORDER = `└${"─".repeat(BORDER_WIDTH - 1)}┘`;

type RenderSink = (line: string) => void;
let _sink: RenderSink = (line) => {
  console.warn(line);
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

export function emitMatches(matches: InterceptMatch[] | undefined): void {
  if (!matches?.length) return;
  for (const m of matches) _sink(renderInterceptWarning(m));
}
