import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The suite pin (vitest-setup.ts); user files live under MUONROI_CLI_HOME, not under HOME.
const PINNED_CLI_HOME = process.env.MUONROI_CLI_HOME;

describe("UserSettings.webResearchPrompted", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-settings-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  let saveUserSettings: typeof import("../settings.js").saveUserSettings;
  let loadUserSettings: typeof import("../settings.js").loadUserSettings;

  beforeEach(async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.MUONROI_CLI_HOME = path.join(tmpHome, ".muonroi-cli");
    // Reset module cache so settings.ts re-evaluates USER_DIR with new env
    vi.resetModules();
    const mod = await import("../settings.js");
    saveUserSettings = mod.saveUserSettings;
    loadUserSettings = mod.loadUserSettings;
    // Ensure no stale settings file from any previous run
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    if (fs.existsSync(settingsPath)) fs.rmSync(settingsPath, { force: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (PINNED_CLI_HOME === undefined) delete process.env.MUONROI_CLI_HOME;
    else process.env.MUONROI_CLI_HOME = PINNED_CLI_HOME;
  });

  it("persists webResearchPrompted=true through save/load", () => {
    saveUserSettings({ webResearchPrompted: true });
    const loaded = loadUserSettings();
    expect(loaded.webResearchPrompted).toBe(true);
  });

  it("returns undefined when never set", () => {
    const loaded = loadUserSettings();
    expect(loaded.webResearchPrompted).toBeUndefined();
  });
});
