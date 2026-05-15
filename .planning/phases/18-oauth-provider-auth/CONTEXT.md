# Phase 18 — OAuth Provider Auth (OpenAI subscription login)

**Milestone:** v1.7 Auth Flexibility
**Status:** Planned (PLAN.md not yet generated)
**Depends on:** none (orthogonal to council/EE work)
**Requirements:** AUTH-01, AUTH-02, AUTH-03, AUTH-04

## Why this phase exists

Currently `muonroi-cli` only authenticates to LLM providers via API key. Users who already pay for **ChatGPT Plus/Pro/Team / Codex subscription** must buy separate API credits to use this CLI, which is a major adoption friction. The open-source Codex CLI solves this with an OAuth Device-Code + PKCE flow against `auth.openai.com` that mints subscription-backed access tokens.

This phase adds an additive OAuth login path **alongside** the existing API-key path. API key continues to work unchanged.

See `.planning/notes/oauth-provider-auth.md` for full research/strategy notes (Codex flow analysis, codebase mapping, interface design).

## Scope

1. **`ProviderOAuth` interface + token types** (`src/providers/auth/types.ts`) — extensible across providers.
2. **`OpenAIOAuthProvider` impl** (`src/providers/auth/openai-oauth.ts`) — Device-Code + PKCE against `auth.openai.com`; refresh + revoke.
3. **Token store** (`src/providers/auth/token-store.ts`) — keychain-first (`oauth:openai` account, JSON blob), file fallback at `~/.muonroi-cli/oauth-tokens.json` (mode 0600), enrolled in redactor.
4. **`keys login <provider>` CLI subcommand** in `src/cli/keys.ts` — opens browser, shows user code, polls until approved, persists tokens. Also `keys logout <provider>`.
5. **Adapter wiring** in `src/providers/adapter.ts` — when OAuth tokens present for OpenAI, build client with `Authorization: Bearer {access_token}` + `ChatGPT-Account-ID: {account_id}` instead of `sk-...` API key. Auto-refresh with mutex when token expires within 60s.
6. **Resolution priority update** in `src/providers/keychain.ts` — OAuth token → keychain API key → env → settings.json → `ProviderKeyMissingError`.
7. **Doctor + `keys list` integration** — show OAuth auth state (subscription account email if available, expiry, refresh status).
8. **Tests** — mock OAuth issuer (no live network), device-code poll flow, refresh-on-expired, mutex contention, fallback to API key when OAuth absent.

## Files to touch (estimated)

**New:**
- `src/providers/auth/types.ts` — `ProviderOAuth`, `OAuthTokens`
- `src/providers/auth/openai-oauth.ts` — `OpenAIOAuthProvider` impl
- `src/providers/auth/device-flow.ts` — generic device-code helpers (PKCE, poll loop)
- `src/providers/auth/token-store.ts` — keychain + file fallback
- `src/providers/auth/__tests__/openai-oauth.test.ts`
- `src/providers/auth/__tests__/token-store.test.ts`
- `src/providers/auth/__tests__/device-flow.test.ts`

**Modified:**
- `src/providers/keychain.ts` — extend `loadKeyForProvider` priority chain; export `getOAuthTokens()` helper
- `src/providers/adapter.ts` — conditional OAuth-vs-API-key client construction for OpenAI
- `src/providers/runtime.ts` — pass tokens through to adapter
- `src/cli/keys.ts` — `runKeysLogin()`, `runKeysLogout()`; extend `runKeysList()` to show OAuth state
- `src/index.ts` — register `keys login` / `keys logout` subcommands; first-run wizard offers OAuth as option 1
- `src/utils/redactor.ts` — ensure access_token / refresh_token enrolled

## Acceptance test

1. `muonroi-cli keys login openai` opens browser to `auth.openai.com` device URL, shows user_code, completes after approval, persists tokens to keychain.
2. After login, `muonroi-cli -p "ping" -m gpt-4o-mini` succeeds without any `OPENAI_API_KEY` set anywhere.
3. With both OAuth tokens **and** an API key in keychain, OAuth wins (verified by request inspection: `Authorization: Bearer ey...` not `sk-...`).
4. With only API key, behavior is identical to today (backward compat).
5. Forcing token expiry triggers refresh; mutex prevents double-refresh under concurrent requests.
6. `muonroi-cli keys logout openai` revokes refresh token and clears keychain entry.
7. `muonroi-cli keys list` shows OAuth state distinct from API key state for OpenAI row.
8. CI tests pass with mock issuer; no live `auth.openai.com` calls.

## Non-goals

- Anthropic / Google OAuth (interface ready, impl deferred)
- Multi-account switching per provider
- API-key-exchange grant (mint `sk-...` from subscription)
- FedRAMP header

## Open questions for /gsd-plan-phase

1. Use Codex's published `client_id` (legal since OSS) or register our own OpenAI OAuth client?
2. Token-store fallback file location: `~/.muonroi-cli/oauth-tokens.json` vs `~/.muonroi-cli/auth/openai.json` (one file per provider for future)?
3. Refresh-on-401 retry: handle in adapter fetch wrapper, or pre-emptive with `expiresAt - 60s` check?
4. Account ID + email surfacing: query `auth.openai.com/userinfo` after login for nicer UX in `keys list`?
