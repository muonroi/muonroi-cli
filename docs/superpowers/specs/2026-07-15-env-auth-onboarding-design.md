# Env-based auth + frictionless onboarding — design

Date: 2026-07-15
Status: approved (design)
Branch: `feat/env-auth-onboarding`

## Problem

Two coupled problems, discovered while diagnosing a live auth failure.

1. **OAuth is shadowed by a stale API key.** A user who completed ChatGPT
   subscription OAuth for OpenAI still got
   `Incorrect API key provided: sk-proj-...F48A` when calling `gpt-5.4-mini`.
   Root cause is a **precedence bug**: a stored `sk-proj` key is resolved as
   `this.apiKey` *before* OAuth is ever considered, which then structurally
   suppresses the OAuth path.

   Evidence (traced this session):
   - `src/index.ts` (~1134-1145): boot resolves `resolveKeyForModel` /
     `getApiKey` **before** `hasOAuthForModel`.
   - `src/providers/keychain.ts:157-197` `loadKeyForProvider`: keychain → env
     `OPENAI_API_KEY` → `settings.providers.openai.apiKey` (any value ≥20 chars).
   - `src/orchestrator/orchestrator.ts:3835-3857` `_initOAuthProvider`:
     `if (!providerDeferred && !keyIsSentinelOrEmpty) return;` — a real key
     early-returns before OAuth headers are injected.
   - `src/orchestrator/message-processor.ts:1053-1054`: the cross-provider
     turn path builds the factory with the **sync** `createProviderFactory`
     (no OAuth injection) using the stored key. This is the exact line that
     shipped the `sk-proj` key to `api.openai.com`.
   - `src/providers/strategies/openai.strategy.ts:26-54`: endpoint fork is
     `isOAuth = !!opts.headers`; no headers → `api.openai.com/v1`.

2. **Auth storage + onboarding are too heavy.** OS keychain (`keytar`) is a
   native module that is painful to install and hard to integrate with
   external secret managers (e.g. Bitwarden `bw`). First run forces a
   3-option chooser (import / set API key / OAuth) before the user can reach
   chat.

## Goals

- OAuth wins over a stored API key for OAuth-capable providers (`openai`, `xai`).
- Remove the OS keychain concept entirely (`keytar`) and the `bw` import/export.
- API keys live in **OS environment variables**; the CLI reads them from
  `process.env`.
- First run lands **directly in chat**. Provider auth is configured
  **on demand** via a unified picker that auto-selects the right method
  (OAuth vs API key) per provider.

## Non-goals

- Changing the OAuth flows themselves (PKCE/browser flow stay as-is).
- Adding new providers or new OAuth integrations (OAuth stays `openai` + `xai`).
- Encrypting keys at rest with a passphrase (explicitly rejected — conflicts
  with "straight to chat").

## Storage model

### API keys → environment variables (single source of truth)

- **Read**: unchanged pattern — `process.env[ENV_BY_PROVIDER[provider]]`
  (e.g. `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`).
