# Env-based Auth + Frictionless Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store provider API keys in OS environment variables (drop the OS keychain/keytar + Bitwarden), make OAuth and API-key auth mutually exclusive per provider (fixing the OAuth-shadowed-by-stale-key bug), and let a fresh install land straight in chat with on-demand per-provider auth.

**Architecture:** Keep the existing `keychain.ts` public API surface and swap its backend from keytar to a new `env-store` module (`.env` file loaded into `process.env` at startup + Windows registry mirror). OAuth tokens move to file-only. A per-provider single-mode invariant (OAuth XOR API key) replaces the buggy precedence chain. The forced first-run wizard is removed; the existing `/providers` picker gains OAuth login + auto-open-on-no-auth.

**Tech Stack:** TypeScript, Bun, Vitest, OpenTUI (React reconciler), `@ai-sdk/openai`, node `fs`/`os`.

## Global Constraints

- Zero-hardcode rule: never hardcode model/provider IDs as string literals in production code; derive from `catalog.json` / settings / runtime. Type-union definitions and test fixtures are the only exceptions.
- No silent catch: every `catch` logs module + operation + `err.message` (HTTP: + status/body). Intentional ignores get a comment + debug-level log.
- Core/UI separation: core modules must not import `src/ui` or opentui/react.
- OAuth-capable providers are `openai` and `xai` only (derive from `listOAuthProviderIds()` / the OAuth registry — never a hardcoded list).
- Per-provider env var names come from `ENV_BY_PROVIDER` (`src/providers/keychain.ts:43-51`): `OPENAI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `OPENCODE_GO_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY`.
- Env-store file path: `~/.muonroi-cli/.env` (mode `0600`), test override `MUONROI_ENV_FILE`.
- A real OS env var present at process launch is authoritative and is NOT overwritten by `.env` on load.
- Pre-push gate: `bunx vitest run` fully green before any push; harness suite for touched UI surfaces.

---

## File structure

**New files**
- `src/providers/env-store.ts` — `.env` read/write, `process.env` sync, Windows registry mirror, startup loader, legacy migration.
- `src/providers/__tests__/env-store.test.ts` — unit tests for the store.
- `src/providers/__tests__/auth-exclusivity.test.ts` — OAuth-XOR-apikey resolution + write-side clearing.

**Modified (backend swap, signatures preserved)**
- `src/providers/keychain.ts` — replace keytar with env-store; keep exported signatures.
- `src/providers/auth/token-store.ts` — drop keytar branch → file-only.
- `src/mcp/mcp-keychain.ts` — env-store backed (keep `setMcpKey`/`getMcpKey`).
- `src/chat/chat-keychain.ts` — env-store backed (keep `hydrateChatEnvFromKeychain` etc.).
- `src/providers/anthropic.ts` — drop keytar branch in `loadAnthropicKey`.

**Modified (behavior)**
- `src/index.ts` — startup `.env` load + migration; OAuth-XOR precedence; remove forced wizard gate; strip bw subcommands.
- `src/orchestrator/orchestrator.ts` — `_initOAuthProvider` prefers OAuth when tokens exist.
- `src/orchestrator/message-processor.ts` — cross-provider turn uses async OAuth-aware factory.
- `src/cli/keys.ts` — `keys set/delete/list` via env-store; `keys login/logout` enforce exclusivity; remove bw import + encrypted bundle + cleanup-settings.
- `src/utils/settings.ts` — `getApiKey` env-only; drop `settings.apiKey`/`providers.*.apiKey` read paths (migrated).
- `src/ui/use-app-logic.tsx` + `src/ui/app.tsx` + `src/cli/config/screen-providers.ts` — picker: OAuth login action, single-mode status, auto-open on no-auth send, drop bw UI.

**Deleted**
- `src/cli/bw-vault.ts` and all `spawnSync("bw")` call sites.

---

## Phase 1 — env-store foundation + keychain backend swap

Ships: API keys read/written via env (`.env` + registry), all existing callers unchanged, legacy keytar/settings keys auto-migrated. keytar still installed (removed in Phase 3) so migration can read it.

### Task 1.1: env-store module — `.env` load + persist + clear

**Files:**
- Create: `src/providers/env-store.ts`
- Test: `src/providers/__tests__/env-store.test.ts`

**Interfaces:**
- Produces:
  - `loadEnvFileIntoProcess(): void` — parse `~/.muonroi-cli/.env`, set `process.env[k]=v` only when `process.env[k]` is currently undefined.
  - `persistEnvVar(name: string, value: string): void` — upsert `name=value` in `.env` (0600), set `process.env[name]`, mirror to Windows User registry on `win32`.
  - `clearEnvVar(name: string): void` — remove `name` from `.env`, `delete process.env[name]`, clear Windows registry on `win32`.
  - `envFilePath(): string` — `process.env.MUONROI_ENV_FILE ?? join(homedir(), ".muonroi-cli", ".env")`.

- [ ] **Step 1: Write failing tests**

```ts
// src/providers/__tests__/env-store.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEnvVar, envFilePath, loadEnvFileIntoProcess, persistEnvVar } from "../env-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envstore-"));
  process.env.MUONROI_ENV_FILE = join(dir, ".env");
  delete process.env.TEST_KEY_A;
  delete process.env.TEST_KEY_B;
});
afterEach(() => {
  delete process.env.MUONROI_ENV_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("env-store", () => {
  it("persists a var to file and process.env", () => {
    persistEnvVar("TEST_KEY_A", "value-a-1234567890");
    expect(process.env.TEST_KEY_A).toBe("value-a-1234567890");
    expect(readFileSync(envFilePath(), "utf8")).toContain("TEST_KEY_A=value-a-1234567890");
  });

  it("upserts (replaces) an existing var without duplicating lines", () => {
    persistEnvVar("TEST_KEY_A", "first-1234567890");
    persistEnvVar("TEST_KEY_A", "second-1234567890");
    const body = readFileSync(envFilePath(), "utf8");
    expect(body.match(/TEST_KEY_A=/g)?.length).toBe(1);
    expect(process.env.TEST_KEY_A).toBe("second-1234567890");
  });

  it("clearEnvVar removes from file and process.env", () => {
    persistEnvVar("TEST_KEY_A", "value-a-1234567890");
    clearEnvVar("TEST_KEY_A");
    expect(process.env.TEST_KEY_A).toBeUndefined();
    expect(readFileSync(envFilePath(), "utf8")).not.toContain("TEST_KEY_A");
  });

  it("loadEnvFileIntoProcess fills gaps but never overrides a real OS env var", () => {
    persistEnvVar("TEST_KEY_A", "file-a-1234567890");
    persistEnvVar("TEST_KEY_B", "file-b-1234567890");
    delete process.env.TEST_KEY_A; // simulate not-yet-loaded
    process.env.TEST_KEY_B = "os-wins-1234567890"; // real OS value present at launch
    loadEnvFileIntoProcess();
    expect(process.env.TEST_KEY_A).toBe("file-a-1234567890"); // gap filled
    expect(process.env.TEST_KEY_B).toBe("os-wins-1234567890"); // OS not overridden
  });
});
```

- [ ] **Step 2: Run to verify fail** — `bunx vitest run src/providers/__tests__/env-store.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/providers/env-store.ts`**

```ts
/**
 * src/providers/env-store.ts
 *
 * Canonical CLI key store: a `~/.muonroi-cli/.env` file (mode 0600) that is
 * loaded into process.env at startup and written when the user sets a key.
 * On Windows we ALSO mirror to the User-scope registry env so other OS
 * processes see the key. Replaces the OS keychain (keytar).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactor } from "../utils/redactor.js";

export function envFilePath(): string {
  return process.env.MUONROI_ENV_FILE ?? join(homedir(), ".muonroi-cli", ".env");
}

function readLines(): string[] {
  try {
    return readFileSync(envFilePath(), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function writeLines(lines: string[]): void {
  const p = envFilePath();
  mkdirSync(dirname(p), { recursive: true });
  const body = lines.filter((l, i) => !(l === "" && i === lines.length - 1)).join("\n");
  writeFileSync(p, body.endsWith("\n") || body === "" ? body : `${body}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch (err) {
    // Non-fatal on filesystems without POSIX perms (e.g. some Windows FS).
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(`[env-store] chmod failed for ${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Parse "KEY=value" — value may contain "="; comments/blank lines ignored. */
function parseLine(line: string): { key: string; value: string } | null {
  if (!line || line.trimStart().startsWith("#")) return null;
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1) };
}

