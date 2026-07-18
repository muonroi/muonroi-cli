import { afterEach, describe, expect, it, vi } from "vitest";
import { publishLspSetup, resetLspSetupAnnouncements, subscribeLspSetup } from "../lsp-setup-bus.js";

afterEach(() => {
  resetLspSetupAnnouncements();
});

describe("lsp-setup bus", () => {
  it("delivers a publish to a mounted subscriber", () => {
    const seen = vi.fn();
    const unsub = subscribeLspSetup(seen);
    publishLspSetup();
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("dedupes per session — repeat publishes are no-ops", () => {
    const seen = vi.fn();
    const unsub = subscribeLspSetup(seen);
    publishLspSetup();
    publishLspSetup();
    publishLspSetup();
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("buffers a publish that happens before the UI mounts (boot ordering)", () => {
    publishLspSetup();
    const seen = vi.fn();
    const unsub = subscribeLspSetup(seen);
    expect(seen).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("resetLspSetupAnnouncements allows a later re-announce (/lsp setup path)", () => {
    const seen = vi.fn();
    const unsub = subscribeLspSetup(seen);
    publishLspSetup();
    resetLspSetupAnnouncements();
    publishLspSetup();
    expect(seen).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("unsubscribed listeners stop receiving", () => {
    const seen = vi.fn();
    const unsub = subscribeLspSetup(seen);
    unsub();
    publishLspSetup();
    expect(seen).not.toHaveBeenCalled();
  });
});
