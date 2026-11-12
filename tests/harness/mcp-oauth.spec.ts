/**
 * mcp-oauth.spec.ts — drive the real TUI through an MCP OAuth sign-in against a
 * local OAuth-protected MCP server (src/mcp/__tests__/fixtures/oauth-mcp-server.ts),
 * then prove the TUI process uses the stored token on a connect that cannot
 * prompt.
 *
 * Flow: /mcp → select the server → ctrl+o → (MUONROI_MCP_OAUTH_NO_BROWSER=1)
 * the toast shows the authorization URL → the spec plays the browser by
 * following /authorize's redirect to the TUI's loopback callback → "signed in"
 * toast → a mock-LLM turn calls worker_capabilities, which connects WITHOUT an
 * interactive OAuth handler (the path that used to send no Authorization header,
 * user debug.log: 401 "No authorization provided") → the fixture sees tools/list
 * with a valid bearer and the capability is listed.
 *
 * The authenticated tools/CALL + refresh/rotation/invalid_grant behaviour is
 * covered in-process by src/mcp/__tests__/oauth-flow.spec.ts against the same
 * fixture; this spec covers the TUI wiring (modal key, toast UX, callback server
 * lifetime, store location under MUONROI_CLI_HOME, pool auth-pause lift).
 *
 * Synchronisation rule (CI runs 43173666474 and 43000599014): after Escape,
 * `wait_for({ idle })` is NOT a postcondition — it resolved with the /mcp modal
 * still in the latest frame in 17 of 20 measured closes. Keys typed in that gap
 * went into the modal's search box and Enter toggled the highlighted server off,
 * so no turn ever started. Every step below therefore gates on what the TUI
 * reports (modal gone, composer focused, composer mirror == typed text), and
 * each attempt gets its OWN fixture server + TUI so vitest retries are independent.
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OAuthMcpServer, startOAuthMcpServer } from "../../src/mcp/__tests__/fixtures/oauth-mcp-server.js";
import { type HarnessContext, spawnHarness } from "./helpers.js";

const SERVER_ID = "oauthfx";

/** Poll `cond` until it holds; the error names what never happened and the screen at that moment. */
async function until(driver: Driver, what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}\n${driver.render_text()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const composerValue = (driver: Driver): string => driver.query("id=composer")?.value ?? "";

/** Type into the composer and wait until the TUI's own mirror shows `expected` (default: the typed text). */
async function typeIntoComposer(driver: Driver, text: string, expected = text): Promise<void> {
  driver.type(text);
  await until(driver, `composer to show ${JSON.stringify(expected)}`, () => composerValue(driver) === expected);
}

describe("MCP OAuth sign-in E2E", () => {
  let ctx: HarnessContext;
  let proc: ChildProcess;
  let driver: Driver;
  let srv: OAuthMcpServer;
  let cliHome: string;

  beforeEach(async () => {
    srv = await startOAuthMcpServer();
    const home = mkdtempSync(join(tmpdir(), "muonroi-mcp-oauth-e2e-"));
    cliHome = join(home, ".muonroi-cli");
    mkdirSync(cliHome, { recursive: true });
    writeFileSync(
      join(cliHome, "user-settings.json"),
      JSON.stringify({
        mcp: {
          servers: [{ id: SERVER_ID, label: "OAuth Fixture", enabled: true, transport: "http", url: srv.mcpUrl }],
        },
      }),
    );
    ctx = await spawnHarness({
      cwd: home,
      fixturesDir: resolve("tests/harness/fixtures/llm-mcp-oauth"),
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      env: { MUONROI_CLI_HOME: cliHome, MUONROI_MCP_OAUTH_NO_BROWSER: "1" },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    await driver.wait_for({ idle: true, timeoutMs: 20_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 120_000);

  afterEach(async () => {
    proc?.kill();
    ctx?.cleanup();
    await srv?.close();
  });

  /** /mcp → modal open with the fixture row highlighted. */
  async function openMcpModalOnFixtureRow(): Promise<void> {
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    await typeIntoComposer(driver, "mcp", "/mcp");
    driver.press("Enter");
    await driver.wait_for({ selector: "id=mcp-modal", timeoutMs: 10_000 });

    for (let i = 0; i < 10 && !driver.query(`id=mcp-${SERVER_ID}`)?.selected; i++) {
      driver.press("Down");
      await driver.wait_for({ idle: true, timeoutMs: 2_000 });
    }
    expect(driver.query(`id=mcp-${SERVER_ID}`)?.selected).toBe(true);
  }

  /** Escape, then wait until the modal is really gone and the composer owns the keyboard again. */
  async function closeMcpModal(): Promise<void> {
    driver.press("Escape");
    await until(driver, "the /mcp modal to close and the composer to regain focus", () => {
      return !driver.query("id=mcp-modal") && driver.query("role=textbox")?.focus === true;
    });
  }

  it("signs in from /mcp (ctrl+o) and the stored token authenticates a non-interactive connect", async () => {
    await openMcpModalOnFixtureRow();

    driver.press("C-o");
    try {
      await driver.wait_for({ selector: 'role=toast name~="open this URL to sign in"', timeoutMs: 15_000 });
    } catch (e) {
      // registrations=0 here means ctrl+o never reached signInMcpOAuth.
      throw new Error(`${(e as Error).message}; fixture stats=${JSON.stringify(srv.stats)}\n${driver.render_text()}`);
    }
    const toast = driver.query("role=toast")?.name ?? "";
    const authUrl = toast.match(/https?:\/\/\S+/)?.[0];
    expect(authUrl, `toast: ${toast}`).toBeTruthy();
    const parsed = new URL(authUrl!);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBeTruthy();

    // Play the browser: /authorize → 302 → the TUI's loopback callback.
    expect(await srv.approve(authUrl!)).toBe(200);
    await driver.wait_for({ selector: 'role=toast name~="signed in"', timeoutMs: 15_000 });

    const store = JSON.parse(readFileSync(join(cliHome, "mcp-oauth.json"), "utf8"));
    expect(store[SERVER_ID]?.tokens?.access_token).toBeTruthy();
    expect(srv.stats.codeGrants).toBe(1);

    await closeMcpModal();

    const unauthBeforeTurn = srv.stats.mcpUnauthorized;
    await typeIntoComposer(driver, "list the worker capabilities");
    driver.press("Enter");
    try {
      await driver.wait_for({ selector: 'role=listitem name~="Capabilities listed"', timeoutMs: 60_000 });
    } catch (e) {
      const saved = JSON.parse(readFileSync(join(cliHome, "user-settings.json"), "utf8"));
      throw new Error(
        `${(e as Error).message}; fixture stats=${JSON.stringify(srv.stats)}; saved server=${JSON.stringify(saved.mcp?.servers)}\n${driver.render_text()}`,
      );
    }

    // tools/list reached the server WITH a valid bearer, and no 401 happened
    // after sign-in (pre-fix: every non-interactive connect 401'd).
    expect(srv.stats.authedMethods).toContain("tools/list");
    expect(srv.stats.mcpUnauthorized).toBe(unauthBeforeTurn);
  }, 150_000);

  it("keys queued behind Escape in the same input chunk never reach the closed /mcp modal", async () => {
    await openMcpModalOnFixtureRow();

    // One transport write = one stdin chunk in the child: Escape and the keys behind it run
    // against the same handleKey closure, before React re-renders (live-state.ts header).
    // Pre-fix the modal still looked open to the later keys: "x" went into its search box
    // and Enter toggled the highlighted saved server off in user-settings.json.
    ctx.pressBurst(["Escape", "x", "Enter"]);
    await until(driver, "the /mcp modal to close and the composer to regain focus", () => {
      return !driver.query("id=mcp-modal") && driver.query("role=textbox")?.focus === true;
    });

    await driver.wait_for({ idle: true, timeoutMs: 5_000 });
    const saved = JSON.parse(readFileSync(join(cliHome, "user-settings.json"), "utf8"));
    expect(saved.mcp.servers.find((s: { id: string }) => s.id === SERVER_ID)?.enabled).toBe(true);
  }, 60_000);
});
