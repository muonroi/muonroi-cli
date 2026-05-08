# MCP Research Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `context7`, `fetch`, and `tavily` MCP servers to muonroi-cli so the agent can research the internet during implement/debug/debate, with a first-run wizard and migration prompt for the Tavily API key.

**Architecture:** Reuse the existing MCP runtime (`src/mcp/runtime.ts`). Append three servers to `DEFAULT_CONFIGS` in `src/mcp/auto-setup.ts`. Add a `webResearchPrompted` flag to user settings. Create a new `src/mcp/research-onboarding.ts` module with two entry points — one for the first-run wizard and one for the migration prompt — both reading and writing the Tavily key via a thin `src/mcp/mcp-keychain.ts` wrapper around `keytar` (modeled on `providers/keychain.ts`). No changes to runtime, tools registry, PIL, or council.

**Tech Stack:** TypeScript, `@ai-sdk/mcp`, `@modelcontextprotocol/sdk`, `keytar`, Node `readline` (matching the existing `firstRunWizard`), `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-05-08-mcp-research-integration-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/utils/settings.ts` | Modify | Add `webResearchPrompted?: boolean` to `UserSettings`. |
| `src/mcp/mcp-keychain.ts` | Create | Generic keytar wrapper for non-provider MCP keys (initially: `tavily`). |
| `src/mcp/__tests__/mcp-keychain.test.ts` | Create | Set/get/delete Tavily key. |
| `src/mcp/research-onboarding.ts` | Create | First-run wizard prompt, migration prompt, key validation, settings mutation. |
| `src/mcp/__tests__/research-onboarding.test.ts` | Create | Y/n/never paths, invalid key retry, silent merge, idempotent. |
| `src/mcp/auto-setup.ts` | Modify | Append context7, fetch, tavily to `DEFAULT_CONFIGS`. |
| `src/mcp/__tests__/auto-setup.test.ts` | Create | Migration: existing user without context7 → appended; existing entry preserved. |
| `src/mcp/catalog.ts` | Modify | Add three entries to `POPULAR_MCP_CATALOG`. |
| `src/index.ts` | Modify | Call `runResearchOnboarding` after `firstRunWizard` success; call `runResearchMigrationPrompt` once after settings load when flag missing. Add `mcp setup-research` command. |
| `CHANGELOG.md` | Modify | Note v1.3.0 feature. |

Keep each file focused. The two new modules are small (<150 LOC each); no further decomposition needed.

---

## Task 1: Add `webResearchPrompted` flag to settings

**Files:**
- Modify: `src/utils/settings.ts:176-209` (add field to `UserSettings`)
- Test: extend an existing settings test or create `src/utils/__tests__/settings-web-research.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/settings-web-research.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadUserSettings, saveUserSettings } from "../settings.js";

describe("UserSettings.webResearchPrompted", () => {
  const tmpHome = path.join(os.tmpdir(), `muonroi-cli-settings-${process.pid}`);
  const origHome = os.homedir;

  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    (os as any).homedir = origHome;
  });

  it("persists webResearchPrompted=true through save/load", () => {
    saveUserSettings({ webResearchPrompted: true });
    const loaded = loadUserSettings();
    expect(loaded.webResearchPrompted).toBe(true);
  });

  it("returns undefined when never set", () => {
    const loaded = loadUserSettings();
    expect(loaded.webResearchPrompted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/utils/__tests__/settings-web-research.test.ts
```

Expected: FAIL — TypeScript error "Object literal may only specify known properties, and 'webResearchPrompted' does not exist in type 'Partial<UserSettings>'".

- [ ] **Step 3: Add field to UserSettings**

Edit `src/utils/settings.ts` — find `export interface UserSettings {` at line 176 and add the new optional field next to other onboarding-style fields. Insert after line `councilPreferMultiProvider?: boolean;` (line 199):

