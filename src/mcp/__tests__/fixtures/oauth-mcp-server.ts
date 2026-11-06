/**
 * Local OAuth-protected MCP server for tests (NOT production code).
 *
 * Implements the MCP authorization spec flow (2025-11-25, basic/authorization)
 * end-to-end on 127.0.0.1 so the CLI's sign-in + refresh paths can be exercised
 * without a network:
 *   - Streamable HTTP MCP endpoint at /mcp that answers 401 +
 *     `WWW-Authenticate: Bearer resource_metadata="…"` without a valid token (RFC 9728 §5.1)
 *   - Protected Resource Metadata at /.well-known/oauth-protected-resource[/mcp] (RFC 9728)
 *   - Authorization Server Metadata at /.well-known/oauth-authorization-server (RFC 8414)
 *   - Dynamic Client Registration at /register (RFC 7591)
 *   - Authorization code + PKCE S256 at /authorize + /token (OAuth 2.1 §4.1)
 *   - Short-lived access tokens + refresh tokens with ROTATION: a refresh token is
 *     single-use; replaying it yields `invalid_grant` (OAuth 2.1 §4.3.1)
 *
 * The browser step is simulated by `approve(authUrl)`: it follows /authorize's
 * 302 to the client's loopback redirect_uri exactly as a browser would.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface OAuthMcpServerOptions {
  /** Access-token lifetime in seconds (advertised as expires_in). Default 3600. */
  accessTtlSec?: number;
  /** Artificial latency on refresh_token grants, to widen concurrency windows. */
  refreshDelayMs?: number;
}

interface ClientReg {
  client_id: string;
  redirect_uris: string[];
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | null;
}

