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
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OAuthMcpServer, startOAuthMcpServer } from "../../src/mcp/__tests__/fixtures/oauth-mcp-server.js";
import { spawnHarness } from "./helpers.js";

const SERVER_ID = "oauthfx";

describe("MCP OAuth sign-in E2E", () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let srv: OAuthMcpServer;
  let cliHome: string;

  beforeAll(async () => {
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
    const ctx = await spawnHarness({
      cwd: home,
      fixturesDir: resolve("tests/harness/fixtures/llm-mcp-oauth"),
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      env: { MUONROI_CLI_HOME: cliHome, MUONROI_MCP_OAUTH_NO_BROWSER: "1" },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ idle: true, timeoutMs: 20_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 120_000);

  afterAll(async () => {
    proc?.kill();
    cleanup?.();
    await srv?.close();
  });

  it("signs in from /mcp (ctrl+o) and the stored token authenticates a non-interactive connect", async () => {
    driver.type("/");
    await driver.wait_for({ selector: "id=slash-menu", timeoutMs: 5_000 });
    driver.type("m");
    driver.type("c");
    driver.type("p");
    await driver.wait_for({ idle: true, timeoutMs: 3_000 });
    driver.press("Enter");
    await driver.wait_for({ selector: "id=mcp-modal", timeoutMs: 10_000 });

    for (let i = 0; i < 10 && !driver.query(`id=mcp-${SERVER_ID}`)?.selected; i++) {
      driver.press("Down");
      await driver.wait_for({ idle: true, timeoutMs: 2_000 });
    }
    expect(driver.query(`id=mcp-${SERVER_ID}`)?.selected).toBe(true);

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

    driver.press("Escape");
    await driver.wait_for({ idle: true, timeoutMs: 5_000 });

    const unauthBeforeTurn = srv.stats.mcpUnauthorized;
    driver.type("list the worker capabilities");
    driver.press("Enter");
    await driver.wait_for({ selector: 'role=listitem name~="Capabilities listed"', timeoutMs: 60_000 });

    // tools/list reached the server WITH a valid bearer, and no 401 happened
    // after sign-in (pre-fix: every non-interactive connect 401'd).
    expect(srv.stats.authedMethods).toContain("tools/list");
    expect(srv.stats.mcpUnauthorized).toBe(unauthBeforeTurn);
  }, 150_000);
});
