import { describe, expect, it, vi } from "vitest";
import {
  evaluateLspSetupNudge,
  LSP_SETUP_SNOOZE_SESSIONS,
  type LspSetupState,
  type MaybeOfferLspDeps,
  maybeOfferLspSetup,
} from "../lsp-setup-onboarding.js";

describe("evaluateLspSetupNudge", () => {
  it("shows for a fresh install (no state at all)", () => {
    expect(evaluateLspSetupNudge({})).toEqual({ show: true });
  });

  it("never shows once configured", () => {
    expect(evaluateLspSetupNudge({ lspSetup: { configuredAt: "2026-07-18T00:00:00Z" } })).toEqual({ show: false });
  });

  it("decrements an active snooze and re-surfaces after N sessions", () => {
    // Simulate the session-by-session loop: snooze of N hides N sessions, shows on N+1.
    let lspSetup: LspSetupState = { snoozeRemaining: 2 };
    const d1 = evaluateLspSetupNudge({ lspSetup });
    expect(d1.show).toBe(false);
    lspSetup = d1.nextLspSetup!;
    const d2 = evaluateLspSetupNudge({ lspSetup });
    expect(d2.show).toBe(false);
    lspSetup = d2.nextLspSetup!;
    expect(lspSetup.snoozeRemaining).toBe(0);
    const d3 = evaluateLspSetupNudge({ lspSetup });
    expect(d3.show).toBe(true);
  });

  it("exports the snooze length the card copy promises", () => {
    expect(LSP_SETUP_SNOOZE_SESSIONS).toBeGreaterThan(0);
  });
});

function makeDeps(overrides: Partial<MaybeOfferLspDeps> = {}): MaybeOfferLspDeps & { publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn();
  return {
    isEnabled: () => true,
    loadSettings: () => ({}),
    saveLspSetup: vi.fn(),
    probeCovered: async () => ({ covered: false }),
    publish,
    ...overrides,
  } as MaybeOfferLspDeps & { publish: ReturnType<typeof vi.fn> };
}

describe("maybeOfferLspSetup", () => {
  it("publishes when never configured, unsnoozed, and the project isn't covered", async () => {
    const deps = makeDeps();
    await expect(maybeOfferLspSetup(deps)).resolves.toBe(true);
    expect(deps.publish).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the feature flag is off", async () => {
    const deps = makeDeps({ isEnabled: () => false });
    await expect(maybeOfferLspSetup(deps)).resolves.toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("does nothing once setup was completed", async () => {
    const deps = makeDeps({ loadSettings: () => ({ lspSetup: { configuredAt: "2026-07-18T00:00:00Z" } }) });
    await expect(maybeOfferLspSetup(deps)).resolves.toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("consumes one snooze session and stays quiet while snoozed", async () => {
    const saveLspSetup = vi.fn();
    const deps = makeDeps({ loadSettings: () => ({ lspSetup: { snoozeRemaining: 2 } }), saveLspSetup });
    await expect(maybeOfferLspSetup(deps)).resolves.toBe(false);
    expect(saveLspSetup).toHaveBeenCalledWith({ snoozeRemaining: 1 });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("stays quiet when the detected project languages are already covered", async () => {
    const deps = makeDeps({ probeCovered: async () => ({ covered: true }) });
    await expect(maybeOfferLspSetup(deps)).resolves.toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("never throws — a broken dep resolves false", async () => {
    const deps = makeDeps({
      probeCovered: async () => {
        throw new Error("boom");
      },
    });
    await expect(maybeOfferLspSetup(deps)).resolves.toBe(false);
  });
});