export interface OAuthMcpServer {
  url: string;
  mcpUrl: string;
  stats: {
    registrations: number;
    authorizeRequests: number;
    codeGrants: number;
    refreshGrants: number;
    refreshFailures: number;
    mcpRequests: number;
    mcpUnauthorized: number;
    /** JSON-RPC methods received WITH a valid bearer token, in order. */
    authedMethods: string[];
    /** `resource` parameters seen on token requests (RFC 8707). */
    tokenResources: (string | null)[];
  };
  /** Simulate the user's browser approving `authUrl`; resolves with the callback HTTP status. */
  approve(authUrl: URL | string): Promise<number>;
  /** Make every issued access token expired (refresh tokens stay valid). */
  expireAccessTokens(): void;
  /** Revoke every refresh token (the next refresh gets invalid_grant). */
  revokeRefreshTokens(): void;
  /** Number of refresh tokens currently valid (rotation leaves exactly one per session). */
  liveRefreshTokens(): number;
  close(): Promise<void>;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startOAuthMcpServer(opts: OAuthMcpServerOptions = {}): Promise<OAuthMcpServer> {
  const accessTtlSec = opts.accessTtlSec ?? 3600;
  const clients = new Map<string, ClientReg>();
  const codes = new Map<string, PendingCode>();
  const access = new Map<string, { expiresAt: number }>();
  const refresh = new Map<string, { clientId: string; valid: boolean }>();
  const stats: OAuthMcpServer["stats"] = {
    registrations: 0,
    authorizeRequests: 0,
    codeGrants: 0,
    refreshGrants: 0,
    refreshFailures: 0,
    mcpRequests: 0,
    mcpUnauthorized: 0,
    authedMethods: [],
    tokenResources: [],
  };
  let base = "";

  const issue = (clientId: string) => {
    const at = b64url(randomBytes(24));
    const rt = b64url(randomBytes(24));
    access.set(at, { expiresAt: Date.now() + accessTtlSec * 1000 });
    refresh.set(rt, { clientId, valid: true });
    return { access_token: at, token_type: "Bearer", expires_in: accessTtlSec, refresh_token: rt };
  };

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    stats.mcpRequests++;
    const authz = req.headers.authorization ?? "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
    const rec = token ? access.get(token) : undefined;
    if (!rec || rec.expiresAt <= Date.now()) {
      stats.mcpUnauthorized++;
      const errorDescription = token ? "token expired or unknown" : "No authorization provided";
      json(
        res,
        401,
        { error: "invalid_token", error_description: errorDescription },
        {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        },
      );
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const raw = await readBody(req);
    const parsed = raw ? JSON.parse(raw) : undefined;
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m && typeof m.method === "string") stats.authedMethods.push(m.method);
    }
    const server = new Server({ name: "oauth-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "whoami",
          description: "Returns a fixed string when the caller is authenticated.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "authenticated-ok" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  };

  const httpServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", base);
    const route = `${req.method} ${u.pathname}`;
    void (async () => {
      if (u.pathname === "/mcp") return handleMcp(req, res);
      if (
        req.method === "GET" &&
        (u.pathname === "/.well-known/oauth-protected-resource/mcp" ||
          u.pathname === "/.well-known/oauth-protected-resource")
      ) {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (req.method === "GET" && u.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (route === "POST /register") {
        const meta = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
        stats.registrations++;
        const client_id = `client-${stats.registrations}-${b64url(randomBytes(6))}`;
        const reg = { client_id, redirect_uris: meta.redirect_uris ?? [] };
        clients.set(client_id, reg);
        return json(res, 201, { ...meta, ...reg, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (route === "GET /authorize") {
        stats.authorizeRequests++;
        const p = u.searchParams;
        const client = clients.get(p.get("client_id") ?? "");
        const redirectUri = p.get("redirect_uri") ?? "";
        if (!client?.redirect_uris.includes(redirectUri)) {
          return json(res, 400, { error: "invalid_request", error_description: "unknown client or redirect_uri" });
        }
        if (
          p.get("response_type") !== "code" ||
          p.get("code_challenge_method") !== "S256" ||
          !p.get("code_challenge")
        ) {
          return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
        }
        const code = b64url(randomBytes(16));
        codes.set(code, {
          clientId: client.client_id,
          redirectUri,
          challenge: p.get("code_challenge") ?? "",
          resource: p.get("resource"),
        });
        const to = new URL(redirectUri);
        to.searchParams.set("code", code);
        const state = p.get("state");
        if (state) to.searchParams.set("state", state);
        res.writeHead(302, { location: to.toString() });
        res.end();
        return;
      }
      if (route === "POST /token") {
        const form = new URLSearchParams(await readBody(req));
        stats.tokenResources.push(form.get("resource"));
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const challenge = b64url(createHash("sha256").update(verifier).digest());
          if (
            !pending ||
            pending.clientId !== form.get("client_id") ||
            pending.redirectUri !== form.get("redirect_uri") ||
            pending.challenge !== challenge
          ) {
            return json(res, 400, { error: "invalid_grant", error_description: "bad code, client, redirect or PKCE" });
          }
          stats.codeGrants++;
          return json(res, 200, issue(pending.clientId));
        }
        if (grant === "refresh_token") {
          if (opts.refreshDelayMs) await new Promise((r) => setTimeout(r, opts.refreshDelayMs));
          const rt = form.get("refresh_token") ?? "";
          const rec = refresh.get(rt);
          if (!rec?.valid || rec.clientId !== form.get("client_id")) {
            stats.refreshFailures++;
            return json(res, 400, { error: "invalid_grant", error_description: "refresh token invalid or reused" });
          }
          rec.valid = false; // rotation: single use
          stats.refreshGrants++;
          return json(res, 200, issue(rec.clientId));
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      res.writeHead(404);
      res.end();
    })().catch((err: unknown) => {
      // Fixture-side failure: surface it in the test output, never swallow.
      console.error(`[oauth-fixture] ${route} failed: ${(err as Error)?.message}`);
      if (!res.headersSent) json(res, 500, { error: "server_error" });
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  return {
    url: base,
    mcpUrl: `${base}/mcp`,
    stats,
    async approve(authUrl) {
      const r1 = await fetch(String(authUrl), { redirect: "manual" });
      const location = r1.headers.get("location");
      if (r1.status !== 302 || !location) {
        throw new Error(`authorize did not redirect (HTTP ${r1.status}): ${await r1.text()}`);
      }
      const r2 = await fetch(location);
      await r2.text();
      return r2.status;
    },
    expireAccessTokens() {
      for (const rec of access.values()) rec.expiresAt = 0;
    },
    revokeRefreshTokens() {
      for (const rec of refresh.values()) rec.valid = false;
    },
    liveRefreshTokens() {
      return [...refresh.values()].filter((r) => r.valid).length;
    },
    close() {
      return new Promise((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
    },
  };
}
