import { afterEach, describe, expect, it, vi } from "vitest";
import type { MissingKeyServer } from "../key-requirements";
import { publishNeedsKey, resetNeedsKeyAnnouncements, subscribeNeedsKey } from "../needs-key-bus";

const tavily: MissingKeyServer = {
  id: "tavily",
  label: "Tavily Search",
  envVar: "TAVILY_API_KEY",
  setupHint: "Add a key via /mcp.",
  nativeFallback: "web_search",
};

afterEach(() => {
  resetNeedsKeyAnnouncements();
});

describe("needs-key bus", () => {
  it("delivers a published server to a mounted subscriber", () => {
    const seen = vi.fn();
    const unsub = subscribeNeedsKey(seen);
    publishNeedsKey([tavily]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([tavily]);
    unsub();
  });

  it("dedupes per server per session — re-publishing every turn is a no-op", () => {
    const seen = vi.fn();
    const unsub = subscribeNeedsKey(seen);
    publishNeedsKey([tavily]);
    publishNeedsKey([tavily]);
    publishNeedsKey([tavily]);
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("buffers publishes that happen before the UI mounts (warmup ordering)", () => {
    publishNeedsKey([tavily]);
    const seen = vi.fn();
    const unsub = subscribeNeedsKey(seen);
    expect(seen).toHaveBeenCalledWith([tavily]);
    unsub();
  });

  it("resetNeedsKeyAnnouncements(id) allows a later re-announce for that server only", () => {
    const seen = vi.fn();
    const unsub = subscribeNeedsKey(seen);
    publishNeedsKey([tavily]);
    resetNeedsKeyAnnouncements("tavily");
    publishNeedsKey([tavily]);
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("unsubscribed listeners stop receiving", () => {
    const seen = vi.fn();
    const unsub = subscribeNeedsKey(seen);
    unsub();
    publishNeedsKey([tavily]);
    expect(seen).not.toHaveBeenCalled();
  });
});
