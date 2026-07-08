/**
 * visual-capture.spec.ts
 *
 * P0 of Harness TUI v2: proves the harness can snapshot the ACTUAL rendered
 * cell grid (chars + real fg/bg colors + attributes) from OpenTUI's render
 * buffer — not just the semantic tree. No OCR: the buffer is authoritative.
 *
 * Verifies the full pipeline: TUI-side visual-capture.ts reads
 * renderer.currentRenderBuffer.getSpanLines() → emits a `mode:"visual"` frame on
 * the sidechannel → driver ingests it → snapshot_visual()/render_visual()/
 * visual_cell() expose it.
 */

import type { VisualFrame } from "@muonroi/agent-harness-core/protocol";
import { describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

describe("visual-capture E2E", () => {
  it("snapshots the real rendered cell grid with colors", async () => {
    const ctx = await spawnHarness({});
    try {
      await ctx.driver.wait_for({ idle: true, timeoutMs: 15_000 });
      // Mount guard: ensure the tree has painted at least once.
      await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });

      // Type into the composer so the grid has non-trivial content to render.
      ctx.driver.type("hello visual world");
      // Poll briefly for the visual frame — it rides the next semantic change.
      let vf: VisualFrame | null = null;
      for (let i = 0; i < 40 && !vf; i++) {
        vf = ctx.driver.snapshot_visual();
        if (!vf) await new Promise((r) => setTimeout(r, 100));
      }

      expect(vf, "a VisualFrame should be emitted once the renderer is attached").not.toBeNull();
      const frame = vf as VisualFrame;
      expect(frame.mode).toBe("visual");
      expect(frame.cols).toBeGreaterThan(0);
      expect(frame.rows).toBeGreaterThan(0);
      expect(frame.lines.length).toBeGreaterThan(0);

      // Every span must carry a valid hex color + integer attrs + width.
      const spans = frame.lines.flatMap((l) => l.spans);
      expect(spans.length).toBeGreaterThan(0);
      for (const s of spans.slice(0, 50)) {
        expect(s.fg, `fg not hex: ${s.fg}`).toMatch(HEX);
        expect(s.bg, `bg not hex: ${s.bg}`).toMatch(HEX);
        expect(Number.isInteger(s.attrs)).toBe(true);
      }

      // render_visual() must reflect the real characters on screen.
      const text = ctx.driver.render_visual();
      expect(text).not.toBe("(no visual frame)");
      expect(text).toContain("hello visual world");

      // visual_cell() decodes an individual painted cell.
      const firstNonBlank = frame.lines
        .flatMap((l, row) => l.spans.map((s) => ({ row, text: s.text })))
        .find((x) => x.text.trim().length > 0);
      if (firstNonBlank) {
        const cell = ctx.driver.visual_cell(firstNonBlank.row, 0);
        // Column 0 may be a leading space; just assert the decoder returns a typed cell or null cleanly.
        if (cell) {
          expect(cell.fg).toMatch(HEX);
          expect(cell.bg).toMatch(HEX);
        }
      }
    } finally {
      ctx.cleanup();
    }
  }, 30_000);
});
