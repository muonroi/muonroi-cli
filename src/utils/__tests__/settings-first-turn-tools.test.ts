// Round 2 (G2 MEDIUM scope): `isFirstTurnToolsEnabledByProject()` is the
// predicate tool-engine.ts's `selectRawToolSet` uses (via
// `firstTurnToolsEnabled`) to decide whether the FIRST turn of a session
// gets the full tool set — explicit opt-in via `.muonroi-cli/settings.json`
// `firstTurnTools: true`, not the mere presence of an instructions file.
// Mirrors settings-model-pin.test.ts's pattern for the sibling predicate
// `isModelPinnedByProject`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFirstTurnToolsEnabledByProject } from "../settings.js";

describe("isFirstTurnToolsEnabledByProject", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-first-turn-tools-"));
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("is false when there is no .muonroi-cli/settings.json (default: unchanged behaviour)", () => {
    process.chdir(dir);
    expect(isFirstTurnToolsEnabledByProject()).toBe(false);
  });

  it("is false when the project settings file exists but omits firstTurnTools", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ model: "step-5-preview" }));
    process.chdir(dir);
    expect(isFirstTurnToolsEnabledByProject()).toBe(false);
  });

  it("is false when firstTurnTools is explicitly false", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ firstTurnTools: false }));
    process.chdir(dir);
    expect(isFirstTurnToolsEnabledByProject()).toBe(false);
  });

  it("is false for a truthy-but-not-boolean-true value (strict === true, not merely truthy)", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ firstTurnTools: "true" }));
    process.chdir(dir);
    expect(isFirstTurnToolsEnabledByProject()).toBe(false);
  });

  it("is true when the project settings file explicitly opts in", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ firstTurnTools: true }));
    process.chdir(dir);
    expect(isFirstTurnToolsEnabledByProject()).toBe(true);
  });

  it("having ONLY an AGENTS.md/CLAUDE.md file (no settings.json opt-in) is NOT enough — the presence of instructions no longer implies this", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "project instructions with no settings.json at all");
    process.chdir(dir);
    expect(isFirstTurnToolsEnabledByProject()).toBe(false);
  });
});
