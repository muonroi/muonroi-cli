import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJSON } from "./atomic-io.js";
import { loadConfig } from "./config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("Test 5: bootstraps default config when ~/.muonroi-cli/config.json absent", async () => {
    const config = await loadConfig(tmpDir);
    expect(config.cap.monthly_usd).toBe(15);
    // File must be written now
    const raw = await fs.readFile(path.join(tmpDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.cap.monthly_usd).toBe(15);
  });

  it("Test 6: respects user-provided cap.monthly_usd value", async () => {
    await atomicWriteJSON(path.join(tmpDir, "config.json"), { cap: { monthly_usd: 30 } });
    const config = await loadConfig(tmpDir);
    expect(config.cap.monthly_usd).toBe(30);
  });
});
