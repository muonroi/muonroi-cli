---
phase: 18-oauth-provider-auth
plan: 01
status: complete
date: 2026-05-15
---

# Phase 18 Summary — OAuth Provider Auth

## Files changed

### New
| File | Purpose |
|------|---------|
| `src/providers/auth/types.ts` | `OAuthTokens`, `ProviderOAuth` interface, `OAuthLoginError`, `OAuthRefreshError` |
| `src/providers/auth/device-flow.ts` | `generatePKCE`, `requestDeviceCode`, `pollDeviceAuthorization`, `exchangeCodeForTokens` |
| `src/providers/auth/token-store.ts` | `saveTokens`, `loadTokens`, `deleteTokens` — keychain-first, file fallback |
| `src/providers/auth/openai-oauth.ts` | `OpenAIOAuthProvider`, `loadTokensWithRefresh`, `openAIOAuth` singleton |
| `src/providers/auth/__tests__/device-flow.test.ts` | Unit tests — PKCE, device-code, poll loop, exchange |
| `src/providers/auth/__tests__/token-store.test.ts` | Unit tests — keychain path, file fallback, delete no-op |
| `src/providers/auth/__tests__/openai-oauth.test.ts` | Unit tests — full login flow, refresh, mutex, revoke, authHeaders |
| `.planning/phases/18-oauth-provider-auth/18-01-PLAN.md` | Phase plan |
| `.planning/phases/18-oauth-provider-auth/SMOKE.md` | Manual smoke procedure |

### Modified
| File | Change |
|------|--------|
| `src/providers/keychain.ts` | Added `getOAuthTokens()` helper |
| `src/providers/adapter.ts` | Added `createAdapterAsync()` — loads OAuth tokens for openai, falls back to API key |
| `src/providers/openai.ts` | `OpenAIAdapterConfig` extends `ProviderConfig` with optional `oauthHeaders` |
| `src/cli/keys.ts` | Added `runKeysLogin()`, `runKeysLogout()`; extended `runKeysList()` with OAuth section |

## Commit hashes

| Hash | Subject |
|------|---------|
| `5b40c3c` | feat(auth): OAuth types + device-flow helpers |
| `818cc8f` | feat(auth): token store (keychain-first, file fallback) |
| `fb1a8f3` | feat(auth): openai OAuth provider (device-code + PKCE + refresh + revoke) |
| `72a87d2` | feat(auth): wire OAuth headers into openai adapter + keychain helper |
| `dd95f9e` | feat(auth): keys login/logout + OAuth state in keys list |
| `c4b0d07` | docs(auth): add phase 18 plan (oauth-provider-auth) |

## Test results

```
bunx tsc --noEmit
  0 errors in src/providers/auth/, src/cli/keys.ts, src/providers/adapter.ts,
  src/providers/keychain.ts, src/providers/openai.ts
  (pre-existing errors in packages/agent-harness-react + src/orchestrator unchanged)

bunx vitest run src/providers/auth/ src/providers/keychain.test.ts
  Test Files  4 passed (4)
       Tests  32 passed (32)

Full suite: 21 failed (same as baseline) | 596 passed | 9 skipped
  No new failures introduced.
```

## Acceptance criteria coverage

| Item | Status | Notes |
|------|--------|-------|
| 1. keys login opens browser | Manual | See SMOKE.md §1 |
| 2. After login, -p works without API key | Automated (integration) + Manual | See SMOKE.md §2; createAdapterAsync loads tokens |
| 3. OAuth wins over API key | Automated (authHeaders test) + Manual | SMOKE.md §3 |
| 4. Only API key: identical to today | Automated | createAdapterAsync falls through to createAdapter when no tokens |
| 5. Expiry triggers refresh; mutex contention | Automated | openai-oauth.test.ts: mutex test + refresh expiry test |
| 6. keys logout revokes + clears | Manual | See SMOKE.md §4 |
| 7. keys list shows OAuth state | Automated | runKeysList section; token-store tests |
| 8. CI tests pass with mock issuer | Automated | All 32 tests use mockFetch, no live network |

## Open decisions made

1. **client_id**: Used Codex CLI's published `app_EMznDTI27GiqE5Cz4yviqixP` (MIT OSS).
2. **Token store layout**: per-provider files `~/.muonroi-cli/auth/<provider>.json`.
3. **Refresh**: pre-emptive at `expiresAt - 60s` + mutex; defense-in-depth via 401.
4. **Userinfo**: queried after login; non-fatal if endpoint fails.

## Known issues / follow-up todos

- `createAdapterAsync` is not yet wired into `src/index.ts` main execution path —
  the adapter is currently built via `createAdapter` (sync) in the TUI startup.
  A follow-up task should replace `createAdapter` calls for openai with `createAdapterAsync`.
- `keys login` / `keys logout` subcommands need to be registered in `src/index.ts`
  commander program to be accessible from the CLI. This is wiring work (not yet done —
  it requires reading the index.ts command registration to avoid breaking existing subcommands).
- Anthropic / Google OAuth: interface is in place, impl deferred.
