/**
 * src/mcp/oauth-provider.ts
 *
 * OAuth for remote (http/sse) MCP servers, per the MCP authorization spec
 * (modelcontextprotocol.io/specification/2025-11-25/basic/authorization):
 * RFC 9728 resource metadata -> RFC 8414 AS metadata -> RFC 7591 DCR ->
 * authorization code + PKCE S256 -> bearer on EVERY request -> refresh with
 * rotation (OAuth 2.1 §4.3.1).
 *
 * Three pieces:
 *  - the per-server store (~/.muonroi-cli/mcp-oauth.json, 0600, atomic writes,
 *    every token enrolled in the log redactor);
 *  - `CliOAuthProvider`, the SDK `OAuthClientProvider` used for the INTERACTIVE
 *    sign-in only (driven by the MCP SDK's own `auth()`);
 *  - `McpOAuthSession`, the non-interactive token manager every connection
 *    uses: it attaches the bearer to each request, refreshes before expiry or on
 *    401, single-flights the refresh (in-process promise + cross-process file
 *    lock, because a rotated refresh token is single-use), and on a rejected
 *    refresh clears the dead tokens and raises `McpOAuthReauthRequiredError`
 *    instead of silently re-prompting.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { withFileLock } from "../utils/file-lock.js";
import { logger } from "../utils/logger.js";
import { muonroiHome } from "../utils/muonroi-home.js";
import { redactor } from "../utils/redactor.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

interface CliOAuthStorage {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** Epoch ms when `tokens` was saved — `expires_in` is relative to it. Absent on pre-fix records. */
  tokensSavedAt?: number;
  discovery?: OAuthDiscoveryState;
  codeVerifier?: string;
  /** OAuth `state` of the in-flight interactive sign-in (CSRF check on the callback). */
  state?: string;
}

/**
 * Same `MUONROI_CLI_HOME ?? ~/.muonroi-cli` convention as every other store
 * (src/providers/auth/token-store.ts), resolved lazily so the suite-wide test
 * pin reaches it. The old `homedir()` join meant a test touching OAuth wrote
 * the developer's real token file.
 */
export function mcpOAuthStorePath(): string {
  return join(muonroiHome(), "mcp-oauth.json");
}

function enrollRecord(rec: CliOAuthStorage | undefined): void {
  const t = rec?.tokens as (OAuthTokens & { id_token?: string }) | undefined;
  if (t?.access_token) redactor.enrollSecret(t.access_token);
  if (t?.refresh_token) redactor.enrollSecret(t.refresh_token);
  if (t?.id_token) redactor.enrollSecret(t.id_token);
  const secret = (rec?.clientInfo as { client_secret?: string } | undefined)?.client_secret;
  if (secret) redactor.enrollSecret(secret);
}

function readAll(): Record<string, CliOAuthStorage> {
  const file = mcpOAuthStorePath();
  if (!existsSync(file)) return {};
  try {
    const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, CliOAuthStorage>;
    for (const rec of Object.values(all)) enrollRecord(rec);
    return all;
  } catch (err) {
    logger.warn("mcp", `oauth store unreadable, starting empty: ${(err as Error)?.message}`, { file });
    return {};
  }
}

function getStore(serverId: string): CliOAuthStorage {
  return readAll()[serverId] ?? {};
}

function patchStore(serverId: string, patch: Partial<CliOAuthStorage>): void {
  const file = mcpOAuthStorePath();
  const all = readAll();
  const next: CliOAuthStorage = { ...(all[serverId] ?? {}), ...patch };
  for (const k of Object.keys(next) as (keyof CliOAuthStorage)[]) {
    if (next[k] === undefined) delete next[k];
  }
  all[serverId] = next;
  enrollRecord(next);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write can never leave a truncated store
    // (which would read as "no tokens" and force a re-sign-in).
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    // `mode` only applies on creation; tighten a pre-existing file too.
    // Windows ignores POSIX modes (the file lives in the per-user profile).
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch (err) {
    logger.error("mcp", `oauth store write failed: ${(err as Error)?.message}`, { file, serverId });
  }
}

