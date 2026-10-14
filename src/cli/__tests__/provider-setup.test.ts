import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../__test-stubs__/cleanup.js";

const KEY = ["synthetic", "interactive", "setup", "key"].join("-");
const ID = "wrkspc_cliSetupFixture";

describe("CLI interactive credential setup", () => {
  it.each(["workspace", "scoped", "other", "cancel"])("keys set completes %s flow", async (mode) => {
    const home = mkdtempSync(join(tmpdir(), "muonroi-keys-setup-"));
    const envFile = join(home, ".env");
    const settingsFile = join(home, ".muonroi-cli/user-settings.json");
    if (mode === "scoped") {
      mkdirSync(join(home, ".muonroi-cli"), { recursive: true });
      writeFileSync(
        settingsFile,
        JSON.stringify({
          providers: {
            anthropic: { workspaceId: "wrkspc_stale", baseURL: "https://example.test/v1" },
            xai: { baseURL: "https://other.test" },
          },
        }),
      );
    }
    const provider = mode === "other" ? "deepseek" : "anthropic";
    const entry = process.env.MUONROI_SETUP_TEST_ENTRY ?? resolve("src/index.ts");
    const child = spawn(entry.endsWith(".js") ? "node" : "bun", [entry, "keys", "set", provider], {
      cwd: home,
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: home,
        USERPROFILE: home,
        MUONROI_ENV_FILE: envFile,
        MUONROI_AUTH_DIR: join(home, "auth"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d.toString();
    });
    child.stderr.on("data", (d) => {
      output += d.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const waitFor = async (text: string, after = 0) => {
      const end = Date.now() + 15_000;
      while (!output.slice(after).includes(text)) {
        if (Date.now() >= end || child.exitCode !== null) throw new Error(`CLI did not ask for ${text}: ${output}`);
        await delay(20);
      }
    };
    try {
      await waitFor("API key (hidden)");
      child.stdin.write(`${KEY}\n`);
      if (mode !== "other") {
        await waitFor("Key scope:");
        expect(existsSync(envFile)).toBe(false);
        child.stdin.write(mode === "scoped" ? "1\n" : "2\n");
        if (mode !== "scoped") {
          await waitFor("Workspace ID:");
          if (mode === "cancel") {
            child.stdin.write(Buffer.from([3]));
            expect(await exited).toBe(130);
            expect(existsSync(envFile)).toBe(false);
            return;
          }
          const after = output.length;
          child.stdin.write("\n");
          await waitFor("Workspace ID is required", after);
          expect(existsSync(envFile)).toBe(false);
          child.stdin.write(`${ID}\n`);
        }
      }
      await waitFor(`Configured ${provider}`);
      const exitDeadline = Date.now() + 5000;
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() >= exitDeadline) throw new Error("Setup saved credentials but the CLI did not exit");
        await delay(20);
      }
      expect(await exited).toBe(0);
      expect(output).toContain(`Configured ${provider}`);
      expect(readFileSync(envFile, "utf8")).toContain(`${provider.toUpperCase()}_API_KEY=${KEY}`);
      const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
      expect(settings.providers?.anthropic?.workspaceId).toBe(mode === "workspace" ? ID : undefined);
      if (mode === "scoped") {
        expect(settings.providers.anthropic.baseURL).toBe("https://example.test/v1");
        expect(settings.providers.xai.baseURL).toBe("https://other.test");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      bestEffortRemoveSync(home, "provider-setup.test.ts");
    }
  }, 45_000);
});
