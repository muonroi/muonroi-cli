/**
 * Tests for per-model disable helpers added in Phase 19.
 *
 * Strategy: uses a temp HOME directory and vi.resetModules() to get a fresh
 * module instance with a clean settings file — same pattern as settings-web-research.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("disabledModels settings helpers", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-disabled-models-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  let getDisabledModels: typeof import("../settings.js").getDisabledModels;
  let isModelDisabled: typeof import("../settings.js").isModelDisabled;
  let setModelDisabled: typeof import("../settings.js").setModelDisabled;
  let saveUserSettings: typeof import("../settings.js").saveUserSettings;
  let loadUserSettings: typeof import("../settings.js").loadUserSettings;

  beforeEach(async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    const mod = await import("../settings.js");
    getDisabledModels = mod.getDisabledModels;
    isModelDisabled = mod.isModelDisabled;
    setModelDisabled = mod.setModelDisabled;
    saveUserSettings = mod.saveUserSettings;
    loadUserSettings = mod.loadUserSettings;
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    if (fs.existsSync(settingsPath)) fs.rmSync(settingsPath, { force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  // ── getDisabledModels ────────────────────────────────────────────────────────

  it("getDisabledModels returns [] when field is missing", () => {
    expect(getDisabledModels()).toEqual([]);
  });

  it("getDisabledModels round-trips through save/load", () => {
    saveUserSettings({ disabledModels: ["gpt-4o-mini", "claude-haiku-4-5"] });
    expect(getDisabledModels()).toEqual(["gpt-4o-mini", "claude-haiku-4-5"]);
  });

  // ── isModelDisabled — list check ─────────────────────────────────────────────

  it("isModelDisabled returns false when model is not in the list", () => {
    saveUserSettings({ disabledModels: [], disabledProviders: [] });
    expect(isModelDisabled("gpt-4o")).toBe(false);
  });

  it("isModelDisabled returns true when model id is in disabledModels", () => {
    saveUserSettings({ disabledModels: ["gpt-4o-mini"], disabledProviders: [] });
    expect(isModelDisabled("gpt-4o-mini")).toBe(true);
  });

  it("isModelDisabled returns false for an unlisted model", () => {
    saveUserSettings({ disabledModels: ["some-other-model"], disabledProviders: [] });
    expect(isModelDisabled("gpt-4o")).toBe(false);
  });

  // ── setModelDisabled ─────────────────────────────────────────────────────────

  it("setModelDisabled adds model to list when disabled=true", () => {
    const result = setModelDisabled("gpt-4o-mini", true);
    expect(result).toContain("gpt-4o-mini");
    // Persisted
    expect(getDisabledModels()).toContain("gpt-4o-mini");
  });

  it("setModelDisabled removes model from list when disabled=false", () => {
    saveUserSettings({ disabledModels: ["gpt-4o-mini", "claude-haiku-4-5"] });
    const result = setModelDisabled("gpt-4o-mini", false);
    expect(result).not.toContain("gpt-4o-mini");
    expect(result).toContain("claude-haiku-4-5");
    expect(loadUserSettings().disabledModels).toEqual(["claude-haiku-4-5"]);
  });

  it("setModelDisabled is idempotent when disabling an already-disabled model", () => {
    saveUserSettings({ disabledModels: ["gpt-4o-mini"] });
    const result = setModelDisabled("gpt-4o-mini", true);
    expect(result).toEqual(["gpt-4o-mini"]); // still exactly one entry
  });

  it("setModelDisabled is idempotent when enabling an already-enabled model", () => {
    saveUserSettings({ disabledModels: [] });
    const result = setModelDisabled("gpt-4o-mini", false);
    expect(result).toEqual([]);
  });

  // ── round-trip integration ───────────────────────────────────────────────────

  it("disabled model can be re-enabled via setModelDisabled", () => {
    setModelDisabled("gpt-4o-mini", true);
    expect(isModelDisabled("gpt-4o-mini")).toBe(true);

    setModelDisabled("gpt-4o-mini", false);
    expect(isModelDisabled("gpt-4o-mini")).toBe(false);
  });
});
