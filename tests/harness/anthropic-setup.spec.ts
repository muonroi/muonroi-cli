import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { spawnHarness } from "./helpers.js";

const KEY = ["synthetic", "fresh", "user", "api", "key"].join("-");
const WORKSPACE = "wrkspc_freshUserFixture";

async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= end) throw new Error("Credential setup did not complete");
    await delay(25);
  }
}

describe("fresh-user provider setup", { retry: 0 }, () => {
  it.each(["workspace", "scoped", "cancel", "other"])("completes %s setup", async (mode) => {
    const home = mkdtempSync(join(tmpdir(), "muonroi-fresh-setup-"));
    const envFile = join(home, ".env");
    const settingsFile = join(home, ".muonroi-cli/user-settings.json");
    const ctx = await spawnHarness({
      cwd: home,
      env: {
        NODE_ENV: "test",
        MUONROI_ENV_FILE: envFile,
        MUONROI_AUTH_DIR: join(home, "auth"),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        XAI_API_KEY: "",
        ZAI_API_KEY: "",
        STEPFUN_API_KEY: "",
        OPENCODE_GO_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
      },
    });
    ctx.proc.stdout?.resume();
    const { driver } = ctx;
    let stage = "boot";
    try {
      await driver.wait_for({ selector: "id=composer", timeoutMs: 20_000 });
      await driver.wait_for({ event: "input-ready", timeoutMs: 20_000 });
      driver.type("/");
      await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 10_000 });
      driver.type("providers");
      stage = "typed command";
      await until(() => driver.queryAll("role=listitem").some((n) => n.name === "/providers" && n.selected === true));
      driver.press("Enter");
      const provider = mode === "other" ? "deepseek" : "anthropic";
      await driver.wait_for({ selector: `id=provider-chip-${provider}`, timeoutMs: 20_000 });
      const chips = driver.queryAll("role=button").filter((n) => n.id.startsWith("provider-chip-"));
      const index = chips.findIndex((n) => n.id === `provider-chip-${provider}`);
      expect(index).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < index; i++) {
        driver.press("Down");
        await delay(100);
      }
      await delay(100);
      driver.press(mode === "workspace" || mode === "cancel" ? "Enter" : "k");
      stage = "key dialog";
      await driver.wait_for({ selector: "id=provider-key-input", timeoutMs: 10_000 });
      driver.type(KEY);
      await until(() => driver.query("id=provider-key-input")?.value === KEY);
      driver.press("Enter");
      stage = "scope dialog";
      if (mode !== "other") {
        await driver.wait_for({ selector: "id=provider-key-scope", timeoutMs: 5000 });
        // Key persistence must wait for the rest of the setup.
        expect(existsSync(envFile)).toBe(false);
        if (mode === "scoped") {
          driver.press("Up");
          await delay(100);
          driver.press("Enter");
        } else {
          driver.press("Enter");
          await driver.wait_for({ selector: "id=provider-workspace-input", timeoutMs: 5000 });
          if (mode === "cancel") {
            driver.press("Escape");
            await until(() => driver.query("id=provider-key-prompt") === null);
            expect(existsSync(envFile)).toBe(false);
            const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
            expect(settings.providers?.anthropic?.workspaceId).toBeUndefined();
            return;
          }
          driver.press("Enter");
          await driver.wait_for({ selector: "id=provider-setup-error", timeoutMs: 5000 });
          expect(existsSync(envFile)).toBe(false);
          driver.type("invalid");
          await delay(100);
          driver.press("Enter");
          await until(() => driver.query("id=provider-setup-error")?.name?.includes("wrkspc_") === true);
          expect(existsSync(envFile)).toBe(false);
          for (let i = 0; i < "invalid".length; i++) driver.press("Backspace");
          await delay(100);
          driver.type(WORKSPACE);
          await until(() => driver.query("id=provider-workspace-input")?.value === WORKSPACE);
          driver.press("Enter");
        }
      }
      await until(() => driver.query("id=provider-key-prompt") === null);
      expect(readFileSync(envFile, "utf8")).toContain(`${provider.toUpperCase()}_API_KEY=${KEY}`);
      const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
      expect(settings.providers?.anthropic?.workspaceId).toBe(mode === "workspace" ? WORKSPACE : undefined);
      expect(driver.query(`id=provider-chip-${provider}`)?.disabled).not.toBe(true);
      // The freshly configured provider can be selected without restarting.
      if (mode !== "workspace") driver.press("Enter");
      await until(() => {
        try {
          return JSON.parse(readFileSync(settingsFile, "utf8")).defaultProvider === provider;
        } catch (err) {
          console.error(
            `[fresh-setup] waiting for default provider settings: ${err instanceof Error ? err.message : String(err)}`,
          );
          if ((err as NodeJS.ErrnoException).code === "EBUSY") return false;
          throw err;
        }
      });
      expect(driver.query(`id=provider-chip-${provider}`)?.selected).toBe(true);
      expect(JSON.parse(readFileSync(settingsFile, "utf8")).defaultProvider).toBe(provider);
      expect(ctx.proc.exitCode).toBeNull();
    } catch (err) {
      console.error(
        `[fresh-setup] ${stage}: ${err instanceof Error ? err.message : String(err)}; nodes=${driver
          .queryAll("role=textbox")
          .map((n) => n.id)
          .join(",")}; chips=${driver
          .queryAll("role=button")
          .map((n) => n.id)
          .filter((id) => id.startsWith("provider-chip-"))
          .join(",")}`,
      );
      throw err;
    } finally {
      if (ctx.proc.exitCode === null && ctx.proc.signalCode === null) {
        const closed = new Promise<void>((resolve) => ctx.proc.once("close", () => resolve()));
        ctx.proc.kill();
        await closed;
      }
      ctx.cleanup();
      bestEffortRemoveSync(home, "anthropic-setup.spec.ts");
    }
  }, 60_000);
});
