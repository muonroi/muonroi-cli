// Gap (d): `isModelPinnedByProject()` is the predicate message-processor.ts
// uses to skip per-turn downgrade routing for the MAIN conversation turn —
// see message-processor-model-pin-routing.test.ts for the routing-skip
// behavior itself. This file covers the predicate in isolation.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isModelPinnedByProject } from "../settings.js";

describe("isModelPinnedByProject", () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-model-pin-"));
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("is false when there is no .muonroi-cli/settings.json", () => {
    process.chdir(dir);
    expect(isModelPinnedByProject()).toBe(false);
  });

  it("is false when the project settings file exists but omits model", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ autoCommit: false }));
    process.chdir(dir);
    expect(isModelPinnedByProject()).toBe(false);
  });

  it("is false for an empty-string model (not a real pin)", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ model: "   " }));
    process.chdir(dir);
    expect(isModelPinnedByProject()).toBe(false);
  });

  it("is true when the project settings file pins a model", () => {
    fs.mkdirSync(path.join(dir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".muonroi-cli", "settings.json"), JSON.stringify({ model: "step-5-preview" }));
    process.chdir(dir);
    expect(isModelPinnedByProject()).toBe(true);
  });
});
