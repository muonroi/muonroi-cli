import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup.js";
import { getModelInfo, loadCatalog } from "../../src/models/registry.js";
import { spawnHarness } from "./helpers.js";

async function until(check: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

describe("OpenAI OAuth completes the provider selection intent", { retry: 0 }, () => {
  beforeAll(async () => {
    await loadCatalog();
  });
  it.each([
    { action: "Enter", disabled: false, select: "" },
    { action: "o", disabled: false, select: "" },
    { action: "cancel", disabled: false, select: "" },
    { action: "Enter", disabled: true, select: "" },
    { action: "o", disabled: true, select: "Enter" },
    { action: "o", disabled: true, select: "d" },
  ])("$action disabled=$disabled then $select honors selection", async ({ action, disabled, select }) => {
    const home = mkdtempSync(join(tmpdir(), "muonroi-oauth-selection-"));
    if (disabled) {
      mkdirSync(join(home, ".muonroi-cli"), { recursive: true });
      writeFileSync(
        join(home, ".muonroi-cli/user-settings.json"),
        JSON.stringify({ disabledProviders: ["openai", "xai"] }),
      );
    }
    const ctx = await spawnHarness({
      entry: resolve("tests/harness/fixtures/openai-oauth-entry.ts"),
      cwd: home,
      env: {
        OPENAI_API_KEY: "",
        MUONROI_CLI_HOME: home,
        MUONROI_AUTH_DIR: join(home, "auth"),
        MUONROI_ENV_FILE: join(home, ".env"),
        MUONROI_OAUTH_FIXTURE_CANCEL: action === "cancel" ? "1" : "0",
      },
    });
    ctx.proc.stdout?.resume();
    const { driver } = ctx;
    try {
      await driver.wait_for({ selector: "id=composer", timeoutMs: 20_000 });
      await driver.wait_for({ event: "input-ready", timeoutMs: 20_000 });
      driver.type("/providers");
      driver.press("Enter");
      await driver.wait_for({ selector: "id=provider-chip-openai", timeoutMs: 20_000 });
      const chips = driver.queryAll("role=button").filter((node) => node.id.startsWith("provider-chip-"));
      const index = chips.findIndex((node) => node.id === "provider-chip-openai");
      expect(index).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < index; i++) {
        driver.press("Down");
        // Navigation changes paint styling, not the semantic tree/sequence.
        // Yield to React's commit before the next key uses the chip index.
        await delay(100);
      }
      driver.press(action === "cancel" ? "Enter" : action);
      if (action === "cancel") {
        await driver.wait_for({ selector: "id=provider-oauth-login", timeoutMs: 15_000 });
        driver.press("Escape");
        await until(() => driver.query("id=provider-oauth-login") === null, "cancelled sign-in");
        expect(existsSync(join(home, "auth/openai.json"))).toBe(false);
        const settingsPath = join(home, ".muonroi-cli/user-settings.json");
        const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
        expect(settings.defaultProvider).not.toBe("openai");
        return;
      }
      await until(() => existsSync(join(home, "auth/openai.json")), "token persistence");
      expect(JSON.parse(readFileSync(join(home, "auth/openai.json"), "utf8")).accessToken).toBe("fixture-access");
      await until(
        () =>
          driver.query("id=provider-oauth-login") === null &&
          driver.query("id=provider-chip-openai")?.disabled !== true,
        "authenticated picker",
      );
      await driver.wait_for({ selector: "id=toast", timeoutMs: 15_000 });
      expect(driver.query("id=toast")?.name).toContain("Signed in to OpenAI (ChatGPT)");
      if (action === "o" && disabled) {
        const saved = JSON.parse(readFileSync(join(home, ".muonroi-cli/user-settings.json"), "utf8"));
        expect(saved.defaultProvider).not.toBe("openai");
        expect(saved.disabledProviders).toContain("openai");
        expect(driver.query("id=provider-chip-openai")?.selected).not.toBe(true);
        driver.press(select);
      }
      if (action === "Enter" || select) {
        await until(
          () => driver.query("id=provider-chip-openai")?.selected === true,
          "enabled provider after explicit selection",
          2000,
        );
        const settings = JSON.parse(readFileSync(join(home, ".muonroi-cli/user-settings.json"), "utf8"));
        expect(settings.defaultProvider).toBe("openai");
        expect(getModelInfo(settings.defaultModel)?.provider).toBe("openai");
        expect(settings.disabledProviders ?? []).not.toContain("openai");
        if (disabled) expect(settings.disabledProviders).toContain("xai");
      } else {
        let settings: { defaultProvider?: string } = {};
        const settingsPath = join(home, ".muonroi-cli/user-settings.json");
        if (existsSync(settingsPath)) settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(settings.defaultProvider).not.toBe("openai");
      }
      expect(ctx.proc.exitCode).toBeNull();
    } finally {
      const closed = new Promise<void>((resolve) => ctx.proc.once("close", () => resolve()));
      ctx.proc.kill();
      await closed;
      ctx.cleanup();
      bestEffortRemoveSync(home, "openai-oauth-selection.spec.ts");
    }
  }, 60_000);
});
