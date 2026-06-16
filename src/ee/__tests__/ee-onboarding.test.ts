import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExperienceConfig, writeExperienceConfig } from "../auth.js";

describe("writeExperienceConfig", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ee-cfg-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const read = (): ExperienceConfig => JSON.parse(readFileSync(join(home, ".experience", "config.json"), "utf8"));

  it("creates ~/.experience/config.json (and dir) when none exists", async () => {
    await writeExperienceConfig({ serverBaseUrl: "https://ee.example.com", serverAuthToken: "tok" }, { home });
    const cfg = read();
    expect(cfg.serverBaseUrl).toBe("https://ee.example.com");
    expect(cfg.serverAuthToken).toBe("tok");
  });

  it("merges into an existing config, preserving unrelated fields", async () => {
    // Seed an existing config with an unrelated field (as the EE installer would).
    await writeExperienceConfig({ embeddingModelVersion: "v9", serverAuthToken: "old" }, { home });
    // Now write a new serverBaseUrl + token — embeddingModelVersion must survive.
    await writeExperienceConfig({ serverBaseUrl: "https://ee2.example.com", serverAuthToken: "new" }, { home });
    const cfg = read();
    expect(cfg.embeddingModelVersion).toBe("v9"); // preserved
    expect(cfg.serverBaseUrl).toBe("https://ee2.example.com"); // added
    expect(cfg.serverAuthToken).toBe("new"); // overwritten
  });
});