/** True when a token set is stored for this server (it may still need a refresh). */
export function hasStoredMcpOAuthTokens(serverId: string): boolean {
  return !!getStore(serverId).tokens?.access_token;
}

/** Persist a token response, keeping the old refresh token when the AS did not rotate it (RFC 6749 §6). */
function persistTokens(serverId: string, tokens: OAuthTokens): void {
  const prev = getStore(serverId).tokens;
  const merged: OAuthTokens = { ...tokens };
  if (!merged.refresh_token && prev?.refresh_token) merged.refresh_token = prev.refresh_token;
  patchStore(serverId, { tokens: merged, tokensSavedAt: Date.now() });
}

export class CliOAuthProvider implements OAuthClientProvider {
  private serverId: string;
  private _redirectUrl: string;
  private onAuthUrl: (url: URL) => void;

  constructor(opts: { serverId: string; callbackPort: number; onAuthorizationUrl: (url: URL) => void }) {
    this.serverId = opts.serverId;
    this._redirectUrl = `http://127.0.0.1:${opts.callbackPort}/callback`;
    this.onAuthUrl = opts.onAuthorizationUrl;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "muonroi-cli",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const state = randomBytes(16).toString("base64url");
    patchStore(this.serverId, { state });
    return state;
  }

  storedState(): string | undefined {
    return getStore(this.serverId).state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = getStore(this.serverId).clientInfo as
      | (OAuthClientInformationMixed & { redirect_uris?: string[] })
      | undefined;
    // Interactive sign-in only: /authorize validates the exact redirect_uri, so
    // a registration made on a different loopback port is re-registered. The
    // REFRESH path (McpOAuthSession) deliberately does not go through here —
    // the redirect_uri plays no part in a refresh_token grant, and treating the
    // per-process port as a registration mismatch is what made every refresh
    // run against a brand-new client id and fail with invalid_grant.
    if (info?.redirect_uris && !info.redirect_uris.includes(this._redirectUrl)) return undefined;
    return info;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    patchStore(this.serverId, { clientInfo: info });
  }

