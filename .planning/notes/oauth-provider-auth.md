---
title: OpenAI OAuth Provider Auth Strategy
date: 2026-05-15
context: Exploration session — add OAuth (subscription-based) login alongside existing API key auth
---

# OpenAI OAuth Provider Auth — Strategy Note

## Goal

Allow users to authenticate to OpenAI via their **ChatGPT/Codex subscription** (browser OAuth) instead of being forced to buy a separate API key. Mirrors how `openai/codex` open-source CLI works. **API key path must continue to work** — OAuth is additive, not replacing.

## Why

- Many users already pay for ChatGPT Plus/Pro/Team but don't have separate API credits.
- Codex CLI proves the flow works (Device Code + PKCE hybrid against `auth.openai.com`).
- Removes friction for first-run experience: "log in with OpenAI" instead of "go buy API credits, paste sk-...".

## How Codex CLI does it (research findings, 2026-05-15)

1. **Flow:** Device Authorization Grant **hybrid** with PKCE.
   - `POST {issuer}/api/accounts/deviceauth/usercode` with `{client_id}` → returns user_code + verification_url
   - User opens URL in browser, approves
   - CLI polls until server returns `authorization_code`
   - CLI exchanges `authorization_code` + PKCE `code_verifier` at `POST {issuer}/oauth/token`
2. **Issuer:** `https://auth.openai.com`
3. **Token storage:** `$CODEX_HOME/auth.json` (mode 0600) — `{ OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id }, auth_mode, last_refresh }`. Also supports OS keyring via `AuthCredentialsStoreMode` enum.
4. **Request auth:** `Authorization: Bearer {access_token}` + `ChatGPT-Account-ID: {account_id}` header. Access token is a JWT, not `sk-...`.
5. **Refresh:** `POST https://auth.openai.com/oauth/token` with `grant_type=refresh_token`. `invalid_grant` (401) = permanent failure, network errors = transient.
6. **Revoke:** `POST https://auth.openai.com/oauth/revoke`
7. **API key exchange:** `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` to mint a real `sk-...` key from the subscription token (optional path).

## Mapping to muonroi-cli codebase

| Concern | Current state | What's needed |
|---|---|---|
| `OAuthProvider` interface | Only MCP-flavored (`CliOAuthProvider` in `src/mcp/oauth-provider.ts`) — uses browser redirect | New interface in `src/providers/auth/`, device-code variant |
| Device-code poll loop | Doesn't exist | New `src/providers/auth/device-flow.ts` |
| Token storage (access + refresh + account_id) | `keychain.ts` only stores single API key per provider | Extend with `{providerId}:oauth-tokens` account, JSON blob with refresh hooks |
| `loadKeyForProvider()` fallback | keychain → env → settings.json | Add: OAuth token (with auto-refresh) → keychain API key → env → settings.json |
| `keys login <provider>` subcommand | Missing | New entry in `src/cli/keys.ts` |
| Provider adapter (Bearer + `ChatGPT-Account-ID`) | `src/providers/adapter.ts` builds OpenAI config with `apiKey` only | Conditional: if OAuth token, set Bearer + extra headers |
| Token refresh on 401 | Not applicable currently | Adapter or fetch wrapper retries once after refresh |
| `CliOAuthProvider` (MCP) | Browser-redirect, callback server | **Not reusable** — keep as-is for MCP |

## Design — interface-first (for future Anthropic/Google extensibility)

```ts
// src/providers/auth/types.ts
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId?: string;
  expiresAt: number; // epoch ms
}

export interface ProviderOAuth {
  readonly providerId: ProviderId;
  login(opts: { onUserCode?: (code: string, url: string) => void }): Promise<OAuthTokens>;
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
  revoke(tokens: OAuthTokens): Promise<void>;
  authHeaders(tokens: OAuthTokens): Record<string, string>;
}

// src/providers/auth/openai-oauth.ts
export class OpenAIOAuthProvider implements ProviderOAuth { ... }

// src/providers/auth/token-store.ts
export function saveTokens(providerId: ProviderId, tokens: OAuthTokens): Promise<void>;
export function loadTokens(providerId: ProviderId): Promise<OAuthTokens | null>;
export function deleteTokens(providerId: ProviderId): Promise<void>;
```

## Token storage decision

- **Primary:** OS keychain via `keytar` (consistent with current API key path).
  - Account key: `oauth:openai` (vs current `openai` for raw API key).
  - Value: JSON-serialized `OAuthTokens`.
- **Fallback when keytar unavailable:** `~/.muonroi-cli/oauth-tokens.json` with mode 0600 (POSIX) — never write tokens to `user-settings.json` (already-deprecated plaintext path).

## Resolution priority (new)

In `loadKeyForProvider()` and adapter:

1. **OAuth token in keychain** (auto-refresh if `Date.now() > expiresAt - 60_000`)
2. Keychain API key (existing path)
3. `OPENAI_API_KEY` env var
4. `user-settings.json` (deprecated)
5. Throw `ProviderKeyMissingError`

API-key path **must remain unchanged** for users who want explicit billing control or use third-party gateways (DeepSeek, SiliconFlow, etc.).

## Out of scope (this phase)

- Anthropic / Google OAuth (interface is in place, but no impl until they offer it)
- API-key-exchange grant (mint `sk-...` from subscription) — defer until needed
- FedRAMP `X-OpenAI-Fedramp` header — defer
- Multi-account switching — single active account per provider for now

## Risks

- **OAuth client_id:** Codex uses its own. We need either to use Codex's published client_id (legally fine since it's OSS and public) **or** register a new OpenAI OAuth client. Decision needed during planning.
- **Refresh race:** two concurrent requests both seeing expired token → both refresh → second one revokes the first. Need mutex around refresh.
- **Test strategy:** can't hit real OAuth in CI. Need a mock issuer fixture + injectable HTTP client.

## References

- Codex CLI source: <https://github.com/openai/codex>
- Existing MCP OAuth: `src/mcp/oauth-provider.ts`, `src/mcp/oauth-callback.ts`
- Existing keychain: `src/providers/keychain.ts:125` (`loadKeyForProvider`)
- Existing keys CLI: `src/cli/keys.ts`