- **Canonical CLI store**: `~/.muonroi-cli/.env` (mode `0600`), auto-loaded
  into `process.env` at startup on **all** platforms. This guarantees the CLI
  always reads keys from env regardless of how the shell was launched.
  **Precedence: a variable already present in the real OS environment at launch
  is authoritative and is NOT overwritten by `.env`; `.env` only fills gaps**
  (so a key exported in the user's shell always wins over a stale `.env` line).
- **Write** (`persistEnvKey(provider, value)`):
  - Always upsert the `KEY=value` line in `~/.muonroi-cli/.env` **and** set
    `process.env[KEY]` in memory so the key is usable in the current session
    without a restart.
  - **Windows only**: additionally mirror to the User-scope registry env
    (`[Environment]::SetEnvironmentVariable(name, value, "User")`) so other OS
    processes/tools also see it (true OS env).
- **Delete** (`clearEnvKey(provider)`): remove the line from `.env`, delete
  `process.env[KEY]`, and on Windows clear the registry User value.

`.env` parsing/serialization is line-based (`KEY=value`, one per line, `#`
comments preserved). No third-party dotenv dependency required for write; a
minimal loader is acceptable at startup.

### OAuth tokens → file only

- `~/.muonroi-cli/auth/<provider>.json`, mode `0600` (already the fallback in
  `src/providers/auth/token-store.ts`). The keytar branch is deleted; the file
  path becomes the sole store.

### Removals

- `keytar` dependency (drop from `package.json`; kills native-module install
  pain across Windows/WSL).
- `src/providers/keychain.ts` keytar loader + all keychain read/write/list.
- `src/providers/auth/token-store.ts` keytar branch.
- `src/mcp/mcp-keychain.ts`, `src/chat/chat-keychain.ts`.
- `bw` import/export in `src/cli/keys.ts` (`spawnSync("bw", …)`).

### Migration (one-time, first run)

On startup, if the new `.env` has no key for a provider but a legacy source
does (OS keychain via keytar-if-present, or `settings.apiKey` /
`settings.providers.<p>.apiKey`), copy it into the new store (`.env` +
registry on Windows) and remove the legacy copy. Best-effort and idempotent;
never blocks startup. After keytar is removed from deps, the keychain read in
migration uses a dynamic `import("keytar").catch(() => null)` so a missing
module is a no-op.

## Piece 1 — OAuth beats stored API key

Three fix sites:

1. **Boot precedence** (`src/index.ts` ~1134-1145): for OAuth-capable
   providers, check `hasOAuthForModel(model)` **before**
   `resolveKeyForModel` / `loadKeyForProvider`. When OAuth tokens exist, set
   the `apiKey = "oauth"` sentinel so the OAuth path is chosen even if an env
   key is also present.
2. **`_initOAuthProvider`** (`src/orchestrator/orchestrator.ts:3835-3857`):
   when OAuth tokens exist for `this.providerId`, take the OAuth path
   regardless of a held real key. Remove the `!keyIsSentinelOrEmpty`
   early-return for OAuth-capable providers.
3. **Cross-provider turn** (`src/orchestrator/message-processor.ts:1053-1054`):
   replace the sync `createProviderFactory` with `createProviderFactoryAsync`
   (OAuth-aware — loads tokens, injects codex headers + baseURL). Pass the env
   key only as a fallback for non-OAuth providers.

Precedence after fix, per provider: **OAuth token (if present, for
OAuth-capable providers) → env API key → wizard/picker**.

## Piece 2 — Provider picker (on-demand auth)

Unified picker, reachable as `/providers` (existing screen extended) and alias
`/login`:

- Lists all providers with current auth status (env key set / OAuth logged in /
  none).
- Selecting a provider:
  - **OAuth-capable** (`openai`, `xai`): OAuth (open browser) is the primary
    action; "paste API key instead" is a secondary action.
  - **Others**: API-key input.
- On success:
  - API key → `persistEnvKey(provider, value)`.
  - OAuth → existing `login()` flow → `saveTokens(provider, …)` (file store).
  - The active session picks up the credential immediately (in-memory
    `process.env` / provider re-init).
- `keys login` clears any conflicting env API key for that provider after a
  successful OAuth (so OAuth can't be re-shadowed).

## Piece 3 — Frictionless first run

- Remove the forced first-run gate: no mandatory api-key modal, no 3-option
  chooser. A fresh install boots **straight into chat**.
- **No-auth send**: if the user sends a message and no usable credential exists
  for the target model's provider, auto-open the provider picker and **hold**
  the pending message; after the user connects, replay the held message.
- The `esc`-to-hide behavior on the old modal is superseded by the picker being
  fully optional/dismissable.

## Error handling

- `.env` load failure at startup (corrupt file): log a redacted warning, treat
  as "no keys from file" (env from the actual OS environment still applies),
  never crash.
- `persistEnvKey` registry write failure on Windows: the `.env` + in-memory
  write already succeeded, so the key works this and future CLI sessions; log a
  debug note that OS-wide mirroring failed. (No silent catch — log with
  module + message per repo rule.)
- Migration read failure (locked keyring / missing keytar): swallow to a debug
  log and continue; migration is best-effort.
- 401 on the API-key path for an OAuth-capable provider: humanized message
  continues to point at `keys login` / the picker.

## Testing

- **Unit**:
  - `persistEnvKey` / `clearEnvKey`: `.env` upsert/remove round-trip in a temp
    `HOME`; in-memory `process.env` mutation; Windows registry mirror mocked.
  - Startup `.env` loader: precedence (real OS env wins over `.env`? or `.env`
    wins? — spec decision: real process env present at launch is authoritative;
    `.env` only fills gaps).
  - `loadKeyForProvider` simplified to env-only: returns env value, throws
    `ProviderKeyMissingError` when unset.
  - Precedence: with both an env key and OAuth tokens for `openai`,
    resolution selects OAuth (all three fix sites).
  - Migration: legacy `settings.apiKey` → `.env`, legacy copy removed.
- **Harness (self-verify / tests/harness)**:
  - Fresh cwd, no auth → boots into chat (no forced modal).
  - `/providers` picker: OAuth-capable provider offers OAuth + API-key; other
    provider offers API-key only.
  - No-auth send auto-opens the picker and replays the message after a
    (mock) credential is set.
- **Pre-push gate**: full `bunx vitest run` green; harness suite for the UI
  surfaces touched (picker modal, app wiring).

## Rollout / compatibility

- Existing users with keychain/settings keys are auto-migrated on first run of
  the new build — no manual re-entry.
- `OPENAI_API_KEY` etc. set directly in the user's shell continue to work
  (they are just OS env, which is now the canonical source).
- Removing `keytar` changes the install footprint (no native build step).