  tokens(): OAuthTokens | undefined {
    return getStore(this.serverId).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    persistTokens(this.serverId, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.onAuthUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    patchStore(this.serverId, { codeVerifier });
  }

  codeVerifier(): string {
    return getStore(this.serverId).codeVerifier ?? "";
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    patchStore(this.serverId, { discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return getStore(this.serverId).discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const patch: Partial<CliOAuthStorage> = {};
    if (scope === "all" || scope === "tokens") {
      patch.tokens = undefined;
      patch.tokensSavedAt = undefined;
    }
    if (scope === "all" || scope === "client") patch.clientInfo = undefined;
    if (scope === "all" || scope === "discovery") patch.discovery = undefined;
    if (scope === "all" || scope === "verifier") {
      patch.codeVerifier = undefined;
      patch.state = undefined;
    }
    patchStore(this.serverId, patch);
  }
}

// ---------------------------------------------------------------------------
// Non-interactive session: bearer attach + refresh
// ---------------------------------------------------------------------------

/**
 * The stored refresh token was rejected (invalid_grant / invalid_client) or is
 * missing. The dead tokens are already cleared; the user must sign in again.
 * Carries `status: 401` so the client pool's auth-pause (no reconnect loop)
 * classifies it.
 */
export class McpOAuthReauthRequiredError extends Error {
  readonly status = 401;
  constructor(
    readonly serverId: string,
    label: string,
    reason: string,
  ) {
    super(
      `mcp_oauth_reauth_required: ${label} (HTTP 401): ${reason}. Sign in again: open /mcp, select ${label}, press ctrl+o.`,
    );
    this.name = "McpOAuthReauthRequiredError";
  }
}

const REAUTH_ERROR_CODES = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

function oauthErrorCode(err: unknown): string | undefined {
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" ? code : undefined;
}

/** Refresh this far ahead of expiry; capped at 10% of the lifetime so short tokens are not refreshed forever. */
const REFRESH_SKEW_MS = 60_000;

function isExpiring(rec: CliOAuthStorage, now = Date.now()): boolean {
  const ttlSec = rec.tokens?.expires_in;
  // Pre-fix records carry no save time: expiry is unknown, so rely on the 401.
  if (!rec.tokensSavedAt || typeof ttlSec !== "number" || ttlSec <= 0) return false;
  const ttlMs = ttlSec * 1000;
  return now >= rec.tokensSavedAt + ttlMs - Math.min(REFRESH_SKEW_MS, ttlMs * 0.1);
}

function withBearer(headers: RequestInit["headers"], token: string | undefined): Headers {
  const h = new Headers(headers);
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

export class McpOAuthSession {
  private inflight: Promise<OAuthTokens> | undefined;
  /** Diagnostics for tests/forensics: refresh grants this session actually sent. */
  refreshCount = 0;

  constructor(
    readonly serverId: string,
    readonly serverUrl: string,
    readonly label: string,
  ) {}

  hasTokens(): boolean {
    return hasStoredMcpOAuthTokens(this.serverId);
  }

  /** A usable access token: refreshed first when it is at/near expiry. Undefined when not signed in. */
  async accessToken(): Promise<string | undefined> {
    const rec = getStore(this.serverId);
    if (!rec.tokens?.access_token) return undefined;
    if (isExpiring(rec)) return (await this.refresh(rec.tokens.access_token)).access_token;
    return rec.tokens.access_token;
  }

  /**
   * Refresh, single-flight. `staleAccessToken` is the token the caller saw
   * fail/expire: if the store already holds a different, unexpired one (a
   * concurrent caller or another CLI process refreshed meanwhile) it is reused
   * and no grant is sent — with rotation, a second grant on the same refresh
   * token would be rejected and log the user out.
   */
  refresh(staleAccessToken: string | undefined): Promise<OAuthTokens> {
    if (!this.inflight) {
      this.inflight = withFileLock(mcpOAuthStorePath(), () => this.refreshLocked(staleAccessToken), {
        staleMs: 30_000,
        timeoutMs: 35_000,
      }).finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async refreshLocked(staleAccessToken: string | undefined): Promise<OAuthTokens> {
    const rec = getStore(this.serverId);
    if (rec.tokens?.access_token && rec.tokens.access_token !== staleAccessToken && !isExpiring(rec)) {
      return rec.tokens;
    }
    const refreshToken = rec.tokens?.refresh_token;
    if (!refreshToken) {
      this.clearTokens();
      throw new McpOAuthReauthRequiredError(this.serverId, this.label, "access token expired and no refresh token");
    }
    if (!rec.clientInfo) {
      this.clearTokens();
      throw new McpOAuthReauthRequiredError(this.serverId, this.label, "no stored client registration");
    }

    let discovery = rec.discovery;
    if (!discovery?.authorizationServerUrl) {
      const info = await discoverOAuthServerInfo(this.serverUrl);
      discovery = { ...info, authorizationServerUrl: String(info.authorizationServerUrl) };
      patchStore(this.serverId, { discovery });
    }
    const resource = await selectResourceURL(this.serverUrl, {} as OAuthClientProvider, discovery.resourceMetadata);

    let tokens: OAuthTokens;
    try {
      this.refreshCount++;
      tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation: rec.clientInfo,
        refreshToken,
        resource,
      });
    } catch (err) {
      const code = oauthErrorCode(err);
      logger.warn("mcp", `oauth refresh failed: ${code ?? (err as Error)?.message}`, {
        serverId: this.serverId,
        errorCode: code,
      });
      if (code && REAUTH_ERROR_CODES.has(code)) {
        this.clearTokens();
        throw new McpOAuthReauthRequiredError(
          this.serverId,
          this.label,
          `the authorization server rejected the refresh token (${code})`,
        );
      }
      // Transient (network, 5xx, metadata moved): keep the tokens, re-discover next time.
      patchStore(this.serverId, { discovery: undefined });
      throw err;
    }
    persistTokens(this.serverId, tokens);
    logger.info("mcp", "oauth access token refreshed", {
      serverId: this.serverId,
      rotated: !!tokens.refresh_token && tokens.refresh_token !== refreshToken,
      expiresIn: tokens.expires_in,
    });
    return getStore(this.serverId).tokens ?? tokens;
  }

  private clearTokens(): void {
    patchStore(this.serverId, { tokens: undefined, tokensSavedAt: undefined });
  }

  /**
   * `fetch` for the MCP transport: bearer on every request (spec: "authorization
   * MUST be included in every HTTP request"), one refresh + retry on 401. The
   * transport is given this INSTEAD of an `authProvider`, so a mid-turn 401 can
   * never open a browser or race a second refresh from the transport's own
   * auth() (it used to run one per concurrent POST/SSE-GET).
   */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const token = await this.accessToken();
    const res = await fetch(input, { ...init, headers: withBearer(init?.headers, token) });
    if (res.status !== 401 || !token) return res;
    await res.body?.cancel().catch((err: unknown) => {
      logger.file("debug", "mcp", `oauth 401 body discard failed: ${(err as Error)?.message}`, {
        serverId: this.serverId,
      });
    });
    const fresh = await this.refresh(token);
    return fetch(input, { ...init, headers: withBearer(init?.headers, fresh.access_token) });
  };
}

const sessions = new Map<string, McpOAuthSession>();

/** One session per (server id, url): shared by every pooled client so refreshes single-flight. */
export function getMcpOAuthSession(server: { id: string; label: string; url?: string }): McpOAuthSession {
  const key = `${server.id}\u0000${server.url ?? ""}`;
  let s = sessions.get(key);
  if (!s) {
    s = new McpOAuthSession(server.id, server.url ?? "", server.label);
    sessions.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Interactive sign-in
// ---------------------------------------------------------------------------

export type McpOAuthSignInOutcome = { ok: true } | { ok: false; error: string };

interface PendingSignIn {
  authUrl?: URL;
  completion: Promise<McpOAuthSignInOutcome>;
  cancel: () => void;
}

const pendingSignIns = new Map<string, PendingSignIn>();
const signedInListeners = new Set<(serverId: string) => void>();

/** Subscribe to successful sign-ins (the client pool drops its auth pause + stale client). */
export function onMcpOAuthSignedIn(fn: (serverId: string) => void): () => void {
  signedInListeners.add(fn);
  return () => signedInListeners.delete(fn);
}

function notifySignedIn(serverId: string): void {
  for (const fn of signedInListeners) {
    try {
      fn(serverId);
    } catch (err) {
      logger.error("mcp", `oauth signed-in listener failed: ${(err as Error)?.message}`, { serverId });
    }
  }
}

/** The loopback port of the stored registration, so a re-sign-in can reuse the client instead of re-registering. */
function registeredCallbackPort(serverId: string): number {
  const uri = (getStore(serverId).clientInfo as { redirect_uris?: string[] } | undefined)?.redirect_uris?.[0];
  if (!uri) return 0;
  try {
    const u = new URL(uri);
    return u.hostname === "127.0.0.1" && u.port ? Number(u.port) : 0;
  } catch (err) {
    logger.file("debug", "mcp", `oauth stored redirect_uri unparsable: ${(err as Error)?.message}`, { serverId });
    return 0;
  }
}

export interface BeginSignInResult {
  status: "authorized" | "browser" | "pending";
  /** The authorization URL (also handed to `openAuthorizationUrl`). */
  authUrl?: URL;
  /** Settles when the callback's code exchange finishes, fails, or times out. */
  completion: Promise<McpOAuthSignInOutcome>;
}

/**
 * Start (or join) the interactive authorization-code + PKCE flow for one server.
 * - `force` drops stored tokens first (re-authenticate) and supersedes a pending flow.
 * - Without `force`, a flow already waiting on the browser is joined, never
 *   restarted — a turn that keeps reconnecting must not open a tab per attempt.
 */
export async function beginMcpOAuthSignIn(
  server: { id: string; label: string; url: string },
  opts: { openAuthorizationUrl: (url: URL) => void; force?: boolean; timeoutMs?: number },
): Promise<BeginSignInResult> {
  const existing = pendingSignIns.get(server.id);
  if (existing && !opts.force) {
    return { status: "pending", authUrl: existing.authUrl, completion: existing.completion };
  }
  existing?.cancel();

  let settle!: (o: McpOAuthSignInOutcome) => void;
  const completion = new Promise<McpOAuthSignInOutcome>((resolve) => {
    settle = resolve;
  });
  let provider: CliOAuthProvider | undefined;
  let done = false;
  const finish = (o: McpOAuthSignInOutcome) => {
    if (done) return;
    done = true;
    callback?.close();
    if (pendingSignIns.get(server.id) === entry) pendingSignIns.delete(server.id);
    if (o.ok) {
      logger.info("mcp", "oauth sign-in completed", { serverId: server.id });
      notifySignedIn(server.id);
    } else {
      logger.warn("mcp", `oauth sign-in did not complete: ${o.error}`, { serverId: server.id });
    }
    settle(o);
  };

  const callbackOpts = {
    timeoutMs: opts.timeoutMs ?? 300_000,
    onTimeout: () => finish({ ok: false, error: "timed out waiting for the browser sign-in" }),
    onError: (error: string, description?: string) =>
      finish({ ok: false, error: `authorization server returned ${error}${description ? `: ${description}` : ""}` }),
    onCode: async (code: string, state: string): Promise<McpOAuthSignInOutcome> => {
      if (!provider) return { ok: false, error: "sign-in not initialised" };
      if (done) return { ok: false, error: "this sign-in already finished — start a new one from /mcp" };
      const expected = provider.storedState();
      if (!expected || expected !== state) {
        // Spec: discard any result whose state is missing or mismatched.
        return { ok: false, error: "state mismatch — ignored this callback" };
      }
      try {
        const result = await auth(provider, { serverUrl: server.url, authorizationCode: code });
        const outcome: McpOAuthSignInOutcome =
          result === "AUTHORIZED" ? { ok: true } : { ok: false, error: `unexpected auth result ${result}` };
        finish(outcome);
        return outcome;
      } catch (err) {
        const outcome = { ok: false as const, error: `code exchange failed: ${(err as Error)?.message}` };
        finish(outcome);
        return outcome;
      }
    },
  };

  let callback: Awaited<ReturnType<typeof startOAuthCallbackServer>> | undefined;
  const preferred = registeredCallbackPort(server.id);
  try {
    callback = await startOAuthCallbackServer({ ...callbackOpts, port: preferred });
  } catch (err) {
    if (preferred === 0) throw err;
    logger.file(
      "debug",
      "mcp",
      `oauth callback port ${preferred} unavailable (${(err as Error)?.message}); using a fresh one`,
      {
        serverId: server.id,
      },
    );
    callback = await startOAuthCallbackServer({ ...callbackOpts, port: 0 });
  }

  let authUrl: URL | undefined;
  provider = new CliOAuthProvider({
    serverId: server.id,
    callbackPort: callback.port,
    onAuthorizationUrl: (url) => {
      authUrl = url;
      entry.authUrl = url;
      opts.openAuthorizationUrl(url);
    },
  });
  const entry: PendingSignIn = {
    completion,
    cancel: () => finish({ ok: false, error: "superseded by a new sign-in" }),
  };
  pendingSignIns.set(server.id, entry);

  if (opts.force) provider.invalidateCredentials("tokens");
  provider.invalidateCredentials("verifier");
  try {
    const result = await auth(provider, { serverUrl: server.url });
    if (result === "AUTHORIZED") {
      finish({ ok: true });
      return { status: "authorized", completion };
    }
    return { status: "browser", authUrl, completion };
  } catch (err) {
    finish({ ok: false, error: (err as Error)?.message ?? String(err) });
    throw err;
  }
}

/** Test-only: forget sessions and abandon pending sign-ins. */
export function __resetMcpOAuthForTests(): void {
  for (const p of pendingSignIns.values()) p.cancel();
  pendingSignIns.clear();
  sessions.clear();
}

/**
 * True when the endpoint answers an unauthenticated initialize with 401 — the
 * signal that OAuth is required. Servers that never 401 skip OAuth entirely.
 */
export async function endpointRequiresOAuth(url: string, headers?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "muonroi-cli", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel();
    return res.status === 401;
  } catch (err) {
    logger.warn("mcp", `oauth probe failed: ${(err as Error)?.message}`, { url });
    return false;
  }
}
