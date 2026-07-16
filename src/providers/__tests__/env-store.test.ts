import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearEnvVar, envFilePath, loadEnvFileIntoProcess, persistEnvVar } from "../env-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envstore-"));
  process.env.MUONROI_ENV_FILE = join(dir, ".env");
  delete process.env.TEST_KEY_A;
  delete process.env.TEST_KEY_B;
});
afterEach(() => {
  delete process.env.MUONROI_ENV_FILE;
  delete process.env.TEST_KEY_A;
  delete process.env.TEST_KEY_B;
  rmSync(dir, { recursive: true, force: true });
});

describe("env-store", () => {
  it("persists a var to file and process.env", () => {
    persistEnvVar("TEST_KEY_A", "value-a-1234567890");
    expect(process.env.TEST_KEY_A).toBe("value-a-1234567890");
    expect(readFileSync(envFilePath(), "utf8")).toContain("TEST_KEY_A=value-a-1234567890");
  });

  it("upserts (replaces) an existing var without duplicating lines", () => {
    persistEnvVar("TEST_KEY_A", "first-1234567890");
    persistEnvVar("TEST_KEY_A", "second-1234567890");
    const body = readFileSync(envFilePath(), "utf8");
    expect(body.match(/TEST_KEY_A=/g)?.length).toBe(1);
    expect(process.env.TEST_KEY_A).toBe("second-1234567890");
  });

  it("clearEnvVar removes from file and process.env", () => {
    persistEnvVar("TEST_KEY_A", "value-a-1234567890");
    clearEnvVar("TEST_KEY_A");
    expect(process.env.TEST_KEY_A).toBeUndefined();
    expect(readFileSync(envFilePath(), "utf8")).not.toContain("TEST_KEY_A");
  });

  it("loadEnvFileIntoProcess fills gaps but never overrides a real OS env var", () => {
    persistEnvVar("TEST_KEY_A", "file-a-1234567890");
    persistEnvVar("TEST_KEY_B", "file-b-1234567890");
    delete process.env.TEST_KEY_A; // simulate not-yet-loaded
    process.env.TEST_KEY_B = "os-wins-1234567890"; // real OS value present at launch
    loadEnvFileIntoProcess();
    expect(process.env.TEST_KEY_A).toBe("file-a-1234567890"); // gap filled
    expect(process.env.TEST_KEY_B).toBe("os-wins-1234567890"); // OS not overridden
  });
});