```ts
  /** Set true after the user has been prompted (or skipped) the web-research onboarding. */
  webResearchPrompted?: boolean;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/utils/__tests__/settings-web-research.test.ts
```

Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/utils/settings.ts src/utils/__tests__/settings-web-research.test.ts && git commit -m "feat(settings): add webResearchPrompted flag for one-time onboarding"
```

---

## Task 2: Create `mcp-keychain.ts` for the Tavily key

**Files:**
- Create: `src/mcp/mcp-keychain.ts`
- Test: `src/mcp/__tests__/mcp-keychain.test.ts`

`providers/keychain.ts` is tightly coupled to `ProviderId`. Tavily is an MCP server, not an LLM provider. A small parallel module avoids polluting the provider keychain enum.

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/mcp-keychain.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock keytar before importing module under test.
vi.mock("keytar", () => {
  const store = new Map<string, string>();
  return {
    getPassword: vi.fn(async (service: string, account: string) =>
      store.get(`${service}:${account}`) ?? null,
    ),
    setPassword: vi.fn(async (service: string, account: string, password: string) => {
      store.set(`${service}:${account}`, password);
    }),
    deletePassword: vi.fn(async (service: string, account: string) => {
      return store.delete(`${service}:${account}`);
    }),
  };
});

import { setMcpKey, getMcpKey, deleteMcpKey } from "../mcp-keychain.js";

describe("mcp-keychain", () => {
  beforeEach(async () => {
    await deleteMcpKey("tavily");
  });

  it("stores and retrieves a tavily key", async () => {
    const ok = await setMcpKey("tavily", "tvly-1234567890abcdefghij");
    expect(ok).toBe(true);
    const got = await getMcpKey("tavily");
    expect(got).toBe("tvly-1234567890abcdefghij");
  });

  it("returns null when no key stored", async () => {
    const got = await getMcpKey("tavily");
    expect(got).toBeNull();
  });

  it("rejects keys shorter than 16 chars", async () => {
    await expect(setMcpKey("tavily", "short")).rejects.toThrow(/too short/i);
  });

  it("falls back to env var when keytar empty", async () => {
    process.env.TAVILY_API_KEY = "tvly-env-1234567890abcdefgh";
    const got = await getMcpKey("tavily");
    expect(got).toBe("tvly-env-1234567890abcdefgh");
    delete process.env.TAVILY_API_KEY;
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/mcp/__tests__/mcp-keychain.test.ts
```

Expected: FAIL — module `../mcp-keychain.js` not found.

- [ ] **Step 3: Implement `mcp-keychain.ts`**

Create `src/mcp/mcp-keychain.ts`:

```ts
import { redactor } from "../utils/redactor.js";

export type McpKeyId = "tavily";

const KEYCHAIN_SERVICE = "muonroi-cli";

const ACCOUNT_BY_MCP: Record<McpKeyId, string> = {
  tavily: "mcp-tavily",
};

const ENV_BY_MCP: Record<McpKeyId, string> = {
  tavily: "TAVILY_API_KEY",
};

const MIN_KEY_LEN = 16;

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword?(service: string, account: string, password: string): Promise<void>;
  deletePassword?(service: string, account: string): Promise<boolean>;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    return (await import("keytar")) as KeytarLike;
  } catch {
    return null;
  }
}

export async function setMcpKey(id: McpKeyId, key: string): Promise<boolean> {
  if (!key || key.length < MIN_KEY_LEN) {
    throw new Error(`Key for MCP '${id}' is too short (< ${MIN_KEY_LEN} chars).`);
  }
  const kt = await loadKeytar();
  if (!kt?.setPassword) return false;
  redactor.enrollSecret(key);
  await kt.setPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_MCP[id], key);
  return true;
}

export async function getMcpKey(id: McpKeyId): Promise<string | null> {
  const kt = await loadKeytar();
  if (kt) {
    try {
      const k = await kt.getPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_MCP[id]);
      if (k && k.length >= MIN_KEY_LEN) {
        redactor.enrollSecret(k);
        return k;
      }
    } catch {
      /* keytar backend failure → fall through to env */
    }
  }
  const envKey = process.env[ENV_BY_MCP[id]];
  if (envKey && envKey.length >= MIN_KEY_LEN) {
    redactor.enrollSecret(envKey);
    return envKey;
  }
  return null;
}

export async function deleteMcpKey(id: McpKeyId): Promise<boolean> {
  const kt = await loadKeytar();
  if (!kt?.deletePassword) return false;
  return kt.deletePassword(KEYCHAIN_SERVICE, ACCOUNT_BY_MCP[id]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/mcp/__tests__/mcp-keychain.test.ts
```

