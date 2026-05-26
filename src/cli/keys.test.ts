import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runKeysCleanupSettings", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-keys-"));
    await fs.mkdir(path.join(tmpHome, ".muonroi-cli"), { recursive: true });
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    vi.restoreAllMocks();
  });

  it("strips top-level apiKey and providers.*.apiKey, drops empty provider blocks", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          apiKey: "sk-leaked-top",
          defaultModel: "deepseek-v4-flash",
          providers: {
            deepseek: { apiKey: "sk-leaked-ds" },
            anthropic: { apiKey: "sk-leaked-an", baseURL: "https://example" },
          },
          mcp: { servers: [] },
        },
        null,
        2,
      ),
    );

    const { runKeysCleanupSettings } = await import("./keys.js");
    // Capture stdout — runKeysCleanupSettings writes the backup path which we don't want in test output.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runKeysCleanupSettings();
    logSpy.mockRestore();

    const cleaned = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(cleaned.apiKey).toBeUndefined();
    expect(cleaned.providers?.deepseek).toBeUndefined(); // empty block dropped
    expect(cleaned.providers?.anthropic?.apiKey).toBeUndefined();
    expect(cleaned.providers?.anthropic?.baseURL).toBe("https://example");
    expect(cleaned.defaultModel).toBe("deepseek-v4-flash");
    expect(cleaned.mcp).toBeDefined();

    // A backup with timestamp suffix should exist.
    const dirEntries = await fs.readdir(path.join(tmpHome, ".muonroi-cli"));
    expect(dirEntries.some((f) => f.startsWith("user-settings.json.bak."))).toBe(true);
  });

  it("drops the providers map entirely when all provider blocks become empty", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        defaultModel: "x",
        providers: {
          deepseek: { apiKey: "sk-1234567890123456789012" },
          anthropic: { apiKey: "sk-ant-1234567890123456789012" },
        },
      }),
    );

    const { runKeysCleanupSettings } = await import("./keys.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runKeysCleanupSettings();
    logSpy.mockRestore();

    const cleaned = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(cleaned.providers).toBeUndefined();
    expect(cleaned.defaultModel).toBe("x");
  });

  it("is a no-op if the settings file is already clean", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    const original = { defaultModel: "y", roleModels: { leader: "y" } };
    await fs.writeFile(settingsPath, JSON.stringify(original));

    const { runKeysCleanupSettings } = await import("./keys.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runKeysCleanupSettings();
    logSpy.mockRestore();

    const cleaned = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(cleaned).toEqual(original);
  });
});
