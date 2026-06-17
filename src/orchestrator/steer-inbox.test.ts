import { describe, expect, it } from "vitest";
import { planSteerInjection, type SteerInjectionState } from "./steer-inbox.js";

describe("planSteerInjection", () => {
  // A valid baseline: feature enabled, not cancelled, one queued message.
  const base = (over: Partial<SteerInjectionState> = {}): SteerInjectionState => ({
    drained: [{ text: "also add tests" }],
    aborted: false,
    enabled: true,
    ...over,
  });

  it("maps drained text into a single user ModelMessage", () => {
    const out = planSteerInjection(base());
    expect(out).toEqual([{ role: "user", content: "also add tests" }]);
  });

  it("preserves FIFO order across multiple drained messages", () => {
    const out = planSteerInjection(base({ drained: [{ text: "a" }, { text: "b" }] }));
    expect(out.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("returns [] when the feature is disabled", () => {
    expect(planSteerInjection(base({ enabled: false }))).toEqual([]);
  });

  it("returns [] over a genuine user cancel (never steer an aborted turn)", () => {
    expect(planSteerInjection(base({ aborted: true }))).toEqual([]);
  });

  it("returns [] when nothing was drained", () => {
    expect(planSteerInjection(base({ drained: [] }))).toEqual([]);
  });

  it("skips empty / whitespace-only messages and trims the rest", () => {
    const out = planSteerInjection(base({ drained: [{ text: "  " }, { text: "  keep me  " }, { text: "" }] }));
    expect(out).toEqual([{ role: "user", content: "keep me" }]);
  });
});
