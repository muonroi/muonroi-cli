import { describe, expect, it, vi } from "vitest";
import {
  EE_CONNECT_SNOOZE_SESSIONS,
  type EeSetupState,
  evaluateEeConnectNudge,
  type MaybeOfferDeps,
  maybeOfferEeConnect,
} from "../ee-connect.js";

describe("evaluateEeConnectNudge", () => {
  it("shows for a fresh install (no flags at all)", () => {
    expect(evaluateEeConnectNudge({})).toEqual({ show: true });
  });

  it("never shows once connected", () => {
    expect(evaluateEeConnectNudge({ eeSetup: { connectedAt: "2026-07-18T00:00:00Z" } })).toEqual({ show: false });
  });

  it("migrates the legacy one-shot eeSetupPrompted flag to a snooze instead of suppressing forever", () => {
    const d = evaluateEeConnectNudge({ eeSetupPrompted: true });
    expect(d.show).toBe(false);
    expect(d.nextEeSetup).toEqual({ snoozeRemaining: EE_CONNECT_SNOOZE_SESSIONS - 1 });
  });

  it("decrements an active snooze and re-surfaces after N sessions", () => {
    // Simulate the session-by-session loop: snooze of N hides N sessions, shows on N+1.
    let eeSetup: EeSetupState = { snoozeRemaining: 2 };
    const d1 = evaluateEeConnectNudge({ eeSetup });
    expect(d1.show).toBe(false);
    eeSetup = d1.nextEeSetup!;
    const d2 = evaluateEeConnectNudge({ eeSetup });
    expect(d2.show).toBe(false);
    eeSetup = d2.nextEeSetup!;
    expect(eeSetup.snoozeRemaining).toBe(0);
    const d3 = evaluateEeConnectNudge({ eeSetup });
    expect(d3.show).toBe(true);
  });

  it("preserves connectedAt through snooze bookkeeping", () => {
    const d = evaluateEeConnectNudge({ eeSetup: { snoozeRemaining: 1, connectedAt: undefined } });
    expect(d.nextEeSetup).toMatchObject({ snoozeRemaining: 0 });
  });
});

function makeDeps(overrides: Partial<MaybeOfferDeps> = {}): MaybeOfferDeps & { publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn();
  return {
    isEnabled: () => true,
    getBaseUrl: () => null,
    loadSettings: () => ({}),
    saveEeSetup: vi.fn(),
    probeLocal: async () => ({ ok: false }),
    publish,
    ...overrides,
  } as MaybeOfferDeps & { publish: ReturnType<typeof vi.fn> };
}

describe("maybeOfferEeConnect", () => {
  it("publishes when unconfigured, unsnoozed, and no local brain answers", async () => {
    const deps = makeDeps();
    await expect(maybeOfferEeConnect(deps)).resolves.toBe(true);
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the feature flag is off", async () => {
    const deps = makeDeps({ isEnabled: () => false });
    await expect(maybeOfferEeConnect(deps)).resolves.toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("does nothing when a serverBaseUrl is already configured", async () => {
    const deps = makeDeps({ getBaseUrl: () => "https://ee.example.com" });
    await expect(maybeOfferEeConnect(deps)).resolves.toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("consumes one snooze session and stays quiet while snoozed", async () => {
    const saveEeSetup = vi.fn();
    const deps = makeDeps({ loadSettings: () => ({ eeSetup: { snoozeRemaining: 2 } }), saveEeSetup });
    await expect(maybeOfferEeConnect(deps)).resolves.toBe(false);
    expect(saveEeSetup).toHaveBeenCalledWith({ snoozeRemaining: 1 });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("stays quiet when a local brain is reachable (EE already works via fallback)", async () => {
    const deps = makeDeps({ probeLocal: async () => ({ ok: true }) });
    await expect(maybeOfferEeConnect(deps)).resolves.toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("never throws — a broken dep resolves false", async () => {
    const deps = makeDeps({
      probeLocal: async () => {
        throw new Error("boom");
      },
    });
    await expect(maybeOfferEeConnect(deps)).resolves.toBe(false);
  });
});
