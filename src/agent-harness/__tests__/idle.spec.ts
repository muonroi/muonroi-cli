import { createHeuristicIdleDetector, createIdleDetector } from "@muonroi/agent-harness-core/idle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("idle detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createIdleDetector", () => {
    it("emits idle after quiescence window", () => {
      const events: string[] = [];
      const det = createIdleDetector({
        quiescenceMs: 50,
        onIdle: () => events.push("idle"),
      });
      det.markActivity();
      vi.advanceTimersByTime(30);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(30);
      expect(events).toEqual(["idle"]);
      det.dispose();
    });

    it("re-arms on subsequent activity", () => {
      const events: string[] = [];
      const det = createIdleDetector({
        quiescenceMs: 50,
        onIdle: () => events.push("idle"),
      });
      det.markActivity();
      vi.advanceTimersByTime(60);
      det.markActivity();
      vi.advanceTimersByTime(60);
      expect(events).toEqual(["idle", "idle"]);
      det.dispose();
    });
  });

  describe("createHeuristicIdleDetector", () => {
    it("emits idle when BOTH frame and stream have been silent for their windows", () => {
      const events: string[] = [];
      const det = createHeuristicIdleDetector({
        frameQuietMs: 50,
        streamQuietMs: 50,
        onIdle: () => events.push("idle"),
      });
      det.markFrame();
      det.markStreamDelta();
      vi.advanceTimersByTime(60);
      expect(events).toEqual(["idle"]);
      det.dispose();
    });

    it("does NOT emit idle when only frame is quiet but stream is recent", () => {
      const events: string[] = [];
      const det = createHeuristicIdleDetector({
        frameQuietMs: 50,
        streamQuietMs: 50,
        onIdle: () => events.push("idle"),
      });
      det.markFrame();
      vi.advanceTimersByTime(30);
      det.markStreamDelta();
      vi.advanceTimersByTime(40);
      // frame has been quiet 70ms, stream only 40ms
      expect(events).toEqual([]);
      det.dispose();
    });

    it("does NOT emit idle when only stream is quiet but frame is recent", () => {
      const events: string[] = [];
      const det = createHeuristicIdleDetector({
        frameQuietMs: 50,
        streamQuietMs: 50,
        onIdle: () => events.push("idle"),
      });
      det.markStreamDelta();
      vi.advanceTimersByTime(30);
      det.markFrame();
      vi.advanceTimersByTime(40);
      // stream has been quiet 70ms, frame only 40ms
      expect(events).toEqual([]);
      det.dispose();
    });
  });
});
