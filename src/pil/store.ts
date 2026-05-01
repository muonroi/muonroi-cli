/**
 * src/pil/store.ts
 *
 * Module-level last-result store for the /optimize command.
 * Single-threaded per session — no zustand needed.
 */

import type { PipelineContext } from "./types.js";

export type OutputMode = "structured" | "text-fallback" | "conversational";

let _last: PipelineContext | null = null;
let _lastOutputMode: OutputMode = "conversational";

export function setPilLastResult(ctx: PipelineContext): void {
  _last = ctx;
}

export function getPilLastResult(): PipelineContext | null {
  return _last;
}

export function setLastOutputMode(mode: OutputMode): void {
  _lastOutputMode = mode;
}

export function getLastOutputMode(): OutputMode {
  return _lastOutputMode;
}