Expected: PASS, all four tests green.

- [ ] **Step 5: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/mcp/mcp-keychain.ts src/mcp/__tests__/mcp-keychain.test.ts && git commit -m "feat(mcp): add mcp-keychain helper for tavily and future MCP secrets"
```

---

## Task 3: Append context7, fetch, tavily to `DEFAULT_CONFIGS`

**Files:**
- Modify: `src/mcp/auto-setup.ts`
- Test: `src/mcp/__tests__/auto-setup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/auto-setup.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = path.join(os.tmpdir(), `muonroi-cli-auto-setup-${process.pid}`);

describe("ensureDefaultMcpServers — research servers", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("registers context7 + fetch + tavily for a fresh user", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const ids = merged.map((s) => s.id);
    expect(ids).toContain("context7");
    expect(ids).toContain("fetch");
    expect(ids).toContain("tavily");
  });

  it("context7 and fetch default to enabled", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const c7 = merged.find((s) => s.id === "context7");
    const fetch = merged.find((s) => s.id === "fetch");
    expect(c7?.enabled).toBe(true);
    expect(fetch?.enabled).toBe(true);
  });

  it("tavily defaults to disabled (key not yet provided)", async () => {
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const tavily = merged.find((s) => s.id === "tavily");
    expect(tavily?.enabled).toBe(false);
  });

  it("does NOT overwrite an existing tavily entry already configured by user", async () => {
    const settingsPath = path.join(tmpHome, ".muonroi-cli", "user-settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcp: {
          servers: [
            { id: "tavily", label: "Tavily Web Search", enabled: true, transport: "stdio", command: "npx", args: ["-y", "tavily-mcp"] },
          ],
        },
      }),
    );
    const { ensureDefaultMcpServers } = await import("../auto-setup.js");
    const merged = ensureDefaultMcpServers();
    const tavily = merged.find((s) => s.id === "tavily");
    expect(tavily?.enabled).toBe(true); // user's setting preserved
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/mcp/__tests__/auto-setup.test.ts
```

Expected: FAIL — first three tests fail (`ids` does not contain context7/fetch/tavily). Fourth passes incidentally.

- [ ] **Step 3: Add the three default configs**

Edit `src/mcp/auto-setup.ts`. Replace the `DEFAULT_CONFIGS` array (lines 4-38) with:

```ts
const DEFAULT_CONFIGS: McpServerConfig[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  },
  {
    id: "playwright",
    label: "Playwright",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp"],
  },
  {
    id: "memory",
    label: "Memory",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "figma",
    label: "Figma",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "figma-developer-mcp", "--stdio"],
    env: { FIGMA_API_KEY: "" },
  },
  {
    id: "context7",
    label: "Context7 (Library Docs)",
    enabled: true,
    transport: "http",
    url: "https://mcp.context7.com/mcp",
  },
  {
    id: "fetch",
    label: "Fetch (URL → markdown)",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-fetch-server"],
  },
  {
    id: "tavily",
    label: "Tavily Web Search",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "tavily-mcp"],
    env: { TAVILY_API_KEY: "" },
  },
];
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/mcp/__tests__/auto-setup.test.ts
```

Expected: PASS, all four tests green.

- [ ] **Step 5: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/mcp/auto-setup.ts src/mcp/__tests__/auto-setup.test.ts && git commit -m "feat(mcp): default-register context7, fetch, tavily research servers"
```

---

## Task 4: Add three entries to the popular MCP catalog

**Files:**
- Modify: `src/mcp/catalog.ts`

This populates the `/mcp add` UI so users can re-add or inspect the servers.

- [ ] **Step 1: Edit the catalog**

In `src/mcp/catalog.ts`, after the `figma` entry near the end (around line 98), insert:

