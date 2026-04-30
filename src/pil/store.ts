/**
 * src/pil/store.ts
 *
 * Module-level last-result store for the /optimize command.
 * Single-threaded per session — no zustand needed.
 */

import type { PipelineContext } from './types.js';

let _last: PipelineContext | null = null;

export function setPilLastResult(ctx: PipelineContext): void {
  _last = ctx;
}

export function getPilLastResult(): PipelineContext | null {
  return _last;
}
