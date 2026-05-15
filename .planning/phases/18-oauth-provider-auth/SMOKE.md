# Phase 18 — Manual Smoke Test Procedure

Covers acceptance items that require live browser flows (cannot run in CI).

## Prerequisites

- A valid ChatGPT Plus, Pro, or Team subscription tied to your OpenAI account (for §1-4).
- A Google account with access to Gemini API (for §5-8).
- `muonroi-cli` built locally: `bun run src/index.ts` should print usage.

---

## OpenAI OAuth (Phase 18-01)

### Smoke 1 — Login (OpenAI)

```bash
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

### Smoke 2 — Chat without API key (OpenAI)

```bash
unset OPENAI_API_KEY
bun run src/index.ts -p "Say: PONG" -m gpt-4o-mini
```

Expected: model responds with "PONG" (or similar). No `ProviderKeyMissingError`.

---

### Smoke 3 — OAuth takes priority over API key (OpenAI)

```bash
export OPENAI_API_KEY=sk-fake-0000000000000000000000000000
bun run src/index.ts -p "Say: PONG" -m gpt-4o-mini
```

Expected: still succeeds with OAuth (Bearer ey... headers), not the fake key.
If the fake key were used, the request would fail with 401.

---

### Smoke 4 — Logout (OpenAI)

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
  should now throw `ProviderKeyMissingError`.

---

## Google Gemini OAuth (Phase 18-02)

### Smoke 5 — Login (Google)

```bash
bun run src/index.ts keys login google
```

Expected output:
```
Logging in to Google via OAuth...
A browser window will open. Sign in with your Google account.

Opening browser for Google sign-in...
(If the browser does not open, copy the URL from the terminal above.)

Waiting for authorization...
```

1. A browser window opens to `https://accounts.google.com/o/oauth2/v2/auth...`.
2. Sign in with your Google account and approve the permissions.
3. After approval, the browser shows "Authorization successful" and the CLI prints:
   ```
   Logged in to Google (you@gmail.com). Token expires: <date>
   Run 'muonroi-cli keys list' to verify.
   ```

Verify: `bun run src/index.ts keys list` shows an OAuth section with a `google` row.

---

### Smoke 6 — Chat without API key (Google Gemini)

```bash
unset GOOGLE_API_KEY
bun run src/index.ts -p "Say: PONG" -m gemini-1.5-flash
```

Expected: model responds with "PONG" (or similar). No `ProviderKeyMissingError`.
The request uses OAuth Bearer token injected by `createProviderFactoryAsync`.

---

### Smoke 7 — OAuth takes priority over API key (Google)

```bash
export GOOGLE_API_KEY=fake-key-0000000000000000000000000000
bun run src/index.ts -p "Say: PONG" -m gemini-1.5-flash
```

Expected: still succeeds with OAuth headers. If the fake key were used, the
request would fail.

---

### Smoke 8 — Logout (Google)

```bash
bun run src/index.ts keys logout google
```

Expected output:
```
Logged out of google. OAuth tokens revoked and deleted.
```

After logout:
- `keys list` should NOT show a `google` OAuth row.
- Running `bun run src/index.ts -p "ping" -m gemini-1.5-flash` without a
  GOOGLE_API_KEY should now throw `ProviderKeyMissingError`.

---

### Smoke 9 — OpenAI OAuth unaffected after Google changes

```bash
bun run src/index.ts keys login openai  # (if not already logged in)
bun run src/index.ts keys list          # shows both openai + google rows
bun run src/index.ts -p "Say: PONG" -m gpt-4o-mini
```

Expected: OpenAI OAuth still works after Phase 18-02 changes.
