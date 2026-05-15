# Phase 18 — Manual Smoke Test Procedure

Covers acceptance items 1 and 6 (live browser flows that cannot be run in CI).

## Prerequisites

- A valid ChatGPT Plus, Pro, or Team subscription tied to your OpenAI account.
- `muonroi-cli` built locally: `bun run src/index.ts` should print usage.
- No `OPENAI_API_KEY` environment variable set (to prove OAuth-only path).

---

## Smoke 1 — Login (acceptance item 1)

```bash
# From the repo root:
bun run src/index.ts keys login openai
```

Expected output:
```
Logging in to openai via subscription OAuth...

  Visit: https://auth.openai.com/activate
  Code:  XXXX-XXXX

Waiting for browser approval...
```

1. Open the Visit URL in a browser, log in with your OpenAI account.
2. Enter the Code when prompted.
3. After approval, the CLI prints:
   ```
   Logged in to openai (you@email.com). Token expires: <date>
   Run 'muonroi-cli keys list' to verify.
   ```

Verify: `bun run src/index.ts keys list` shows an OAuth section with your email.

---

## Smoke 2 — Chat without API key (acceptance item 2)

```bash
# Ensure no API key env var is set:
unset OPENAI_API_KEY

bun run src/index.ts -p "Say: PONG" -m gpt-4o-mini
```

Expected: model responds with "PONG" (or similar). No `ProviderKeyMissingError`.

---

## Smoke 3 — OAuth takes priority over API key (acceptance item 3)

```bash
# Set a fake API key to ensure it doesn't override OAuth:
export OPENAI_API_KEY=sk-fake-0000000000000000000000000000

bun run src/index.ts -p "Say: PONG" -m gpt-4o-mini
```

Expected: still succeeds with OAuth (Bearer ey... headers), not the fake key.
If the fake key were used, the request would fail with 401.

---

## Smoke 4 — Logout (acceptance item 6)

```bash
bun run src/index.ts keys logout openai
```

Expected output:
```
Logged out of openai. OAuth tokens revoked and deleted.
```

After logout:
- `keys list` should NOT show an OAuth row for openai.
- Running `bun run src/index.ts -p "ping" -m gpt-4o-mini` without an API key set
  should now throw `ProviderKeyMissingError` (or use API key if one is in keychain).
