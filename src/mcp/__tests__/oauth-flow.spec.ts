/**
 * End-to-end MCP OAuth against a real local authorization + MCP server
 * (fixtures/oauth-mcp-server.ts): discovery (RFC 9728/8414), DCR (RFC 7591),
 * authorization code + PKCE S256 + state, bearer on every request, refresh
 * with rotation, invalid_grant fallback, and single-flight refresh.
 *
 * Regressions pinned here (reproduced against the pre-fix code, 2026-11-06):
 *  - a signed-in server was connected WITHOUT its token by every caller that
 *    passed no `onOAuthRequired` (warm-up, council, worker_capabilities, and
 *    the post-sign-in warm-up itself) -> 401 "No authorization provided",
 *    the exact line in the user's ~/.muonroi-cli/debug.log for stealthgpt;
 *  - an expired access token was "refreshed" with a brand-new DCR client
 *    (the redirect-port check in clientInformation()), so the refresh grant
 *    failed (refreshFailures=1, refreshGrants=0) and a browser tab opened.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import { __resetMcpClientPoolForTests, acquireMcpTools, closeAllMcpClients } from "../client-pool.js";
import { __resetMcpOAuthForTests, getMcpOAuthSession, McpOAuthSession, mcpOAuthStorePath } from "../oauth-provider.js";
import { signInMcpOAuth } from "../oauth-signin.js";
import { type OAuthMcpServer, startOAuthMcpServer } from "./fixtures/oauth-mcp-server.js";

type Exec = (args: unknown, options: unknown) => Promise<{ content?: { text?: string }[] }>;

const originalHome = process.env.MUONROI_CLI_HOME;
const logged: string[] = [];

function serverCfg(srv: OAuthMcpServer, id = "fx") {
  return { id, label: `Fixture ${id}`, enabled: true, transport: "http" as const, url: srv.mcpUrl };
}

// biome-ignore lint/suspicious/noExplicitAny: test reads an untyped JSON store file
function stored(id = "fx"): Record<string, any> {
  return JSON.parse(readFileSync(mcpOAuthStorePath(), "utf8"))[id] ?? {};
}

async function signIn(srv: OAuthMcpServer, id = "fx") {
  let authUrl: URL | undefined;
  const started = await signInMcpOAuth(serverCfg(srv, id) as never, {
    openAuthorizationUrl: (u) => {
      authUrl = u;
      return true;
    },
  });
  expect(started.status).toBe("browser");
  expect(authUrl).toBeDefined();
  const callbackStatus = await srv.approve(authUrl!);
  const outcome = await started.completion;
  return { authUrl: authUrl!, callbackStatus, outcome };
}

async function callWhoami(id = "fx", srv?: OAuthMcpServer, opts?: Parameters<typeof acquireMcpTools>[1]) {
  const bundle = await acquireMcpTools([serverCfg(srv!, id) as never], opts);
  const tool = bundle.tools[`mcp_${id}__whoami`] as { execute?: Exec } | undefined;
  if (!tool?.execute) return { bundle, text: undefined as string | undefined };
  const out = await tool.execute({}, { toolCallId: "t", messages: [] });
  return { bundle, text: out.content?.[0]?.text };
}

beforeAll(() => {
  // Any token value that reaches a log line is a leak; collect every logger call.
  for (const level of ["info", "warn", "error", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  }
  vi.spyOn(logger, "file").mockImplementation((...args: unknown[]) => {
    logged.push(JSON.stringify(args));
  });
});

beforeEach(() => {
  process.env.MUONROI_CLI_HOME = mkdtempSync(join(tmpdir(), "mcp-oauth-flow-"));
  __resetMcpClientPoolForTests();
  __resetMcpOAuthForTests();
});

afterEach(async () => {
  await closeAllMcpClients();
  __resetMcpOAuthForTests();
});

afterAll(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.MUONROI_CLI_HOME;
  else process.env.MUONROI_CLI_HOME = originalHome;
});

describe("MCP OAuth sign-in (discovery + DCR + PKCE + state)", () => {
  let srv: OAuthMcpServer;
  beforeAll(async () => {
    srv = await startOAuthMcpServer();
  });
  afterAll(() => srv.close());

  it("signs in through the spec flow and persists tokens per server", async () => {
    const before = { ...srv.stats };
    const { authUrl, callbackStatus, outcome } = await signIn(srv);

    expect(outcome).toEqual({ ok: true });
    expect(callbackStatus).toBe(200);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("state")).toBeTruthy();
    // RFC 8707 resource indicator on both the authorization and token request.
    expect(authUrl.searchParams.get("resource")).toBe(srv.mcpUrl);
    expect(srv.stats.tokenResources.at(-1)).toBe(srv.mcpUrl);
    expect(srv.stats.registrations - before.registrations).toBe(1);
    expect(srv.stats.codeGrants - before.codeGrants).toBe(1);

    const rec = stored();
    expect(rec.tokens.access_token).toBeTruthy();
    expect(rec.tokens.refresh_token).toBeTruthy();
    expect(typeof rec.tokensSavedAt).toBe("number");
    expect(rec.discovery.authorizationServerUrl).toBeTruthy();
  });

  it("attaches the stored token on connects that cannot prompt (warm-up / council path)", async () => {
    await signIn(srv);
    const unauthBefore = srv.stats.mcpUnauthorized;
    // No onOAuthRequired — the pre-fix code sent no Authorization header here.
    const { bundle, text } = await callWhoami("fx", srv);
    expect(bundle.errors).toEqual([]);
    expect(text).toBe("authenticated-ok");
    expect(srv.stats.mcpUnauthorized).toBe(unauthBefore);
  });

  it("rejects a callback whose state does not match (CSRF)", async () => {
    let authUrl: URL | undefined;
    const started = await signInMcpOAuth(serverCfg(srv, "csrf") as never, {
      openAuthorizationUrl: (u) => {
        authUrl = u;
        return true;
      },
    });
    const tampered = new URL(authUrl!);
    tampered.searchParams.set("state", "attacker-state");
    const grantsBefore = srv.stats.codeGrants;
    expect(await srv.approve(tampered)).toBe(400);
    expect(srv.stats.codeGrants).toBe(grantsBefore);
    // The genuine callback still completes the same pending sign-in.
    expect(await srv.approve(authUrl!)).toBe(200);
    expect(await started.completion).toEqual({ ok: true });
  });

  it("an interactive turn without tokens opens ONE browser tab, joins it on retry, and lifts the auth pause on success", async () => {
    const opened: URL[] = [];
    const onOAuthRequired = (_id: string, url: URL) => {
      opened.push(url);
    };
    const first = await acquireMcpTools([serverCfg(srv, "turn") as never], { onOAuthRequired });
    expect(first.errors.join(" ")).toMatch(/needs OAuth sign-in — finish it in the browser/);
    const second = await acquireMcpTools([serverCfg(srv, "turn") as never], { onOAuthRequired });
    expect(second.errors.join(" ")).toMatch(/already waiting in your browser/);
    expect(opened).toHaveLength(1);

    // A non-interactive connect meanwhile fails (401) and arms the 60s pause.
    const anon = await acquireMcpTools([serverCfg(srv, "turn") as never]);
    expect(anon.errors.join(" ")).toMatch(/mcp_auth_required/);

    expect(await srv.approve(opened[0]!)).toBe(200);
    await vi.waitFor(() => expect(stored("turn").tokens?.access_token).toBeTruthy());
    // The sign-in lifted the pause, so a non-interactive connect works at once.
    const { text } = await callWhoami("turn", srv);
    expect(text).toBe("authenticated-ok");
  });
});

describe("MCP OAuth refresh", () => {
  let srv: OAuthMcpServer;
  beforeAll(async () => {
    srv = await startOAuthMcpServer({ refreshDelayMs: 150 });
  });
  afterAll(() => srv.close());

  it("refreshes an expired access token transparently mid-session, with the ORIGINAL client", async () => {
    await signIn(srv);
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
    const before = { ...srv.stats };
    const rtBefore = stored().tokens.refresh_token;

    srv.expireAccessTokens();
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");

    expect(srv.stats.refreshGrants - before.refreshGrants).toBe(1);
    expect(srv.stats.refreshFailures - before.refreshFailures).toBe(0);
    expect(srv.stats.registrations - before.registrations).toBe(0);
    // Rotation persisted: the stored refresh token is the new one, the old is dead.
    expect(stored().tokens.refresh_token).not.toBe(rtBefore);
    expect(srv.liveRefreshTokens()).toBe(1);
  });

  it("a NEW process refreshes with the persisted rotated token (no re-registration, no browser)", async () => {
    await signIn(srv);
    srv.expireAccessTokens();
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
    // Simulate a restart: drop every in-memory session/pool; only the file survives.
    await closeAllMcpClients();
    __resetMcpClientPoolForTests();
    __resetMcpOAuthForTests();
    const before = { ...srv.stats };
    srv.expireAccessTokens();
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
    expect(srv.stats.refreshGrants - before.refreshGrants).toBe(1);
    expect(srv.stats.refreshFailures - before.refreshFailures).toBe(0);
    expect(srv.stats.registrations - before.registrations).toBe(0);
  });

  it("concurrent calls on an expired token share ONE refresh", async () => {
    await signIn(srv);
    const bundle = await acquireMcpTools([serverCfg(srv) as never]);
    const tool = bundle.tools.mcp_fx__whoami as { execute: Exec };
    const before = { ...srv.stats };
    srv.expireAccessTokens();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => tool.execute({}, { toolCallId: `c${i}`, messages: [] })),
    );
    expect(results.map((r) => r.content?.[0]?.text)).toEqual(Array(8).fill("authenticated-ok"));
    expect(srv.stats.refreshGrants - before.refreshGrants).toBe(1);
    expect(srv.stats.refreshFailures - before.refreshFailures).toBe(0);
  });

  it("two processes refreshing the same stale token send ONE grant (file lock + re-read)", async () => {
    await signIn(srv);
    const stale = stored().tokens.access_token;
    srv.expireAccessTokens();
    const before = { ...srv.stats };
    // Separate session objects = separate processes' in-memory state.
    const a = new McpOAuthSession("fx", srv.mcpUrl, "A");
    const b = new McpOAuthSession("fx", srv.mcpUrl, "B");
    const [ta, tb] = await Promise.all([a.refresh(stale), b.refresh(stale)]);
    expect(ta.access_token).toBe(tb.access_token);
    expect(srv.stats.refreshGrants - before.refreshGrants).toBe(1);
    expect(srv.stats.refreshFailures - before.refreshFailures).toBe(0);
  });

  it("invalid_grant clears the dead tokens and asks for sign-in — no browser, no retry loop", async () => {
    await signIn(srv);
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
    srv.revokeRefreshTokens();
    srv.expireAccessTokens();
    const before = { ...srv.stats };

    const bundle = await acquireMcpTools([serverCfg(srv) as never]);
    const tool = bundle.tools.mcp_fx__whoami as { execute: Exec };
    await expect(tool.execute({}, { toolCallId: "x", messages: [] })).rejects.toThrow(
      /mcp_oauth_reauth_required: Fixture fx .*invalid_grant.*ctrl\+o/,
    );
    expect(srv.stats.refreshFailures - before.refreshFailures).toBe(1);
    expect(stored().tokens).toBeUndefined();
    expect(stored().clientInfo).toBeDefined();

    // The pool paused the server: the next non-interactive turn does not hammer the AS.
    const next = await acquireMcpTools([serverCfg(srv) as never]);
    expect(next.errors.join(" ")).toMatch(/mcp_oauth_reauth_required/);
    expect(srv.stats.refreshFailures - before.refreshFailures).toBe(1);
    expect(srv.stats.refreshGrants - before.refreshGrants).toBe(0);

    // Re-sign-in reuses the stored client registration (same loopback port).
    const { outcome } = await signIn(srv);
    expect(outcome).toEqual({ ok: true });
    expect(srv.stats.registrations - before.registrations).toBe(0);
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
  });

  it("never logs a token value", async () => {
    await signIn(srv);
    const { access_token, refresh_token } = stored().tokens;
    srv.expireAccessTokens();
    await callWhoami("fx", srv);
    const rotated = stored().tokens;
    const joined = logged.join("\n");
    for (const secret of [access_token, refresh_token, rotated.access_token, rotated.refresh_token]) {
      expect(joined).not.toContain(secret);
    }
  });
});

describe("MCP OAuth proactive refresh", () => {
  let srv: OAuthMcpServer;
  beforeAll(async () => {
    srv = await startOAuthMcpServer({ accessTtlSec: 1 });
  });
  afterAll(() => srv.close());

  it("refreshes BEFORE the server sees an expired token", async () => {
    await signIn(srv);
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
    const session = getMcpOAuthSession(serverCfg(srv));
    await new Promise((r) => setTimeout(r, 1_100));
    const before = { ...srv.stats };
    expect((await callWhoami("fx", srv)).text).toBe("authenticated-ok");
    expect(srv.stats.refreshGrants - before.refreshGrants).toBeGreaterThanOrEqual(1);
    expect(srv.stats.mcpUnauthorized - before.mcpUnauthorized).toBe(0);
    expect(session.refreshCount).toBeGreaterThanOrEqual(1);
  });
});