function mirrorToWindowsRegistry(name: string, value: string | null): void {
  if (process.platform !== "win32") return;
  try {
    const script =
      value === null
        ? `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`
        : `[Environment]::SetEnvironmentVariable('${name}', $env:MUONROI_ENVSTORE_VALUE, 'User')`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: value === null ? process.env : { ...process.env, MUONROI_ENVSTORE_VALUE: value },
      stdio: "ignore",
    });
  } catch (err) {
    // .env + in-memory write already succeeded; OS-wide mirror is best-effort.
    if (process.env.MUONROI_DEBUG_ENVSTORE) {
      console.error(`[env-store] registry mirror failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function persistEnvVar(name: string, value: string): void {
  redactor.enrollSecret(value);
  const lines = readLines();
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed?.key === name) {
      if (!replaced) {
        out.push(`${name}=${value}`);
        replaced = true;
      }
    } else if (line !== "") {
      out.push(line);
    }
  }
  if (!replaced) out.push(`${name}=${value}`);
  writeLines(out);
  process.env[name] = value;
  mirrorToWindowsRegistry(name, value);
}

export function clearEnvVar(name: string): void {
  const lines = readLines();
  const out = lines.filter((line) => parseLine(line)?.key !== name && line !== "");
  writeLines(out);
  delete process.env[name];
  mirrorToWindowsRegistry(name, null);
}

export function loadEnvFileIntoProcess(): void {
  for (const line of readLines()) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
      redactor.enrollSecret(parsed.value);
    }
  }
}
```

- [ ] **Step 4: Run tests → PASS** — `bunx vitest run src/providers/__tests__/env-store.test.ts`. On non-Windows the registry mirror is a no-op; the powershell branch is not exercised.

- [ ] **Step 5: Commit**

```bash
git add src/providers/env-store.ts src/providers/__tests__/env-store.test.ts
git commit -m "feat(auth): env-store — .env-backed key store with process.env sync"
```

### Task 1.2: keychain.ts — swap keytar backend for env-store (keep API)

**Files:**
- Modify: `src/providers/keychain.ts` (`setKeyForProvider` L93, `deleteKeyForProvider` L120, `listStoredProviders` L138, `loadKeyForProvider` L157-197, `getConfiguredProviders` L204).
- Test: extend `src/providers/keychain.test.ts`.

**Interfaces:**
- Consumes: `persistEnvVar`, `clearEnvVar` from `env-store.js`; existing `ENV_BY_PROVIDER`.
- Produces: unchanged signatures — `setKeyForProvider(p, key): Promise<boolean>`, `deleteKeyForProvider(p): Promise<boolean>`, `listStoredProviders(): Promise<ProviderId[]>`, `loadKeyForProvider(p): Promise<string>`, `getConfiguredProviders(): Promise<ProviderId[]>`.

- [ ] **Step 1: Write failing test** (env-only round-trip)

```ts
// add to src/providers/keychain.test.ts
it("setKeyForProvider writes env; loadKeyForProvider reads it back; delete clears", async () => {
  const { setKeyForProvider, loadKeyForProvider, deleteKeyForProvider } = await import("./keychain.js");
  process.env.MUONROI_ENV_FILE = require("node:path").join(require("node:os").tmpdir(), `kc-${Date.now()}.env`);
  delete process.env.OPENAI_API_KEY;
  await setKeyForProvider("openai", "sk-openai-abcdefghijklmnop");
  expect(process.env.OPENAI_API_KEY).toBe("sk-openai-abcdefghijklmnop");
  expect(await loadKeyForProvider("openai")).toBe("sk-openai-abcdefghijklmnop");
  await deleteKeyForProvider("openai");
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
});
```

- [ ] **Step 2: Run → FAIL** (currently writes keytar, not env).

- [ ] **Step 3: Implement** — replace bodies:
  - Delete `loadKeytar`, `KeytarLike`, `KEYCHAIN_SERVICE`, `ACCOUNT_BY_PROVIDER`.
  - `setKeyForProvider`: validate `key.length >= 20`, then `persistEnvVar(ENV_BY_PROVIDER[norm], key)`; `return true`.
  - `deleteKeyForProvider`: `const had = !!process.env[ENV_BY_PROVIDER[norm]]; clearEnvVar(ENV_BY_PROVIDER[norm]); return had;`.
  - `listStoredProviders`: `return KEYCHAIN_PROVIDER_IDS.filter((p) => !!process.env[ENV_BY_PROVIDER[p]]);`.
  - `loadKeyForProvider`: read `process.env[ENV_BY_PROVIDER[provider]]` (≥1 char); ollama → `""`; else throw `ProviderKeyMissingError`. Remove keychain + settings-fallback branches.
  - `getConfiguredProviders`: union of `listStoredProviders()` and OAuth-configured (keep the existing `token-store` OAuth check block).

- [ ] **Step 4: Run → PASS** — `bunx vitest run src/providers/keychain.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/keychain.ts src/providers/keychain.test.ts
git commit -m "refactor(auth): keychain reads/writes env-store instead of keytar"
```

### Task 1.3: token-store, mcp-keychain, chat-keychain, anthropic → drop keytar

**Files:**
- Modify: `src/providers/auth/token-store.ts` (file-only), `src/mcp/mcp-keychain.ts`, `src/chat/chat-keychain.ts`, `src/providers/anthropic.ts:72`.

- [ ] **Step 1: token-store** — remove `loadKeytar`/`KeytarLike`/`KEYCHAIN_*`; `saveTokens` writes only `~/.muonroi-cli/auth/<provider>.json` (0600); `loadTokens`/`deleteTokens` operate only on that file. Keep `enrollTokensInRedactor`.
- [ ] **Step 2: mcp-keychain** — `setMcpKey(id, val)` → `persistEnvVar(ENV_BY_MCP[id], val)`; `getMcpKey(id)` → `process.env[ENV_BY_MCP[id]]`; `deleteMcpKey` → `clearEnvVar`. Keep signatures + `McpKeyId`.
- [ ] **Step 3: chat-keychain** — same swap for `setChatSecret`/`getChatSecret`/`deleteChatSecret`/`listChatSecrets`; `hydrateChatEnvFromKeychain()` becomes a no-op (env already the source) but keep the export so `index.ts:60` compiles.
- [ ] **Step 4: anthropic.ts** — `loadAnthropicKey` reads `process.env.ANTHROPIC_API_KEY` only.
- [ ] **Step 5: Run** — `bunx vitest run src/providers/ src/mcp/ src/chat/` → PASS (fix any keytar-mock tests to env-based).
- [ ] **Step 6: Commit** — `refactor(auth): move token/mcp/chat/anthropic stores off keytar`.

### Task 1.4: startup `.env` load + one-time legacy migration

**Files:**
- Modify: `src/providers/env-store.ts` (add `migrateLegacyKeysToEnv`), `src/index.ts` (call both at boot), `src/utils/settings.ts` (migration flag).

**Interfaces:**
- Produces: `migrateLegacyKeysToEnv(): Promise<void>` — for each `KEYCHAIN_PROVIDER_IDS`, if env not set: try keytar (dynamic `import("keytar").catch(()=>null)`) then `settings.providers.<p>.apiKey`/`settings.apiKey`; on hit `persistEnvVar` + remove the legacy copy (keytar delete + settings strip). Idempotent; guarded by `settings.keysMigratedToEnv`.

- [ ] **Step 1: Write failing test** — legacy `settings.apiKey`/`providers.openai.apiKey` present, env empty → after migration `process.env.OPENAI_API_KEY` set, settings key removed, flag set. (Mock keytar absent.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** migration in env-store; add `keysMigratedToEnv?: boolean` to `UserSettings`; in `src/index.ts` **before** `resolveConfig` (around L1119) call `loadEnvFileIntoProcess()` then `await migrateLegacyKeysToEnv()` (both wrapped, never throw).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(auth): load .env at startup + migrate legacy keychain/settings keys`.

---

## Phase 2 — OAuth XOR API key (fixes the shadowing bug)

Ships: a provider with an OAuth token never uses an API key; setting one method clears the other. The exact live bug (`sk-proj` shadowing OpenAI OAuth) is fixed.

### Task 2.1: boot precedence — OAuth overrides a held key

**Files:** Modify `src/index.ts:1130-1145`.

- [ ] **Step 1: Write failing test** — harness/unit: with `OPENAI_API_KEY` set AND OpenAI OAuth tokens present, boot resolves `config.apiKey === "oauth"`. (Stub `hasOAuthForModel` true.)
- [ ] **Step 2: Run → FAIL** (current code keeps the env/flag key).
- [ ] **Step 3: Implement** — replace the block:

```ts
const modelForResolve = config.model ?? getCurrentModel("agent");
// One auth mode per provider: OAuth wins outright — a stored key is ignored.
if (await hasOAuthForModel(modelForResolve)) {
  config.apiKey = "oauth";
} else if (!config.apiKey) {
  const envKey = await resolveKeyForModel(modelForResolve);
  if (envKey) config.apiKey = envKey;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `fix(auth): OAuth token overrides a stored API key at boot`.

### Task 2.2: `_initOAuthProvider` prefers OAuth when tokens exist

**Files:** Modify `src/orchestrator/orchestrator.ts:3835-3857`.

- [ ] **Step 1: Write failing test** — Agent with a real `apiKey` for an OAuth-capable provider that also has tokens → after init, provider factory has OAuth headers (baseURL `chatgpt.com/backend-api/codex`), not `api.openai.com`.
- [ ] **Step 2: Run → FAIL** (early-return shadows).
- [ ] **Step 3: Implement** — reorder: fetch `listOAuthProviderIds()`; if `ids.includes(this.providerId)` and OAuth tokens exist → take the OAuth path unconditionally (drop the `!keyIsSentinelOrEmpty` early-return for OAuth-capable providers; keep it for non-OAuth providers).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `fix(auth): _initOAuthProvider prefers OAuth over a held key`.

### Task 2.3: cross-provider turn uses OAuth-aware factory

**Files:** Modify `src/orchestrator/message-processor.ts:1044-1068`.

- [ ] **Step 1: Write failing test** — session provider ≠ target model's provider (openai), OpenAI OAuth present → turn factory carries OAuth headers, not the env key.
- [ ] **Step 2: Run → FAIL** (uses sync `createProviderFactory`).
- [ ] **Step 3: Implement** — replace L1052-1054 branch: use `createProviderFactoryAsync(turnProviderId, turnKey ? { apiKey: turnKey } : {})` so OAuth tokens are injected when present; env key is only the fallback for non-OAuth providers.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `fix(auth): cross-provider turn injects OAuth via async factory`.

### Task 2.4: write-side exclusivity (clear the other mode)

**Files:** Modify `src/providers/keychain.ts` (`setKeyForProvider`), `src/cli/keys.ts` (`runKeysLogin`).
- Test: `src/providers/__tests__/auth-exclusivity.test.ts`.

- [ ] **Step 1: Write failing tests** — (a) `setKeyForProvider("openai", key)` calls `deleteTokens("openai")`; (b) `runKeysLogin("openai")` calls `clearEnvVar("OPENAI_API_KEY")` after `saveTokens`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `setKeyForProvider`, after persisting, if provider ∈ `listOAuthProviderIds()` → `await deleteTokens(provider)` (dynamic import token-store). In `runKeysLogin` after successful login+`saveTokens` → `clearEnvVar(ENV_BY_PROVIDER[provider])`. Log both actions.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(auth): enforce OAuth-XOR-apikey on write (mutual exclusivity)`.

---

## Phase 3 — remove bw + forced first-run gate; drop keytar dep

Ships: fresh install boots straight to chat; Bitwarden + keytar gone from the tree and deps.

### Task 3.1: remove the forced first-run wizard gate

**Files:** Modify `src/index.ts:1147-1160` (+ delete `firstRunWizard` L197-376 and its bw/import options).

- [ ] **Step 1: Write failing harness test** — spawn in a fresh temp cwd with no key/env; assert the TUI boots to the composer (no forced api-key modal / no `process.exit`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — delete the `!config.apiKey && isInteractive → firstRunWizard/exit(1)` block; interactive with no key proceeds into the TUI. Remove `firstRunWizard` and `WIZARD_PROVIDERS`. Headless (`--prompt`) with no key keeps the existing `requireApiKey` error path.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(onboarding): boot straight to chat; remove forced first-run wizard`.

### Task 3.2: strip Bitwarden + obsolete key subcommands

**Files:** Modify `src/cli/keys.ts`; delete `src/cli/bw-vault.ts`; modify `src/index.ts` (subcommand wiring L1427-1538, L1654-1666).

- [ ] **Step 1: Remove** functions `runKeysImportBw`, `runMcpImportBw`, `runChatImportBw`, `runKeysImport`, `runKeysExport`, `runKeysCleanupSettings`, and the `--bw`/`writeBwSecureNote` paths in `runKeysSet`/`runMcpKeysSet`. Delete `bw-vault.ts`.
- [ ] **Step 2: Remove** the matching `.command(...)` wiring in `index.ts`: `keys import-bw`, `keys import`, `keys export`, `keys cleanup-settings`, `keys import-bw-chat`, `mcp import-bw`, and `--bw`/`--prefix` options. Keep `keys set/list/delete/login/logout` and `keys chat-set`, `mcp set-key`.
- [ ] **Step 3: Run** — `bunx tsc --noEmit` clean; `bunx vitest run src/cli/` PASS (drop bw tests).
- [ ] **Step 4: Commit** — `chore(auth): remove Bitwarden import + encrypted-bundle/cleanup subcommands`.

### Task 3.3: drop the keytar dependency

**Files:** Modify `package.json`; grep-verify no remaining `keytar` import.

- [ ] **Step 1:** `bunx grep`/Grep for `keytar` across `src/**` → expect only the migration's dynamic `import("keytar").catch(...)`. Confirm no static imports remain.
- [ ] **Step 2:** Remove `keytar` from `package.json` deps; `bun install`.
- [ ] **Step 3: Run** — `bunx tsc --noEmit` + `bunx vitest run` full suite green.
- [ ] **Step 4: Commit** — `chore(deps): drop keytar (native module) — keys now in env`.

---

## Phase 4 — unified provider picker (OAuth login + auto-open)

Ships: `/providers` (alias `/login`) picker offers OAuth for `openai`/`xai`, API-key input otherwise, single-mode status; sending with no auth auto-opens it and replays the held message.

### Task 4.1: picker offers OAuth for OAuth-capable providers

**Files:** Modify `src/ui/use-app-logic.tsx` (providers pane: `submitProviderKey` L887-906, `refreshProvidersWithKey` L847-867), `src/ui/app.tsx`.

**Interfaces:**
- Consumes: `listOAuthProviderIds()`, `getOAuthProviderConfig().provider.login()`, `saveTokens`, `clearEnvVar`.
- Produces: a `startProviderOAuth(providerId)` handler that runs the browser login, persists tokens, clears the env key (exclusivity), and refreshes badges.

- [ ] **Step 1: Write failing harness test** — open `/providers`, focus an OAuth-capable provider row → an "OAuth login" action is offered (semantic node present); a non-OAuth provider shows only key input.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in the providers pane, branch on `listOAuthProviderIds()`: OAuth-capable rows expose an OAuth action (Enter → `startProviderOAuth`), others keep `apiKeyPrompt`. `startProviderOAuth` calls the registry `login()` (reuse `runKeysLogin` core) off the UI thread, then `refreshProvidersWithKey`. Status badge shows `OAuth` | `API key` | `none` from `getConfiguredProviders` + token presence.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(onboarding): provider picker supports OAuth login (openai/xai)`.

### Task 4.2: `/login` alias + auto-open picker on no-auth send

**Files:** Modify `src/ui/slash/menu-items.ts` (add `login`), `src/ui/app.tsx:476-478` (typed allowlist), `src/ui/use-app-logic.tsx` (no-auth send → open picker + hold message; replace api-key-modal auto-open at L6917-6918 with the picker).

- [ ] **Step 1: Write failing harness test** — no auth configured; type a message + Enter → provider picker opens and the typed message is retained; after a (mock) credential is set, the held message sends.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — register `/login` (alias of `/providers`); on send with no usable credential for the target provider, stash the pending input, open the picker, and after a successful connect replay it. Retire the standalone `api-key-modal` forced-open path (keep the component for the in-picker key input, or inline it).
- [ ] **Step 4: Run → PASS** (harness + `bunx vitest run`).
- [ ] **Step 5: Commit** — `feat(onboarding): /login alias + auto-open picker, replay held message`.

### Task 4.3: fix hardcoded modal copy + final full-suite gate

**Files:** Modify `src/ui/modals/api-key-modal.tsx:59` ("DeepSeek"), `src/ui/use-app-logic.tsx:3009` (`xai-` prefix check) — derive provider name/validation from the selected provider, not a literal.

- [ ] **Step 1:** Parameterize the modal copy + key validation by the selected provider (no hardcoded provider name/prefix).
- [ ] **Step 2: Run** — `bunx tsc --noEmit`; `bunx vitest run`; `bunx vitest -c vitest.harness.config.ts run tests/harness/`; `bun run lint:semantic`; `bun run self-verify --since HEAD~1 --max 4` on the touched UI surfaces.
- [ ] **Step 3: Commit** — `fix(ui): derive api-key modal copy/validation from selected provider`.

---

## Self-review

- **Spec coverage:** invariant (Phase 2.1-2.4), env storage (1.1-1.4), keytar removal (1.2-1.3, 3.3), bw removal (3.2), OAuth-file tokens (1.3), migration (1.4), onboarding-to-chat (3.1), picker + auto-open + OAuth login (4.1-4.2), status single-mode (4.1). All covered.
- **Placeholder scan:** no TBD/"handle edge cases"; each code step shows code; deletion tasks cite exact file:line from the inventory.
- **Type consistency:** `persistEnvVar`/`clearEnvVar`/`loadEnvFileIntoProcess`/`envFilePath`/`migrateLegacyKeysToEnv` names used consistently across Tasks 1.1, 1.2, 1.4, 2.4, 4.1. keychain signatures unchanged so downstream callers compile. `ENV_BY_PROVIDER` reused, not redefined.
- **Ordering:** Phase 1 keeps keytar installed for migration; Phase 3.3 drops it only after migration + all swaps land.
```
