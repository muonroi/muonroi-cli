/**
 * EE PreToolUse inline warning renderer.
 *
 * EE-02: decision='allow' with matches[] emits ⚠ [Experience] lines
 * via a pluggable render sink (default: console.warn).
 *
 * Format per match (3 lines):
 *   ⚠ [Experience - {confidence}] {message}
 *     Why: {why}
 *     Scope: {scope_label}
 */
import type { InterceptMatch } from "./types.js";

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
  const conf = m.confidence.toFixed(2);
  return `⚠ [Experience - ${conf}] ${m.message}\n  Why: ${m.why}\n  Scope: ${m.scope_label}`;
}

export function emitMatches(
  matches: InterceptMatch[] | undefined,
): void {
  if (!matches?.length) return;
  for (const m of matches) _sink(renderInterceptWarning(m));
}