```ts
  {
    id: "context7",
    name: "Context7 (Library Docs)",
    description:
      "Version-pinned, chunked library documentation for Claude/Gemini/Codex-style coding agents.",
    directoryUrl: "https://context7.com",
    sourceUrl: "https://github.com/upstash/context7",
    starterTransport: "http",
  },
  {
    id: "fetch",
    name: "Fetch (URL → markdown)",
    description:
      "Fetches a URL and converts HTML to markdown for the agent to read.",
    directoryUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    sourceUrl: "https://github.com/modelcontextprotocol/servers",
    starterTransport: "stdio",
  },
  {
    id: "tavily",
    name: "Tavily Web Search",
    description:
      "LLM-tuned web search with answer summaries and rerank. Free tier 1k/month. Requires TAVILY_API_KEY.",
    directoryUrl: "https://tavily.com",
    sourceUrl: "https://github.com/tavily-ai/tavily-mcp",
    starterTransport: "stdio",
  },
```

- [ ] **Step 2: Verify the file still type-checks**

```bash
cd D:/sources/Core/muonroi-cli && bun run typecheck
```

Expected: clean exit, no TS errors.

- [ ] **Step 3: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/mcp/catalog.ts && git commit -m "feat(mcp): list context7, fetch, tavily in the popular MCP catalog"
```

---

## Task 5: Create `research-onboarding.ts` (wizard + migration prompt)

**Files:**
- Create: `src/mcp/research-onboarding.ts`
- Test: `src/mcp/__tests__/research-onboarding.test.ts`

This module exposes two functions used from `src/index.ts` and the `mcp setup-research` CLI command.

- [ ] **Step 1: Write the failing test**

Create `src/mcp/__tests__/research-onboarding.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing module under test.
vi.mock("../mcp-keychain.js", () => ({
  setMcpKey: vi.fn(async () => true),
  getMcpKey: vi.fn(async () => null),
  deleteMcpKey: vi.fn(async () => true),
}));

const settingsStore: { webResearchPrompted?: boolean } = {};
const mcpServers: any[] = [];
vi.mock("../../utils/settings.js", () => ({
  loadUserSettings: vi.fn(() => ({ ...settingsStore })),
  saveUserSettings: vi.fn((p: any) => Object.assign(settingsStore, p)),
  loadMcpServers: vi.fn(() => [...mcpServers]),
  saveMcpServers: vi.fn((s: any[]) => { mcpServers.length = 0; mcpServers.push(...s); }),
}));

global.fetch = vi.fn(async () =>
  new Response(JSON.stringify({ results: [] }), { status: 200 }),
) as any;

import {
  runResearchOnboarding,
  runResearchMigrationPrompt,
  validateTavilyKey,
} from "../research-onboarding.js";

describe("validateTavilyKey", () => {
  it("returns true on HTTP 200", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const ok = await validateTavilyKey("tvly-1234567890abcdefghij");
    expect(ok).toBe(true);
  });

  it("returns false on HTTP 401", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    const ok = await validateTavilyKey("tvly-bad-keykeykeykey");
    expect(ok).toBe(false);
  });

  it("returns false on network error", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const ok = await validateTavilyKey("tvly-1234567890abcdefghij");
    expect(ok).toBe(false);
  });
});

