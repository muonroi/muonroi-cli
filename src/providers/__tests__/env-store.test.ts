import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  // readLines() returning [] on ANY read error made persistEnvVar rebuild the
  // store from nothing: set one key and every other key in the file is gone.
  // A directory at the store path is a portable non-ENOENT read failure; the
  // real ones are a locked file or bad permissions.
  it("refuses to write when the store exists but cannot be read, instead of dropping the other keys", () => {
    mkdirSync(envFilePath(), { recursive: true });

    expect(() => persistEnvVar("TEST_KEY_A", "value-a-1234567890")).toThrow(/cannot read/);
  });

  // Boot must survive it, but must not pretend the store was empty.
  it("boots without the stored keys when the store is unreadable, and says so", () => {
    mkdirSync(envFilePath(), { recursive: true });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));

    expect(() => loadEnvFileIntoProcess()).not.toThrow();
    expect(errors.join("\n")).toMatch(/cannot read/);

    spy.mockRestore();
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
