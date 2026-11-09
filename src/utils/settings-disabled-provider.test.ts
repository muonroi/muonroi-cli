/**
 * Startup crash regression: `Error: No eligible enabled text/tool model for
 * provider "<p>"` from selectOrchestratorModel (new Agent).
 *
 * Trigger (measured): user-settings `defaultModel` names a model of a provider
 * the user ALSO disabled (`disabledProviders`). getCurrentModel() returned it
 * verbatim, Agent detected the disabled provider, and selectOrchestratorModel
 * found zero enabled models. A repo whose `.muonroi-cli/settings.json` pins
 * `model` masked it, so the crash looked cwd-dependent (a repo without the pin,
 * e.g. muonroi-building-block, crashed).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCatalog, MODELS } from "../models/registry.js";
import { selectOrchestratorModel } from "../orchestrator/orchestration-policy.js";
import { detectProviderForModel } from "../providers/runtime.js";
import { getCatalogDefaultModel, getCurrentModel } from "./settings.js";

let home: string;
let bbCwd: string;
const saved: Record<string, string | undefined> = {};

function providersWithTextModels(): string[] {
  const ids: string[] = [];
  for (const m of MODELS) if (m.provider && !ids.includes(m.provider)) ids.push(m.provider);
  return ids;
}

function writeUserSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(path.join(home, ".muonroi-cli"), { recursive: true });
  fs.writeFileSync(path.join(home, ".muonroi-cli", "user-settings.json"), JSON.stringify(settings));
}

/** Pick two distinct catalog providers whose Agent construction is possible. */
function pickProviders(): { enabled: string; culprit: string; culpritModel: string } {
  const eligible = providersWithTextModels().filter((p) => {
    try {
      selectOrchestratorModel(p);
      return true;
    } catch {
      return false;
    }
  });
  expect(eligible.length).toBeGreaterThanOrEqual(2);
  const [enabled, culprit] = eligible as [string, string];
  const culpritModel = MODELS.find((m) => m.provider === culprit)!.id;
  return { enabled, culprit, culpritModel };
}

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  for (const k of ["HOME", "USERPROFILE", "MUONROI_MODEL"]) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.MUONROI_MODEL;
  // muonroi-building-block shape: Directory.Build.props + *.sln + src/Muonroi.*, no .muonroi-cli/.
  bbCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mcli-bb-"));
  fs.writeFileSync(path.join(bbCwd, "Directory.Build.props"), "<Project />");
  fs.writeFileSync(path.join(bbCwd, "Muonroi.BuildingBlock.sln"), "");
  fs.mkdirSync(path.join(bbCwd, "src", "Muonroi.Core"), { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(bbCwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bbCwd, { recursive: true, force: true });
});

describe("getCurrentModel never resolves to a disabled provider", () => {
  it("BB-shaped cwd: defaultModel on a disabled provider falls through to the enabled default provider", () => {
    const { enabled, culprit, culpritModel } = pickProviders();
    writeUserSettings({ defaultProvider: enabled, defaultModel: culpritModel, disabledProviders: [culprit] });

    const model = getCurrentModel("agent");

    expect(detectProviderForModel(model)).toBe(enabled);
    // The exact call that crashed startup (Agent ctor, orchestrator.ts).
    expect(() => selectOrchestratorModel(detectProviderForModel(model))).not.toThrow();
  });

  it("a project `model` pin on a disabled provider is skipped, not honoured", () => {
    const { enabled, culprit, culpritModel } = pickProviders();
    writeUserSettings({ defaultProvider: enabled, disabledProviders: [culprit] });
    fs.mkdirSync(path.join(bbCwd, ".muonroi-cli"));
    fs.writeFileSync(path.join(bbCwd, ".muonroi-cli", "settings.json"), JSON.stringify({ model: culpritModel }));

    expect(detectProviderForModel(getCurrentModel("agent"))).toBe(enabled);
  });

  it("MUONROI_MODEL and modeModels on a disabled provider are skipped", () => {
    const { enabled, culprit, culpritModel } = pickProviders();
    writeUserSettings({
      defaultProvider: enabled,
      disabledProviders: [culprit],
      modeModels: { agent: culpritModel },
    });
    process.env.MUONROI_MODEL = culpritModel;

    expect(detectProviderForModel(getCurrentModel("agent"))).toBe(enabled);
  });

  it("a model-level disable (disabledModels) is skipped too", () => {
    const { enabled, culpritModel } = pickProviders();
    writeUserSettings({ defaultProvider: enabled, defaultModel: culpritModel, disabledModels: [culpritModel] });

    expect(getCurrentModel("agent")).not.toBe(culpritModel);
  });

  it("an enabled configured model is still honoured", () => {
    const { enabled, culprit } = pickProviders();
    const wanted = MODELS.find((m) => m.provider === enabled)!.id;
    writeUserSettings({ defaultProvider: enabled, defaultModel: wanted, disabledProviders: [culprit] });

    expect(getCurrentModel("agent")).toBe(wanted);
  });
});

describe("getCatalogDefaultModel", () => {
  it("skips a disabled default provider and lands on an enabled one", () => {
    const { enabled, culprit } = pickProviders();
    writeUserSettings({ defaultProvider: culprit, disabledProviders: [culprit] });

    const model = getCatalogDefaultModel();

    expect(detectProviderForModel(model)).not.toBe(culprit);
    expect(() => selectOrchestratorModel(detectProviderForModel(model))).not.toThrow();
    expect(enabled).toBeTruthy();
  });

  it("throws a clear error when every provider is disabled (no silent hardcoded fallback)", () => {
    writeUserSettings({ disabledProviders: providersWithTextModels() });

    expect(() => getCatalogDefaultModel()).toThrow(/No text-capable models/);
  });
});
