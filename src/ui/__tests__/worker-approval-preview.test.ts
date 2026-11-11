import { describe, expect, it, vi } from "vitest";
import type { ScrollBoxRenderable } from "@opentui/core";
import { pageWorkerApprovalPreview } from "../modals/wallet-picker-modal.js";

describe("worker approval local input inspection", () => {
  it("owns repeated paging and Home/End using the local resolved viewport", () => {
    let top = 60;
    const local = {
      viewport: { height: 7 },
      scrollHeight: 75,
      scrollBy: vi.fn((delta: number) => {
        top = Math.max(0, Math.min(68, top + delta));
      }),
      scrollTo: vi.fn((value: number) => {
        top = Math.max(0, Math.min(68, value));
      }),
    };
    const key = (name: string) => ({ name, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    const prior = process.env.MUONROI_SCROLL_LOCK;
    process.env.MUONROI_SCROLL_LOCK = "0";
    try {
      for (let i = 0; i < 3; i++) {
        const event = key("pageup");
        expect(pageWorkerApprovalPreview(event, local as unknown as ScrollBoxRenderable)).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
      }
      expect(top).toBe(42);
      local.viewport.height = 4;
      pageWorkerApprovalPreview(key("pagedown"), local as unknown as ScrollBoxRenderable);
      expect(top).toBe(45);
      pageWorkerApprovalPreview(key("home"), local as unknown as ScrollBoxRenderable);
      expect(top).toBe(0);
      pageWorkerApprovalPreview(key("end"), local as unknown as ScrollBoxRenderable);
      expect(top).toBe(68);
      expect(local.scrollBy.mock.calls.map((call) => call[0])).toEqual([-6, -6, -6, 3]);
    } finally {
      if (prior === undefined) delete process.env.MUONROI_SCROLL_LOCK;
      else process.env.MUONROI_SCROLL_LOCK = prior;
    }
  });

  it("leaves selection, confirm and denial keys to their exact existing handlers", () => {
    for (const name of ["up", "down", "return", "escape", "a"]) {
      const key = { name, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      expect(pageWorkerApprovalPreview(key, null)).toBe(false);
      expect(key.preventDefault).not.toHaveBeenCalled();
      expect(key.stopPropagation).not.toHaveBeenCalled();
    }
  });
});
