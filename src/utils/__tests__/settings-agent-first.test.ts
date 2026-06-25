import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("UserSettings.agentFirst", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-agentfirst-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  let saveUserSettings: typeof import("../settings.js").saveUserSettings;
  let loadUserSettings: typeof import("../settings.js").loadUserSettings;

  beforeEach(async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    const mod = await import("../settings.js");
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

  it("persists agentFirst, maxToolRounds, hardMaxToolRounds, maxLlmCallsPerTurn", () => {
    saveUserSettings({
      agentFirst: true,
      maxToolRounds: 150,
      hardMaxToolRounds: 250,
      maxLlmCallsPerTurn: 80,
    });
    const loaded = loadUserSettings();
    expect(loaded.agentFirst).toBe(true);
    expect(loaded.maxToolRounds).toBe(150);
    expect(loaded.hardMaxToolRounds).toBe(250);
    expect(loaded.maxLlmCallsPerTurn).toBe(80);
  });
});
