import { describe, expect, it, vi } from "vitest";
import { createVisualCaptureHook, type RendererLike } from "../src/visual-capture.js";

function fakeRenderer(isDestroyed: boolean) {
  const getSpanLines = vi.fn(() => [
    {
      spans: [
        {
          text: "hi",
          fg: { toInts: () => [255, 255, 255, 255] },
          bg: { toInts: () => [0, 0, 0, 255] },
          attributes: 0,
          width: 2,
        },
      ],
    },
  ]);
  const renderer = {
    isDestroyed,
    currentRenderBuffer: { width: 2, height: 1, getSpanLines },
  } as unknown as RendererLike;
  return { renderer, getSpanLines };
}

describe("createVisualCaptureHook", () => {
  it("captures from a live renderer", () => {
    const { renderer, getSpanLines } = fakeRenderer(false);
    const hook = createVisualCaptureHook(() => renderer);
    expect(hook.capture(0, 0)).not.toBeNull();
    expect(getSpanLines).toHaveBeenCalledTimes(1);
  });

  it("never touches the native buffer of a destroyed renderer (use-after-free segfault on /exit)", () => {
    const { renderer, getSpanLines } = fakeRenderer(true);
    const hook = createVisualCaptureHook(() => renderer);
    expect(hook.capture(0, 0)).toBeNull();
    expect(getSpanLines).not.toHaveBeenCalled();
  });
});