describe("runResearchOnboarding", () => {
  beforeEach(() => {
    settingsStore.webResearchPrompted = undefined;
    mcpServers.length = 0;
    vi.clearAllMocks();
  });

  it("Y + valid key: stores key, enables tavily, sets flag", async () => {
    (global.fetch as any).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => "tvly-1234567890abcdefghij",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(true);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("Y + blank key: skips tavily, still sets flag", async () => {
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => "",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(false);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("n: skips entirely, sets flag", async () => {
    const result = await runResearchOnboarding({
      askYesNo: async () => "n",
      askText: async () => "should not be asked",
      log: () => {},
    });
    expect(result.tavilyEnabled).toBe(false);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("invalid key retries up to 3 times then skips", async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 401 }));
    let calls = 0;
    const result = await runResearchOnboarding({
      askYesNo: async () => "y",
      askText: async () => { calls++; return "tvly-bad-keykeykeykey"; },
      log: () => {},
    });
    expect(calls).toBe(3);
    expect(result.tavilyEnabled).toBe(false);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });
});

describe("runResearchMigrationPrompt", () => {
  beforeEach(() => {
    settingsStore.webResearchPrompted = undefined;
    mcpServers.length = 0;
    vi.clearAllMocks();
  });

  it("does nothing if flag already true", async () => {
    settingsStore.webResearchPrompted = true;
    const result = await runResearchMigrationPrompt({
      askChoice: async () => "y",
      askText: async () => "tvly-1234567890abcdefghij",
      log: () => {},
    });
    expect(result.shown).toBe(false);
  });

  it("'never' sets flag and never asks again", async () => {
    const result = await runResearchMigrationPrompt({
      askChoice: async () => "never",
      askText: async () => "",
      log: () => {},
    });
    expect(result.shown).toBe(true);
    expect(settingsStore.webResearchPrompted).toBe(true);
  });

  it("'n' shows but does NOT set flag (re-ask next start)", async () => {
    const result = await runResearchMigrationPrompt({
      askChoice: async () => "n",
      askText: async () => "",
      log: () => {},
    });
    expect(result.shown).toBe(true);
    expect(settingsStore.webResearchPrompted).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/mcp/__tests__/research-onboarding.test.ts
```

Expected: FAIL — module `../research-onboarding.js` not found.

- [ ] **Step 3: Implement `research-onboarding.ts`**

Create `src/mcp/research-onboarding.ts`:

```ts
import { loadMcpServers, saveMcpServers, saveUserSettings, loadUserSettings } from "../utils/settings.js";
import { setMcpKey } from "./mcp-keychain.js";

export interface OnboardingIO {
  askYesNo: (prompt: string) => Promise<string>;
  askText: (prompt: string) => Promise<string>;
  log: (msg: string) => void;
}

export interface MigrationIO {
  askChoice: (prompt: string) => Promise<string>;
  askText: (prompt: string) => Promise<string>;
  log: (msg: string) => void;
}

export interface OnboardingResult {
  tavilyEnabled: boolean;
}

export interface MigrationResult {
  shown: boolean;
  tavilyEnabled: boolean;
}

const TAVILY_VALIDATE_URL = "https://api.tavily.com/search";
const MAX_RETRY = 3;

export async function validateTavilyKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(TAVILY_VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: "ping", max_results: 1 }),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

function setTavilyEnabled(enabled: boolean): void {
  const servers = loadMcpServers();
  const idx = servers.findIndex((s) => s.id === "tavily");
  if (idx === -1) return;
  if (servers[idx].enabled === enabled) return;
  servers[idx] = { ...servers[idx], enabled };
  saveMcpServers(servers);
}

async function promptForKeyWithRetry(io: { askText: (p: string) => Promise<string>; log: (m: string) => void }): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const raw = await io.askText(
      attempt === 1
        ? "Tavily API key (free tier at https://tavily.com, leave blank to skip): "
        : `Tavily key invalid. Try again (${attempt}/${MAX_RETRY}) or leave blank to skip: `,
    );
    const key = raw.trim();
    if (!key) return null;
    if (key.length < 16) {
      io.log("Key looks too short (< 16 chars).\n");
      continue;
    }
    const ok = await validateTavilyKey(key);
    if (ok) return key;
    io.log("Validation failed (HTTP 401 or network error).\n");
  }
  return null;
}

export async function runResearchOnboarding(io: OnboardingIO): Promise<OnboardingResult> {
  io.log("\n📚 Web research is available via MCP servers:\n");
  io.log("  • context7 — version-pinned library docs (free, no key)\n");
  io.log("  • fetch — URL → markdown extraction (free, no key)\n");
  io.log("  • tavily — LLM-tuned web search (free tier 1k/mo, needs API key)\n\n");
  const yn = (await io.askYesNo("Enable Tavily web search now? [Y/n]: ")).trim().toLowerCase();
  let tavilyEnabled = false;
  if (yn !== "n" && yn !== "no") {
    const key = await promptForKeyWithRetry(io);
    if (key) {
      try {
        await setMcpKey("tavily", key);
        setTavilyEnabled(true);
        tavilyEnabled = true;
        io.log("✓ Tavily key stored. Web search enabled.\n");
      } catch (err) {
        io.log(`Could not store key: ${(err as Error).message}\n`);
      }
    } else {
      io.log("Skipped Tavily setup. You can run `muonroi-cli mcp setup-research` later.\n");
    }
  }
  saveUserSettings({ webResearchPrompted: true });
  return { tavilyEnabled };
}

export async function runResearchMigrationPrompt(io: MigrationIO): Promise<MigrationResult> {
  const settings = loadUserSettings();
  if (settings.webResearchPrompted === true) {
    return { shown: false, tavilyEnabled: false };
  }
  io.log("\n📚 New: web research is available.\n");
  io.log("  • context7 (library docs) and fetch (URL extraction) — already enabled.\n");
  io.log("  • Tavily web search needs a free API key (tavily.com).\n\n");
  const choice = (await io.askChoice("Set up Tavily now? [Y/n/never]: ")).trim().toLowerCase();
  let tavilyEnabled = false;
  if (choice === "y" || choice === "yes" || choice === "") {
    const key = await promptForKeyWithRetry(io);
    if (key) {
      try {
        await setMcpKey("tavily", key);
        setTavilyEnabled(true);
        tavilyEnabled = true;
        saveUserSettings({ webResearchPrompted: true });
        io.log("✓ Tavily key stored. Web search enabled.\n");
      } catch (err) {
        io.log(`Could not store key: ${(err as Error).message}\n`);
      }
    } else {
      io.log("Skipped. You can run `muonroi-cli mcp setup-research` later.\n");
    }
  } else if (choice === "never") {
    saveUserSettings({ webResearchPrompted: true });
    io.log("Got it — won't ask again. Run `muonroi-cli mcp setup-research` if you change your mind.\n");
  } else {
    io.log("Skipped for this session.\n");
  }
  return { shown: true, tavilyEnabled };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/mcp/__tests__/research-onboarding.test.ts
```

Expected: PASS, all tests green (3 validate + 4 onboarding + 3 migration = 10 tests).

- [ ] **Step 5: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/mcp/research-onboarding.ts src/mcp/__tests__/research-onboarding.test.ts && git commit -m "feat(mcp): research onboarding wizard and migration prompt"
```

---

## Task 6: Wire onboarding into `firstRunWizard` (new users)

**Files:**
- Modify: `src/index.ts:98-191` (firstRunWizard)

The existing wizard already opens a `readline` interface. Reuse it to call `runResearchOnboarding` after the main key is stored.

- [ ] **Step 1: Add the onboarding call after key save success**

Edit `src/index.ts`. Inside `firstRunWizard`, locate the success branch starting around line 165 (`if (ok) {`). After the existing `process.stderr.write(\`\\nStored ${provider} key in OS keychain.\\n\`);` line, **before** `if (currentModel) {`, insert:

```ts
        // Web-research onboarding (Tavily + context7 + fetch).
        try {
          const { runResearchOnboarding } = await import("./mcp/research-onboarding.js");
          const askYesNo = (q: string) => new Promise<string>((res) => rl.question(q, res));
          const askText = askYesNo;
          await runResearchOnboarding({
            askYesNo,
            askText,
            log: (m) => process.stderr.write(m),
          });
        } catch (err) {
          process.stderr.write(`\nWarning: research onboarding failed: ${(err as Error).message}\n`);
        }
```

Note: `rl` is the readline interface created at the top of `firstRunWizard`. Do not close it before this block — the existing `rl.close()` at line 152 must be moved to AFTER this onboarding block. Update the function as follows:

1. Find `rl.close();` at line 152 and **delete** it.
2. Find the final `return trimmed;` at the bottom of the success path (around line 187) and insert `rl.close();` immediately before it.
3. Also insert `rl.close();` before each existing `return null;` path that did not already close (search for any `return null;` that follows the `rl` declaration without an `rl.close()` call) — there is one at line 156 ("No key provided"). Move `rl.close();` to before each such return.

- [ ] **Step 2: Verify the change compiles**

```bash
cd D:/sources/Core/muonroi-cli && bun run typecheck
```

Expected: clean exit.

- [ ] **Step 3: Add an integration test for the wired wizard**

Create `src/__tests__/first-run-wizard.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// We don't actually invoke firstRunWizard — that needs a real TTY. Instead
// verify that the import chain holds and runResearchOnboarding is available
// from the same module graph.
describe("first-run wizard wiring", () => {
  it("runResearchOnboarding is reachable from the mcp module", async () => {
    const mod = await import("../mcp/research-onboarding.js");
    expect(typeof mod.runResearchOnboarding).toBe("function");
    expect(typeof mod.runResearchMigrationPrompt).toBe("function");
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run src/__tests__/first-run-wizard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/index.ts src/__tests__/first-run-wizard.test.ts && git commit -m "feat(cli): wire research onboarding into first-run wizard"
```

---

## Task 7: Wire migration prompt into startup (existing users)

**Files:**
- Modify: `src/index.ts` near `startInteractive` boot order (line ~210, after `loadConfig` and key load)

The migration prompt must run only when interactive (`process.stdin.isTTY`), only when `webResearchPrompted` is missing, and BEFORE the agent starts.

- [ ] **Step 1: Add the migration call**

Edit `src/index.ts`. In `startInteractive`, after the existing line `void providerKey; // Agent also loads key internally;` (around line 216), insert:

```ts
  // Web-research migration prompt — runs once per install for existing users
  // who never saw the first-run wizard's research step. Skip in non-interactive
  // mode (--prompt, --verify, headless harnesses).
  if (process.stdin.isTTY) {
    try {
      const { loadUserSettings } = await import("./utils/settings.js");
      if (loadUserSettings().webResearchPrompted !== true) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const ask = (q: string): Promise<string> =>
          new Promise((resolve) => rl.question(q, (a) => resolve(a)));
        const { runResearchMigrationPrompt } = await import("./mcp/research-onboarding.js");
        await runResearchMigrationPrompt({
          askChoice: ask,
          askText: ask,
          log: (m) => process.stderr.write(m),
        });
        rl.close();
      }
    } catch (err) {
      process.stderr.write(`\nWarning: research migration prompt failed: ${(err as Error).message}\n`);
    }
  }
```

- [ ] **Step 2: Verify type-check**

```bash
cd D:/sources/Core/muonroi-cli && bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Manual smoke test**

```bash
cd D:/sources/Core/muonroi-cli && rm -f ~/.muonroi-cli/user-settings.json && bun run src/index.ts --help 2>&1 | head -5
```

The migration prompt must NOT appear for `--help` (which exits non-interactive). Confirm visually.

- [ ] **Step 4: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/index.ts && git commit -m "feat(cli): one-time research migration prompt for existing users"
```

---

## Task 8: Add `mcp setup-research` CLI command

**Files:**
- Modify: `src/index.ts` (commander setup, near `keys` command)

User-facing escape hatch to re-run the wizard at any time.

- [ ] **Step 1: Add the command**

Edit `src/index.ts`. After the `keys` command block ending around line 947 (before `program.parse();`), insert:

```ts
const mcp = program
  .command("mcp")
  .description("Manage MCP server configuration");

mcp
  .command("setup-research")
  .description("Configure web research MCP servers (context7, fetch, tavily)")
  .action(async () => {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, (a) => resolve(a)));
    const { runResearchOnboarding } = await import("./mcp/research-onboarding.js");
    const result = await runResearchOnboarding({
      askYesNo: ask,
      askText: ask,
      log: (m) => process.stderr.write(m),
    });
    rl.close();
    process.stderr.write(`\nDone. Tavily ${result.tavilyEnabled ? "enabled" : "skipped"}.\n`);
  });
```

- [ ] **Step 2: Verify type-check and command appears in help**

```bash
cd D:/sources/Core/muonroi-cli && bun run typecheck && bun run src/index.ts mcp --help
```

Expected: clean type-check; help output lists `setup-research`.

- [ ] **Step 3: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add src/index.ts && git commit -m "feat(cli): add 'mcp setup-research' command"
```

---

## Task 9: Update CHANGELOG and bump version

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "1.2.3"` to `"version": "1.3.0"`.

- [ ] **Step 2: Add CHANGELOG entry**

In `CHANGELOG.md`, add at the top (matching the file's existing format — read the first existing entry first to mirror style):

```md
## v1.3.0 — 2026-05-08

- **MCP web research**: Default-registered three MCP servers — `context7` (library docs), `fetch` (URL → markdown), and `tavily` (web search). The agent can now research the internet during implement/debug/debate without leaving the CLI.
- **Onboarding**: First-run wizard now prompts for a free Tavily API key (skippable). Existing users see a one-time migration prompt with `Y/n/never` options.
- **CLI**: New `muonroi-cli mcp setup-research` command to (re-)run the research wizard.
- **Settings**: New `webResearchPrompted` flag tracks whether the user has been offered web research.
- **Keychain**: New `mcp-keychain.ts` helper stores Tavily key in the OS keychain (with `TAVILY_API_KEY` env fallback).
```

- [ ] **Step 3: Verify**

```bash
cd D:/sources/Core/muonroi-cli && bun run typecheck && bunx vitest run
```

Expected: all tests green, no type errors.

- [ ] **Step 4: Commit**

```bash
cd D:/sources/Core/muonroi-cli && git add package.json CHANGELOG.md && git commit -m "chore(release): v1.3.0 — MCP web research integration"
```

---

## Final Verification

- [ ] **Run full test suite**

```bash
cd D:/sources/Core/muonroi-cli && bunx vitest run
```

Expected: all green; new tests added in tasks 1, 2, 3, 5, 6 must be present and passing.

- [ ] **Run type-check**

```bash
cd D:/sources/Core/muonroi-cli && bun run typecheck
```

Expected: clean exit.

- [ ] **Run lint**

```bash
cd D:/sources/Core/muonroi-cli && bun run lint
```

Expected: clean (or only pre-existing warnings unrelated to this work).

- [ ] **Manual TTY check (interactive — operator-driven, document outcome in PR)**

1. `rm -rf ~/.muonroi-cli && bun run src/index.ts` — confirm first-run wizard shows the Tavily prompt after the main key.
2. With `webResearchPrompted` set, run `bun run src/index.ts` — confirm migration prompt does NOT appear.
3. Delete `webResearchPrompted` from settings, run `bun run src/index.ts` — confirm migration prompt appears.
4. Run `bun run src/index.ts mcp setup-research` — confirm wizard re-runs anytime.

---

## Self-Review

**Spec coverage check:**

| Spec section | Implemented in |
|---|---|
| §3 MCP server inventory (context7/fetch/tavily) | Task 3 |
| §3 module boundaries (auto-setup, catalog, onboarding, keychain, settings, CLI) | Tasks 1-8 |
| §4.1 First-run wizard flow | Task 5 + Task 6 |
| §4.2 Migration prompt flow | Task 5 + Task 7 |
| §4.3 Explicit `mcp setup-research` | Task 8 |
| §4.4 Tool execution path (no change) | n/a — runtime untouched |
| §5 Error handling (invalid key retry, validation) | Task 5 (promptForKeyWithRetry, validateTavilyKey) |
| §6 Testing strategy | Tasks 1, 2, 3, 5, 6 |
| §7 Security (keychain, redactor) | Task 2 (mcp-keychain uses redactor.enrollSecret) |
| §8 Rollout (v1.3.0, CHANGELOG) | Task 9 |
| §9 Open questions | Task 6 (wizard hook location confirmed at firstRunWizard success branch); Task 7 (no hot-reload — restart implied; user can run `mcp setup-research` then restart) |

**Placeholder scan:** No "TBD", "TODO", "implement later" patterns. All code shown in full. All commands include the project directory.

**Type consistency:** `OnboardingIO` / `MigrationIO` used identically in test and implementation. `setMcpKey`/`getMcpKey`/`deleteMcpKey` signatures consistent across Task 2 and Task 5. `webResearchPrompted` field on `UserSettings` matches across Tasks 1, 5, 7. `McpServerConfig` shape matches `src/utils/settings.ts:101-112` (id, label, enabled, transport, url?, headers?, command?, args?, env?, cwd?).

No gaps found.
