/**
 * Tests for getRoleModel's catalog-staleness guard.
 *
 * A role model persisted before a catalog rename/drop (e.g. "grok-build-0.1"
 * after it was dropped in favor of grok-composer-2.5-fast) must NOT leak a dead
 * id to resolveModelRuntime, which throws "not found in catalog — cannot
 * determine provider" and takes down the council speaker bound to that role
 * (observed: Experience Auditor on the research role). getRoleModel drops
 * unresolved ids so the caller falls back to its own default.
 *
 * Strategy: temp HOME + vi.resetModules() for a clean settings file, same
 * pattern as settings-disabled-models.test.ts. The catalog is loaded so
 * MODELS.length > 0 and the guard actually validates.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getRoleModel catalog-staleness guard", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-role-model-${process.pid}-${Date.now()}`);
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  let getRoleModel: typeof import("../settings.js").getRoleModel;
  let saveUserSettings: typeof import("../settings.js").saveUserSettings;

  beforeEach(async () => {
    fs.mkdirSync(tmpHome, { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    const registry = await import("../../models/registry.js");
    await registry.loadCatalog();
    const mod = await import("../settings.js");
    getRoleModel = mod.getRoleModel;
    saveUserSettings = mod.saveUserSettings;
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

  it("returns undefined for a role model that is not in the catalog", () => {
    saveUserSettings({ roleModels: { research: "retired-model-xyz" } });
    expect(getRoleModel("research")).toBeUndefined();
  });

  it("returns the canonical id for a valid role model", () => {
    saveUserSettings({ roleModels: { research: "deepseek-v4-flash" } });
    expect(getRoleModel("research")).toBe("deepseek-v4-flash");
  });

  it("normalizes a dropped id via its successor alias (grok-build-0.1)", () => {
    // grok-build-0.1 is aliased to grok-composer-2.5-fast in the catalog, so the
    // stale config now resolves instead of crashing.
    saveUserSettings({ roleModels: { research: "grok-build-0.1" } });
    expect(getRoleModel("research")).toBe("grok-composer-2.5-fast");
  });

  it("returns undefined when the role is unset", () => {
    saveUserSettings({ roleModels: { leader: "deepseek-v4-flash" } });
    expect(getRoleModel("research")).toBeUndefined();
  });
});
