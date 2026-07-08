/**
 * visual-capture.ts — read OpenTUI's ACTUAL rendered cell grid.
 *
 * The semantic harness (reconciler-hook) reports STRUCTURE (id/role/name/props)
 * but is blind to what a human SEES — colors, bold/italic, alignment, blank
 * rows, mojibake. This module snapshots the ground-truth render buffer instead:
 * OpenTUI's `CliRenderer.currentRenderBuffer` is a cell grid it already paints,
 * and `OptimizedBuffer.getSpanLines()` returns per-cell char + RGBA fg/bg +
 * attribute bits (verified against @opentui/core@0.1.107 buffer.d.ts:43 +
 * lib/RGBA.d.ts). No OCR — the buffer is authoritative and in-process.
 *
 * Consumers get a `VisualFrame` (protocol) they can query per-cell, render to
 * annotated text, or (P2) rasterize to PNG for a vision model.
 */

import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type VisualFrame,
  type VisualLine,
  type VisualSpan,
} from "@muonroi/agent-harness-core/protocol";

// Structural (duck-typed) views of the OpenTUI surface we read. Kept local
// rather than importing @opentui/core types so this module stays unit-testable
// without the native renderer and tolerant of minor version drift.
interface RgbaLike {
  toInts?: () => [number, number, number, number];
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}
interface CapturedSpanLike {
  text: string;
  fg: RgbaLike;
  bg: RgbaLike;
  attributes: number;
  width: number;
}
interface CapturedLineLike {
  spans: CapturedSpanLike[];
}
interface OptimizedBufferLike {
  width: number;
  height: number;
  getSpanLines: () => CapturedLineLike[];
}
export interface RendererLike {
  currentRenderBuffer?: OptimizedBufferLike;
  nextRenderBuffer?: OptimizedBufferLike;
}

/** Low byte of OpenTUI's TextAttributes (ATTRIBUTE_BASE_MASK = 255). */
const ATTR_MASK = 255;

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Convert an OpenTUI RGBA to a "#rrggbb" (or "#rrggbbaa" when translucent) hex
 * string. Prefers `toInts()` (0-255 ints); falls back to component getters,
 * scaling 0-1 floats up to 0-255 when the renderer exposes normalized channels.
 */
function toHex(c: RgbaLike | undefined): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  if (c && typeof c.toInts === "function") {
    const ints = c.toInts();
    r = ints[0];
    g = ints[1];
    b = ints[2];
    a = ints[3];
  } else if (c) {
    const scale = (v: number | undefined): number => (v === undefined ? 0 : v <= 1 ? v * 255 : v);
    r = scale(c.r);
    g = scale(c.g);
    b = scale(c.b);
    a = c.a === undefined ? 255 : c.a <= 1 ? c.a * 255 : c.a;
  }
  const h = (n: number): string => clampByte(n).toString(16).padStart(2, "0");
  return a < 255 ? `#${h(r)}${h(g)}${h(b)}${h(a)}` : `#${h(r)}${h(g)}${h(b)}`;
}

export interface VisualCaptureHook {
  /** Build a VisualFrame from the renderer's current buffer. Returns null when
   *  no renderer is attached, the buffer is unreadable, or content is unchanged
   *  (content-hash dedup — same contract as the semantic reconciler hook). */
  capture(seq: number, ts: number): VisualFrame | null;
  /** Reset dedup state so the next capture always emits. */
  resetDedup(): void;
}

/**
 * Create a visual-capture hook. `getRenderer` is a late-bound accessor because
 * the OpenTUI renderer is constructed AFTER the agent-mode runtime (which owns
 * this hook) — see src/index.ts attachRenderer wiring.
 */
export function createVisualCaptureHook(getRenderer: () => RendererLike | undefined): VisualCaptureHook {
  let lastHash: string | undefined;

  function capture(seq: number, ts: number): VisualFrame | null {
    const renderer = getRenderer();
    const buffer = renderer?.currentRenderBuffer ?? renderer?.nextRenderBuffer;
    if (!buffer || typeof buffer.getSpanLines !== "function") return null;

    let captured: CapturedLineLike[];
    try {
      captured = buffer.getSpanLines();
    } catch (err) {
      // getSpanLines allocates + decodes native Zig memory; a mid-resize/destroy
      // race can throw. Skip this frame (the next tick retries). Debug-gated log
      // only — unconditional logging here would spam the render loop.
      if (process.env.MUONROI_DEBUG_VISUAL) {
        console.error(`[visual-capture] getSpanLines failed: ${(err as Error)?.message}`);
      }
      return null;
    }

    const lines: VisualLine[] = captured.map((ln) => ({
      spans: (ln.spans ?? []).map(
        (s): VisualSpan => ({
          text: s.text,
          fg: toHex(s.fg),
          bg: toHex(s.bg),
          attrs: (s.attributes ?? 0) & ATTR_MASK,
          width: s.width,
        }),
      ),
    }));

    const hash = createHash("sha1").update(JSON.stringify(lines)).digest("hex");
    if (lastHash === hash) return null;
    lastHash = hash;

    return {
      mode: "visual",
      version: PROTOCOL_VERSION,
      seq,
      ts,
      cols: buffer.width,
      rows: buffer.height,
      cursor: null,
      lines,
    };
  }

  function resetDedup(): void {
    lastHash = undefined;
  }

  return { capture, resetDedup };
}
