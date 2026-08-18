import { afterEach, describe, expect, it, vi } from "vitest";
import { publishEeConnect, resetEeConnectAnnouncements, subscribeEeConnect } from "../ee-connect-bus.js";

afterEach(() => {
  resetEeConnectAnnouncements();
});

describe("ee-connect bus", () => {
  it("delivers a publish to a mounted subscriber", () => {
    const seen = vi.fn();
    const unsub = subscribeEeConnect(seen);
    publishEeConnect();
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("dedupes per session — repeat publishes are no-ops", () => {
    const seen = vi.fn();
    const unsub = subscribeEeConnect(seen);
    publishEeConnect();
    publishEeConnect();
    publishEeConnect();
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("buffers a publish that happens before the UI mounts (boot ordering)", () => {
    publishEeConnect();
    const seen = vi.fn();
    const unsub = subscribeEeConnect(seen);
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("resetEeConnectAnnouncements allows a later re-announce (/ee setup path)", () => {
    const seen = vi.fn();
    const unsub = subscribeEeConnect(seen);
    publishEeConnect();
    resetEeConnectAnnouncements();
    publishEeConnect();
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("unsubscribed listeners stop receiving", () => {
    const seen = vi.fn();
    const unsub = subscribeEeConnect(seen);
    unsub();
    publishEeConnect();
    expect(seen).not.toHaveBeenCalled();
  });
});
