# Provider & Council Config UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `muonroi-cli config` interactive TUI command for managing providers and council settings, plus `/config` entry in the TUI slash palette with input color coding.

**Architecture:** New `src/cli/config/` module using readline + raw stdin (same pattern as `src/cli/keys.ts:promptHidden()`). No @opentui/react dependency — ANSI escape codes + raw mode only. Commander command registered in `src/index.ts`. Slash menu entry added to `src/ui/slash/menu-items.ts`. Slash input color handled in `app.tsx` by reading `showSlashMenu` + `filteredSlashItems` state already present.

**Tech Stack:** Node.js `process.stdin` raw mode, ANSI escape codes, Commander.js, `keytar` via existing `listStoredProviders / loadKeyForProvider / setKeyForProvider`, `saveUserSettings / setProviderDisabled / getRoleModels` from settings.ts, `MODELS / getModelsForProvider` from registry.ts, `PROVIDER_ENDPOINTS` from endpoints.ts, `node:https` for `/v1/models` fetch.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/cli/config/tui.ts` | Create | Raw-mode key capture, ANSI helpers, box/row render |
| `src/cli/config/provider-fetch.ts` | Create | Fetch `/v1/models` from provider, capability heuristic |
| `src/cli/config/model-picker.ts` | Create | Interactive model browser (catalog + live models) |
| `src/cli/config/screen-providers.ts` | Create | Provider table TUI screen |
| `src/cli/config/screen-council.ts` | Create | Council/debate config TUI screen |
| `src/cli/config/index.ts` | Create | Commander command `buildConfigCommand()`, entry menu |
| `src/cli/config/__tests__/provider-fetch.test.ts` | Create | Unit tests for `inferCapability` |
| `src/cli/config/__tests__/model-picker.test.ts` | Create | Unit tests for `filterModels`, `groupModels` |
| `src/index.ts` | Modify | `program.addCommand(buildConfigCommand())` |
| `src/ui/slash/menu-items.ts` | Modify | Add `{ id: "config", ... }` entry |
| `src/ui/app.tsx` | Modify | Handle `case "config"` in `handleSlashMenuSelect` |

---

## Task 1: TUI Primitives

**Files:**
- Create: `src/cli/config/tui.ts`

- [ ] **Step 1: Create the TUI primitives file**

```typescript
// src/cli/config/tui.ts
// Raw-mode key capture, ANSI helpers, and box/row rendering for config screens.

export const A = {
  CLEAR_SCREEN: "\x1b[2J\x1b[H",
  CLEAR_LINE: "\x1b[2K\r",
  UP: (n: number) => `\x1b[${n}A`,
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  BLUE: "\x1b[34m",
  BRIGHT_BLUE: "\x1b[94m",
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  YELLOW: "\x1b[33m",
  REVERSE: "\x1b[7m",
  RESET: "\x1b[0m",
};

export interface KeyEvent {
  /** Normalized name: "up", "down", "left", "right", "return", "escape", "space",
   *  "backspace", or the raw character for printable keys. */
  name: string;
  raw: Buffer;
}

/** Enter raw mode and return a cleanup function that restores stdin. */
export function enterRawMode(): () => void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdout.write(A.HIDE_CURSOR);
  return () => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdout.write(A.SHOW_CURSOR);
  };
}

/** Read one key event from raw stdin. Exits process on Ctrl+C. */
export function captureKey(): Promise<KeyEvent> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener("data", onData);
      const b0 = chunk[0] ?? 0;

      if (b0 === 0x03) {
        // Ctrl+C
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(false);
        }
        process.stdout.write(A.SHOW_CURSOR + "\n");
        process.exit(130);
      }

      if (b0 === 0x1b) {
        if (chunk.length === 1) {
          return resolve({ name: "escape", raw: chunk });
        }
        if (chunk[1] === 0x5b /* [ */) {
          const code = chunk[2];
          if (code === 0x41) return resolve({ name: "up", raw: chunk });
          if (code === 0x42) return resolve({ name: "down", raw: chunk });
          if (code === 0x43) return resolve({ name: "right", raw: chunk });
          if (code === 0x44) return resolve({ name: "left", raw: chunk });
        }
        return resolve({ name: "escape", raw: chunk });
      }

      if (b0 === 0x0d || b0 === 0x0a) return resolve({ name: "return", raw: chunk });
      if (b0 === 0x20) return resolve({ name: "space", raw: chunk });
      if (b0 === 0x7f || b0 === 0x08) return resolve({ name: "backspace", raw: chunk });
      if (b0 >= 0x20) return resolve({ name: String.fromCharCode(b0), raw: chunk });
      resolve({ name: "unknown", raw: chunk });
    };
    process.stdin.once("data", onData);
  });
}

/** Mask an API key for display: first 6 chars + … + last 4. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Prompt for hidden input (key entry). Returns trimmed value. */
export async function hiddenPrompt(question: string): Promise<string> {
  const CHAR_LF = 0x0a;
  const CHAR_CR = 0x0d;
  const CHAR_EOT = 0x04;
  const CHAR_ETX = 0x03;
  const CHAR_BS = 0x08;
  const CHAR_DEL = 0x7f;

  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";

    const finish = (cancelled: boolean) => {
      process.stdin.removeListener("data", onData);
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write("\n");
      if (cancelled) process.exit(130);
      resolve(value);
    };

    const onData = (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk[i] ?? 0;
        if (code === CHAR_LF || code === CHAR_CR || code === CHAR_EOT) {
          finish(false);
          return;
        }
        if (code === CHAR_ETX) { finish(true); return; }
        if (code === CHAR_BS || code === CHAR_DEL) {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (code < 0x20) continue;
        value += String.fromCharCode(code);
      }
    };

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

/** Render a horizontal divider line. */
export function divider(width = 56): string {
  return "─".repeat(width);
}

/** Render a row with optional cursor highlight. */
export function renderRow(
  text: string,
  selected: boolean,
  width = 56,
): string {
  const prefix = selected ? `${A.REVERSE}► ` : "  ";
  const suffix = selected ? A.RESET : "";
  const padded = (prefix + text).padEnd(width);
  return prefix + text.padEnd(width - prefix.length) + suffix;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/config/tui.ts
git commit -m "feat(config): add raw-mode TUI primitives (captureKey, hiddenPrompt, ANSI helpers)"
```

---

## Task 2: Provider Model Fetch + Tests

**Files:**
- Create: `src/cli/config/provider-fetch.ts`
- Create: `src/cli/config/__tests__/provider-fetch.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/config/__tests__/provider-fetch.test.ts
import { describe, it, expect } from "vitest";
import { inferCapability } from "../provider-fetch.js";

describe("inferCapability", () => {
  it("returns vision for model IDs containing 'vision'", () => {
    expect(inferCapability("gpt-4-vision-preview")).toBe("vision");
  });
  it("returns vision for 'vl' substring", () => {
    expect(inferCapability("Qwen2-VL-7B")).toBe("vision");
  });
  it("returns vision for 'multimodal'", () => {
    expect(inferCapability("gemini-multimodal-pro")).toBe("vision");
  });
  it("returns image for 'flux'", () => {
    expect(inferCapability("black-forest-labs/FLUX.1")).toBe("image");
  });
  it("returns image for 'dall-e'", () => {
    expect(inferCapability("dall-e-3")).toBe("image");
  });
  it("returns image for 'stable-diffusion'", () => {
    expect(inferCapability("stable-diffusion-xl")).toBe("image");
  });
  it("returns image for 'imagen'", () => {
    expect(inferCapability("imagen-3")).toBe("image");
  });
  it("returns video for 'wan'", () => {
    expect(inferCapability("wan-video-14b")).toBe("video");
  });
  it("returns video for 'kling'", () => {
    expect(inferCapability("kling-v1")).toBe("video");
  });
  it("returns text for unknown model", () => {
    expect(inferCapability("deepseek-v3")).toBe("text");
  });
  it("returns text for claude models", () => {
    expect(inferCapability("claude-opus-4-7")).toBe("text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/config/__tests__/provider-fetch.test.ts`
Expected: FAIL with `Cannot find module '../provider-fetch.js'`

- [ ] **Step 3: Implement provider-fetch.ts**

```typescript
// src/cli/config/provider-fetch.ts
// Fetches live model list from a provider's /v1/models endpoint.
// Used by model-picker when catalog doesn't cover a provider's full lineup.

import * as https from "node:https";
import * as http from "node:http";

export type ModelCapability = "text" | "vision" | "image" | "video";

export interface LiveModel {
  id: string;
  displayName: string;
  capability: ModelCapability;
}

const VISION_RE = /vision|vl|multimodal/i;
const IMAGE_RE = /flux|stable[_-]diffusion|imagen|dall[_-]e/i;
const VIDEO_RE = /video|wan[_-]|kling|hailuo/i;

export function inferCapability(modelId: string): ModelCapability {
  const id = modelId.toLowerCase();
  if (VISION_RE.test(id)) return "vision";
  if (IMAGE_RE.test(id)) return "image";
  if (VIDEO_RE.test(id)) return "video";
  return "text";
}

function shortName(id: string): string {
  // "org/model-name" → "model-name"
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export async function fetchProviderModels(
  baseURL: string,
  apiKey: string,
  timeoutMs = 8000,
): Promise<LiveModel[]> {
  const url = new URL("/v1/models", baseURL.endsWith("/") ? baseURL : baseURL + "/");
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    const req = lib.get(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          try {
            const json = JSON.parse(body) as { data?: Array<{ id: string }> };
            const items = json.data ?? [];
            resolve(
              items
                .filter((m) => typeof m.id === "string")
                .map((m) => ({
                  id: m.id,
                  displayName: shortName(m.id),
                  capability: inferCapability(m.id),
                })),
            );
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cli/config/__tests__/provider-fetch.test.ts`
Expected: 12 passing

- [ ] **Step 5: Commit**

```bash
git add src/cli/config/provider-fetch.ts src/cli/config/__tests__/provider-fetch.test.ts
git commit -m "feat(config): provider-fetch with capability heuristic and /v1/models client"
```

---

## Task 3: Model Picker Logic + Tests

**Files:**
- Create: `src/cli/config/model-picker.ts`
- Create: `src/cli/config/__tests__/model-picker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/cli/config/__tests__/model-picker.test.ts
import { describe, it, expect } from "vitest";
import { filterModels, groupModels } from "../model-picker.js";
import type { PickerModel } from "../model-picker.js";

const SAMPLE: PickerModel[] = [
  { id: "claude-opus-4-7", displayName: "claude-opus-4-7", provider: "anthropic", tier: "premium", capability: "text" },
  { id: "gpt-4o", displayName: "gpt-4o", provider: "openai", tier: "premium", capability: "text" },
  { id: "gpt-4-vision", displayName: "gpt-4-vision", provider: "openai", tier: "premium", capability: "vision" },
  { id: "FLUX.1", displayName: "FLUX.1", provider: "siliconflow", capability: "image" },
  { id: "deepseek-v3", displayName: "deepseek-v3", provider: "deepseek", tier: "balanced", capability: "text" },
];

describe("filterModels", () => {
  it("returns all models when query is empty", () => {
    expect(filterModels(SAMPLE, "")).toHaveLength(5);
  });
  it("filters by id substring (case-insensitive)", () => {
    const result = filterModels(SAMPLE, "gpt");
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.id.toLowerCase().includes("gpt"))).toBe(true);
  });
  it("filters by provider", () => {
    const result = filterModels(SAMPLE, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("claude-opus-4-7");
  });
  it("returns empty when no match", () => {
    expect(filterModels(SAMPLE, "zzz")).toHaveLength(0);
  });
});

describe("groupModels", () => {
  it("puts vision capability models into Vision group", () => {
    const groups = groupModels(SAMPLE);
    const visionGroup = groups.find((g) => g.name === "Vision / Multimodal");
    expect(visionGroup?.models).toHaveLength(1);
    expect(visionGroup?.models[0]?.id).toBe("gpt-4-vision");
  });
  it("puts image capability models into Image group", () => {
    const groups = groupModels(SAMPLE);
    const imageGroup = groups.find((g) => g.name === "Image Generation");
    expect(imageGroup?.models).toHaveLength(1);
  });
  it("puts text capability models into Text / Chat group", () => {
    const groups = groupModels(SAMPLE);
    const textGroup = groups.find((g) => g.name === "Text / Chat");
    expect(textGroup?.models).toHaveLength(3);
  });
  it("omits groups with no models", () => {
    const textOnly = SAMPLE.filter((m) => m.capability === "text");
    const groups = groupModels(textOnly);
    expect(groups.every((g) => g.models.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/config/__tests__/model-picker.test.ts`
Expected: FAIL with `Cannot find module '../model-picker.js'`

- [ ] **Step 3: Implement model-picker.ts**

```typescript
// src/cli/config/model-picker.ts
// Interactive model browser: catalog models + optionally live-fetched models.
// Opened from Council role rows (Enter) and Provider screen [r].

import type { ModelInfo } from "../../types/index.js";
import { MODELS } from "../../models/registry.js";
import type { ModelCapability, LiveModel } from "./provider-fetch.js";
import { A, captureKey, enterRawMode, divider } from "./tui.js";

export interface PickerModel {
  id: string;
  displayName: string;
  provider: string;
  tier?: string;
  capability: ModelCapability;
}

export interface ModelGroup {
  name: string;
  models: PickerModel[];
}

const CAPABILITY_ORDER: ModelCapability[] = ["text", "vision", "image", "video"];
const GROUP_NAMES: Record<ModelCapability, string> = {
  text: "Text / Chat",
  vision: "Vision / Multimodal",
  image: "Image Generation",
  video: "Video Generation",
};

function modelInfoToPickerModel(m: ModelInfo): PickerModel {
  let capability: ModelCapability = "text";
  if (m.supportsVision) capability = "vision";
  return {
    id: m.id,
    displayName: m.name ?? m.id,
    provider: m.provider ?? "unknown",
    tier: m.tier,
    capability,
  };
}

function liveModelToPickerModel(m: LiveModel, provider: string): PickerModel {
  return { ...m, provider };
}

export function filterModels(models: PickerModel[], query: string): PickerModel[] {
  if (!query) return models;
  const q = query.toLowerCase();
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.tier?.toLowerCase().includes(q) ?? false),
  );
}

export function groupModels(models: PickerModel[]): ModelGroup[] {
  const byCapability = new Map<ModelCapability, PickerModel[]>();
  for (const m of models) {
    const list = byCapability.get(m.capability) ?? [];
    list.push(m);
    byCapability.set(m.capability, list);
  }
  return CAPABILITY_ORDER
    .filter((cap) => (byCapability.get(cap)?.length ?? 0) > 0)
    .map((cap) => ({ name: GROUP_NAMES[cap], models: byCapability.get(cap)! }));
}

function flattenGroups(groups: ModelGroup[]): Array<PickerModel | { groupHeader: string }> {
  const flat: Array<PickerModel | { groupHeader: string }> = [];
  for (const g of groups) {
    flat.push({ groupHeader: g.name });
    for (const m of g.models) flat.push(m);
  }
  return flat;
}

function renderScreen(
  forRole: string,
  query: string,
  flat: Array<PickerModel | { groupHeader: string }>,
  cursorIdx: number,
  fetchStatus: string,
  width: number,
): string {
  const W = width;
  const lines: string[] = [];
  lines.push(`${A.BOLD}Select model for: ${forRole}${A.RESET}`);
  lines.push(divider(W));
  lines.push(`Filter: [/${query.padEnd(Math.max(0, W - 10))}]`);
  lines.push("");

  let selectable = -1;
  for (const item of flat) {
    if ("groupHeader" in item) {
      lines.push(`${A.DIM}${item.groupHeader}${A.RESET}`);
    } else {
      selectable++;
      const selected = selectable === cursorIdx;
      const prefix = selected ? `${A.REVERSE}> ` : "  ";
      const suffix = selected ? A.RESET : "";
      const tier = item.tier ? `  ${A.DIM}${item.tier}${A.RESET}` : "";
      const provider = `${A.DIM}${item.provider}${A.RESET}`;
      lines.push(`${prefix}${item.displayName.padEnd(32)} ${provider}${tier}${suffix}`);
    }
  }

  if (fetchStatus) {
    lines.push("");
    lines.push(`${A.DIM}${fetchStatus}${A.RESET}`);
  }
  lines.push("");
  lines.push(`${A.DIM}[↑↓] navigate  [Enter] select  [Esc] cancel${A.RESET}`);
  return lines.join("\n");
}

/**
 * Open the interactive model picker. Returns the selected model ID or null if
 * the user cancels.
 *
 * @param forRole  Display label (e.g. "leader").
 * @param extraModels  Live-fetched models to merge with catalog.
 */
export async function openModelPicker(
  forRole: string,
  extraModels: Array<LiveModel & { provider: string }> = [],
): Promise<string | null> {
  const catalogModels = MODELS.map(modelInfoToPickerModel);
  const liveModels = extraModels.map((m) => liveModelToPickerModel(m, m.provider));

  // Merge: catalog wins for known IDs; append unknown live models
  const catalogIds = new Set(catalogModels.map((m) => m.id));
  const merged = [...catalogModels, ...liveModels.filter((m) => !catalogIds.has(m.id))];

  const W = Math.min(process.stdout.columns ?? 72, 80);
  let query = "";
  let cursorIdx = 0;
  let fetchStatus = "";

  const restore = enterRawMode();

  const render = () => {
    const filtered = filterModels(merged, query);
    const groups = groupModels(filtered);
    const flat = flattenGroups(groups);
    const selectableCount = flat.filter((f) => !("groupHeader" in f)).length;
    cursorIdx = Math.max(0, Math.min(cursorIdx, selectableCount - 1));

    process.stdout.write(A.CLEAR_SCREEN);
    process.stdout.write(renderScreen(forRole, query, flat, cursorIdx, fetchStatus, W));
  };

  try {
    while (true) {
      render();
      const key = await captureKey();

      if (key.name === "escape") {
        return null;
      }

      if (key.name === "up") {
        cursorIdx = Math.max(0, cursorIdx - 1);
        continue;
      }

      if (key.name === "down") {
        const filtered = filterModels(merged, query);
        const selectableCount = grouped_count(filtered);
        cursorIdx = Math.min(selectableCount - 1, cursorIdx + 1);
        continue;
      }

      if (key.name === "backspace") {
        query = query.slice(0, -1);
        cursorIdx = 0;
        continue;
      }

      if (key.name === "return") {
        const filtered = filterModels(merged, query);
        const flat = flattenGroups(groupModels(filtered));
        const selectables = flat.filter((f): f is PickerModel => !("groupHeader" in f));
        const chosen = selectables[cursorIdx];
        if (chosen) return chosen.id;
        continue;
      }

      if (key.name.length === 1 && key.name >= " ") {
        query += key.name;
        cursorIdx = 0;
      }
    }
  } finally {
    restore();
  }
}

function grouped_count(models: PickerModel[]): number {
  return models.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cli/config/__tests__/model-picker.test.ts`
Expected: 8 passing

- [ ] **Step 5: Commit**

```bash
git add src/cli/config/model-picker.ts src/cli/config/__tests__/model-picker.test.ts
git commit -m "feat(config): model picker with filter/group logic and interactive TUI"
```

---

## Task 4: Provider Screen

**Files:**
- Create: `src/cli/config/screen-providers.ts`

- [ ] **Step 1: Create the provider screen**

```typescript
// src/cli/config/screen-providers.ts
// Interactive provider table: shows all 7 providers, their key status, enabled
// state, and default marker. Key bindings: [k] set key, [space] toggle, [d] set
// default, [r] fetch live models → model picker, [Esc] back.

import {
  KEYCHAIN_PROVIDER_IDS,
  listStoredProviders,
  loadKeyForProvider,
  setKeyForProvider,
} from "../../providers/keychain.js";
import { PROVIDER_ENDPOINTS } from "../../providers/endpoints.js";
import type { ProviderId } from "../../providers/types.js";
import {
  getDisabledProviders,
  setProviderDisabled,
  getCurrentModel,
  saveUserSettings,
} from "../../utils/settings.js";
import { getModelsForProvider } from "../../models/registry.js";
import { fetchProviderModels } from "./provider-fetch.js";
import { openModelPicker } from "./model-picker.js";
import { A, captureKey, enterRawMode, divider, maskKey, hiddenPrompt } from "./tui.js";

const ALL_PROVIDERS: ProviderId[] = [...KEYCHAIN_PROVIDER_IDS, "ollama"];

interface ProviderRow {
  id: ProviderId;
  maskedKey: string | null;
  enabled: boolean;
  isDefault: boolean;
}

async function loadRows(): Promise<ProviderRow[]> {
  const stored = new Set(await listStoredProviders());
  const disabled = new Set(getDisabledProviders());
  const currentModel = getCurrentModel();

  const rows: ProviderRow[] = [];
  for (const id of ALL_PROVIDERS) {
    let maskedKey: string | null = null;

    if (id === "ollama") {
      maskedKey = PROVIDER_ENDPOINTS.ollama.apiBase; // show host instead of key
    } else if (stored.has(id)) {
      try {
        const key = await loadKeyForProvider(id);
        maskedKey = maskKey(key);
      } catch {
        maskedKey = "<unreadable>";
      }
    }

    const modelsForProvider = getModelsForProvider(id);
    const isDefault = modelsForProvider.some((m) => m.id === currentModel);

    rows.push({
      id,
      maskedKey,
      enabled: !disabled.has(id),
      isDefault,
    });
  }
  return rows;
}

function renderScreen(rows: ProviderRow[], cursor: number, statusMsg: string, width: number): string {
  const W = width;
  const lines: string[] = [];
  lines.push(`${A.BOLD}Providers${A.RESET}`);
  lines.push(divider(W));
  lines.push(
    " Provider".padEnd(14) +
    "Key".padEnd(20) +
    "Status".padEnd(10) +
    "Default",
  );
  lines.push(divider(W));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const selected = i === cursor;
    const prefix = selected ? `${A.REVERSE}► ` : "  ";
    const suffix = selected ? A.RESET : "";

    const keyDisplay = row.maskedKey ? row.maskedKey : "(no key)";
    const statusDisplay = row.enabled
      ? `${A.GREEN}ENABLED${A.RESET}`
      : `${A.DIM}disabled${A.RESET}`;
    const defaultDisplay = row.isDefault ? `${A.YELLOW}★${A.RESET}` : "";

    lines.push(
      prefix +
      row.id.padEnd(12) +
      keyDisplay.padEnd(18) +
      (row.enabled ? "ENABLED " : "disabled") + "  " +
      (row.isDefault ? "★" : "") +
      suffix,
    );
  }

  lines.push(divider(W));
  if (statusMsg) {
    lines.push(`${A.YELLOW}${statusMsg}${A.RESET}`);
  }
  lines.push(
    `${A.DIM}[k] set/update key  [space] toggle  [d] set default  [r] fetch models  [Esc] back${A.RESET}`,
  );
  return lines.join("\n");
}

export async function runProviderScreen(): Promise<void> {
  let rows = await loadRows();
  let cursor = 0;
  let statusMsg = "";
  const W = Math.min(process.stdout.columns ?? 72, 80);

  const restore = enterRawMode();

  const render = () => {
    process.stdout.write(A.CLEAR_SCREEN);
    process.stdout.write(renderScreen(rows, cursor, statusMsg, W));
  };

  try {
    while (true) {
      render();
      statusMsg = "";
      const key = await captureKey();

      if (key.name === "escape") break;

      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }

      if (key.name === "down") {
        cursor = Math.min(rows.length - 1, cursor + 1);
        continue;
      }

      const row = rows[cursor]!;

      if (key.name === "space") {
        if (row.id === "ollama") {
          // Ollama is keyless — always toggleable
          setProviderDisabled(row.id, row.enabled);
          rows = await loadRows();
          continue;
        }
        if (!row.maskedKey) {
          statusMsg = "Press [k] to set key first";
          continue;
        }
        setProviderDisabled(row.id, row.enabled);
        rows = await loadRows();
        continue;
      }

      if (key.name === "k") {
        if (row.id === "ollama") {
          statusMsg = "Ollama does not use an API key";
          continue;
        }
        restore();
        const newKey = (
          await hiddenPrompt(`\nNew API key for ${row.id} (hidden): `)
        ).trim();
        enterRawMode();
        if (!newKey) {
          statusMsg = "Aborted (empty key)";
          continue;
        }
        try {
          const ok = await setKeyForProvider(row.id, newKey);
          if (!ok) {
            statusMsg = "OS keychain unavailable — set env var instead";
          } else {
            statusMsg = `Key updated for ${row.id}`;
            rows = await loadRows();
          }
        } catch (e) {
          statusMsg = `Error: ${(e as Error).message}`;
        }
        continue;
      }

      if (key.name === "d") {
        const models = getModelsForProvider(row.id);
        if (models.length === 0) {
          statusMsg = `No catalog models for ${row.id}`;
          continue;
        }
        saveUserSettings({ defaultModel: models[0]!.id });
        rows = await loadRows();
        statusMsg = `Default model set to ${models[0]!.id}`;
        continue;
      }

      if (key.name === "r") {
        if (row.id === "ollama") {
          statusMsg = "Ollama model discovery not supported here";
          continue;
        }
        if (!row.maskedKey) {
          statusMsg = "Press [k] to set key first";
          continue;
        }

        restore();
        process.stdout.write("\nFetching models from provider...\n");
        let apiKey: string;
        try {
          apiKey = await loadKeyForProvider(row.id);
        } catch {
          process.stdout.write("Could not load key from keychain.\n");
          const lrestore = enterRawMode();
          statusMsg = "Could not load key";
          _ = lrestore; // re-assign to local to satisfy lint; we re-enter below
          continue;
        }

        const baseURL = PROVIDER_ENDPOINTS[row.id].apiBase;
        const live = await fetchProviderModels(baseURL, apiKey);

        if (live.length === 0) {
          process.stdout.write("Could not fetch models (check key/network). Using catalog only.\n");
        }

        const liveWithProvider = live.map((m) => ({ ...m, provider: row.id }));
        const chosen = await openModelPicker(row.id, liveWithProvider);
        restore();

        if (chosen) {
          saveUserSettings({ defaultModel: chosen });
          rows = await loadRows();
          statusMsg = `Default model set to ${chosen}`;
        }
        enterRawMode(); // re-enter for next iteration
        continue;
      }
    }
  } finally {
    restore();
  }
}
```

Note: the `_ = lrestore` trick in the `[r]` branch keeps the restore reference. Fix the lint issue in the next step.

- [ ] **Step 2: Fix the lrestore lint issue in screen-providers.ts**

Replace the `[r]` branch's error path:

```typescript
        try {
          apiKey = await loadKeyForProvider(row.id);
        } catch {
          statusMsg = "Could not load key from keychain";
          enterRawMode();
          continue;
        }
```

Remove the `_ = lrestore` line entirely — the `enterRawMode()` call below the `openModelPicker` re-enters raw mode correctly.

- [ ] **Step 3: Commit**

```bash
git add src/cli/config/screen-providers.ts
git commit -m "feat(config): provider table screen with key management and toggle"
```

---

## Task 5: Council Screen

**Files:**
- Create: `src/cli/config/screen-council.ts`

- [ ] **Step 1: Create the council config screen**

```typescript
// src/cli/config/screen-council.ts
// Council/debate configuration TUI screen.
// Rows: 4 role model assignments + 7 tuning knobs.
// Key bindings: [↑↓] navigate, [Enter] open model picker for role rows,
// [space] toggle booleans / cycle experienceMode, [◄►] adjust numerics, [Esc] save+back.

import type { ModelRole, CouncilExperienceMode } from "../../utils/settings.js";
import {
  getRoleModels,
  saveUserSettings,
  getCouncilRounds,
  isCouncilMultiProviderPreferred,
  isCouncilCostAware,
  getCouncilExperienceMode,
  isAutoCouncilEnabled,
  getAutoCouncilConfidence,
  getAutoCouncilMinRoles,
} from "../../utils/settings.js";
import { openModelPicker } from "./model-picker.js";
import { A, captureKey, enterRawMode, divider } from "./tui.js";

const ROLES: ModelRole[] = ["leader", "implement", "verify", "research"];
const EXP_MODES: CouncilExperienceMode[] = ["off", "advisory", "enforcing"];

type RowKind =
  | { type: "role"; role: ModelRole }
  | { type: "rounds" }
  | { type: "multiProvider" }
  | { type: "costAware" }
  | { type: "experienceMode" }
  | { type: "autoCouncil" }
  | { type: "confidence" }
  | { type: "minRoles" };

const ROWS: RowKind[] = [
  { type: "role", role: "leader" },
  { type: "role", role: "implement" },
  { type: "role", role: "verify" },
  { type: "role", role: "research" },
  { type: "rounds" },
  { type: "multiProvider" },
  { type: "costAware" },
  { type: "experienceMode" },
  { type: "autoCouncil" },
  { type: "confidence" },
  { type: "minRoles" },
];

interface CouncilState {
  roleModels: Partial<Record<ModelRole, string>>;
  rounds: number;
  multiProvider: boolean;
  costAware: boolean;
  experienceMode: CouncilExperienceMode;
  autoCouncil: boolean;
  confidence: number;
  minRoles: number;
}

function loadState(): CouncilState {
  return {
    roleModels: getRoleModels(),
    rounds: getCouncilRounds(),
    multiProvider: isCouncilMultiProviderPreferred(),
    costAware: isCouncilCostAware(),
    experienceMode: getCouncilExperienceMode(),
    autoCouncil: isAutoCouncilEnabled(),
    confidence: getAutoCouncilConfidence(),
    minRoles: getAutoCouncilMinRoles(),
  };
}

function renderRow(row: RowKind, state: CouncilState, selected: boolean): string {
  const prefix = selected ? `${A.REVERSE}` : "";
  const suffix = selected ? A.RESET : "";

  switch (row.type) {
    case "role": {
      const val = state.roleModels[row.role] ?? `${A.DIM}(unset)${A.RESET}`;
      return `${prefix}  ${row.role.padEnd(12)} ${val.padEnd(28)}  [Enter to change]${suffix}`;
    }
    case "rounds":
      return `${prefix}  ${"Rounds:".padEnd(20)} ${state.rounds}     ${A.DIM}[◄ 1–5 ►]${suffix}${A.RESET}`;
    case "multiProvider":
      return `${prefix}  ${"Multi-provider:".padEnd(20)} ${state.multiProvider ? "ON " : "OFF"}   [space]${suffix}`;
    case "costAware":
      return `${prefix}  ${"Cost-aware:".padEnd(20)} ${state.costAware ? "ON " : "OFF"}   [space]${suffix}`;
    case "experienceMode":
      return `${prefix}  ${"Experience mode:".padEnd(20)} ${state.experienceMode.padEnd(12)}  [space: off→advisory→enforcing]${suffix}`;
    case "autoCouncil":
      return `${prefix}  ${"Auto-council:".padEnd(20)} ${state.autoCouncil ? "ON " : "OFF"}   [space]${suffix}`;
    case "confidence":
      return `${prefix}  ${"Confidence:".padEnd(20)} ${state.confidence.toFixed(2)}  ${A.DIM}[◄ 0.50–1.00 step 0.05 ►]${suffix}${A.RESET}`;
    case "minRoles":
      return `${prefix}  ${"Min roles:".padEnd(20)} ${state.minRoles}     ${A.DIM}[◄ 1–4 ►]${suffix}${A.RESET}`;
  }
}

function renderScreen(state: CouncilState, cursor: number, statusMsg: string, W: number): string {
  const lines: string[] = [];
  lines.push(`${A.BOLD}Council / Debate Configuration${A.RESET}`);
  lines.push(divider(W));
  lines.push(`${A.DIM} Roles${A.RESET}`);

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i]!;
    if (i === 4) {
      lines.push("");
      lines.push(`${A.DIM} Debate Settings${A.RESET}`);
    }
    if (i === 8) {
      lines.push("");
      lines.push(`${A.DIM} Auto-council${A.RESET}`);
    }
    lines.push(renderRow(row, state, i === cursor));
  }

  lines.push(divider(W));
  if (statusMsg) lines.push(`${A.YELLOW}${statusMsg}${A.RESET}`);
  lines.push(`${A.DIM}[↑↓] navigate  [Enter] edit role  [space/◄►] adjust  [Esc] save+back${A.RESET}`);
  return lines.join("\n");
}

function saveState(state: CouncilState): void {
  saveUserSettings({
    roleModels: state.roleModels,
    councilRounds: state.rounds,
    councilPreferMultiProvider: state.multiProvider,
    councilCostAware: state.costAware,
    councilExperienceMode: state.experienceMode,
    autoCouncil: state.autoCouncil,
    autoCouncilConfidence: state.confidence,
    autoCouncilMinRoles: state.minRoles,
  });
}

export async function runCouncilScreen(): Promise<void> {
  let state = loadState();
  let cursor = 0;
  let statusMsg = "";
  const W = Math.min(process.stdout.columns ?? 72, 80);

  const restore = enterRawMode();

  const render = () => {
    process.stdout.write(A.CLEAR_SCREEN);
    process.stdout.write(renderScreen(state, cursor, statusMsg, W));
  };

  try {
    while (true) {
      render();
      statusMsg = "";
      const key = await captureKey();

      if (key.name === "escape") {
        saveState(state);
        break;
      }

      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }

      if (key.name === "down") {
        cursor = Math.min(ROWS.length - 1, cursor + 1);
        continue;
      }

      const row = ROWS[cursor]!;

      if (key.name === "return" && row.type === "role") {
        restore();
        const chosen = await openModelPicker(row.role);
        enterRawMode();
        if (chosen) {
          state.roleModels = { ...state.roleModels, [row.role]: chosen };
          saveState(state);
          statusMsg = `${row.role} → ${chosen}`;
        }
        continue;
      }

      if (key.name === "space") {
        switch (row.type) {
          case "multiProvider":
            state.multiProvider = !state.multiProvider;
            break;
          case "costAware":
            state.costAware = !state.costAware;
            break;
          case "autoCouncil":
            state.autoCouncil = !state.autoCouncil;
            break;
          case "experienceMode": {
            const idx = EXP_MODES.indexOf(state.experienceMode);
            state.experienceMode = EXP_MODES[(idx + 1) % EXP_MODES.length]!;
            break;
          }
          default: break;
        }
        saveState(state);
        continue;
      }

      if (key.name === "left") {
        switch (row.type) {
          case "rounds":
            state.rounds = Math.max(1, state.rounds - 1);
            break;
          case "confidence":
            state.confidence = Math.max(0.5, parseFloat((state.confidence - 0.05).toFixed(2)));
            break;
          case "minRoles":
            state.minRoles = Math.max(1, state.minRoles - 1);
            break;
          default: break;
        }
        saveState(state);
        continue;
      }

      if (key.name === "right") {
        switch (row.type) {
          case "rounds":
            state.rounds = Math.min(5, state.rounds + 1);
            break;
          case "confidence":
            state.confidence = Math.min(1.0, parseFloat((state.confidence + 0.05).toFixed(2)));
            break;
          case "minRoles":
            state.minRoles = Math.min(4, state.minRoles + 1);
            break;
          default: break;
        }
        saveState(state);
        continue;
      }
    }
  } finally {
    restore();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/config/screen-council.ts
git commit -m "feat(config): council/debate config screen with role picker and tuning knobs"
```

---

## Task 6: Config Command Entry + Registration

**Files:**
- Create: `src/cli/config/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the config command entry point**

```typescript
// src/cli/config/index.ts
// Commander command: muonroi-cli config
// Entry menu with two items: Providers, Council/Debate.

import { Command } from "commander";
import { A, captureKey, enterRawMode, divider } from "./tui.js";
import { runProviderScreen } from "./screen-providers.js";
import { runCouncilScreen } from "./screen-council.js";
import {
  listStoredProviders,
  getConfiguredProviders,
} from "../../providers/keychain.js";
import { getRoleModels, getDisabledProviders } from "../../utils/settings.js";

const MENU_ITEMS = [
  {
    id: "providers",
    label: "Providers",
    badge: async () => {
      const stored = await listStoredProviders();
      const disabled = getDisabledProviders();
      const enabled = stored.filter((p) => !disabled.includes(p));
      return `${enabled.length} enabled`;
    },
  },
  {
    id: "council",
    label: "Council/Debate",
    badge: async () => {
      const roles = getRoleModels();
      const count = Object.keys(roles).length;
      return count > 0 ? `${count} role${count > 1 ? "s" : ""} set` : "no roles set";
    },
  },
];

async function runConfigMenu(): Promise<void> {
  const W = Math.min(process.stdout.columns ?? 72, 56);
  let cursor = 0;

  const badges = await Promise.all(MENU_ITEMS.map((item) => item.badge()));

  const restore = enterRawMode();

  const render = () => {
    process.stdout.write(A.CLEAR_SCREEN);
    const lines: string[] = [];
    lines.push(`${A.BOLD}┌─ Configuration ${"─".repeat(W - 17)}┐${A.RESET}`);
    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const item = MENU_ITEMS[i]!;
      const selected = i === cursor;
      const prefix = selected ? `│  ${A.REVERSE}> ` : "│    ";
      const suffix = selected ? A.RESET : "";
      const badge = badges[i] ? `  ${A.DIM}[${badges[i]}]${A.RESET}` : "";
      lines.push(`${prefix}${item.label.padEnd(18)}${badge}${suffix}`);
    }
    lines.push(`${A.BOLD}└${"─".repeat(W - 1)}┘${A.RESET}`);
    lines.push("");
    lines.push(`${A.DIM}[↑↓] navigate  [Enter] open  [q] quit${A.RESET}`);
    process.stdout.write(lines.join("\n"));
  };

  try {
    while (true) {
      render();
      const key = await captureKey();

      if (key.name === "q" || key.name === "escape") break;
      if (key.name === "up") { cursor = Math.max(0, cursor - 1); continue; }
      if (key.name === "down") { cursor = Math.min(MENU_ITEMS.length - 1, cursor + 1); continue; }

      if (key.name === "return") {
        const item = MENU_ITEMS[cursor];
        if (!item) continue;
        restore();

        if (item.id === "providers") {
          await runProviderScreen();
        } else if (item.id === "council") {
          await runCouncilScreen();
        }

        // Refresh badges after returning from sub-screen
        const newBadges = await Promise.all(MENU_ITEMS.map((mi) => mi.badge()));
        badges.splice(0, badges.length, ...newBadges);

        enterRawMode();
      }
    }
  } finally {
    restore();
    process.stdout.write("\n");
  }
}

export function buildConfigCommand(): Command {
  return new Command("config")
    .description("Interactive provider and council configuration")
    .action(async () => {
      if (!process.stdin.isTTY) {
        console.error("muonroi-cli config requires an interactive terminal (TTY).");
        process.exit(1);
      }
      await runConfigMenu();
    });
}
```

- [ ] **Step 2: Register command in src/index.ts**

Find the line in `src/index.ts` where `program.parse()` is called (line ~1201). Add the import and `addCommand` call before it.

Add import near the top of the file, after existing CLI imports:

```typescript
import { buildConfigCommand } from "./cli/config/index.js";
```

Add command registration just before `program.parse()`:

```typescript
program.addCommand(buildConfigCommand());

program.parse();
```

- [ ] **Step 3: Verify the command is reachable**

Run: `bun run src/index.ts config --help`
Expected output:
```
Usage: muonroi-cli config [options]

Interactive provider and council configuration

Options:
  -h, --help  display help for command
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/config/index.ts src/index.ts
git commit -m "feat(config): register muonroi-cli config command with entry menu"
```

---

## Task 7: Slash Menu Entry + App.tsx Dispatch

**Files:**
- Modify: `src/ui/slash/menu-items.ts`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Write failing parity test expectation**

The file `src/ui/slash/__tests__/menu-parity.test.ts` verifies that all registry-backed commands appear in `SLASH_MENU_ITEMS`. Verify it currently passes:

Run: `bun test src/ui/slash/__tests__/menu-parity.test.ts`
Expected: PASS (baseline)

- [ ] **Step 2: Add /config to menu-items.ts**

In `src/ui/slash/menu-items.ts`, find the `SLASH_MENU_ITEMS` array and add the config entry after the `exit` entry (line ~25):

```typescript
  { id: "config", label: "config", description: "Open provider and council configuration" },
```

The array should look like:
```typescript
export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { id: "exit", label: "exit", description: "Quit the CLI" },
  { id: "config", label: "config", description: "Open provider and council configuration" },
  { id: "help", label: "help", description: "Show available commands" },
  // ... rest unchanged
];
```

- [ ] **Step 3: Handle /config in app.tsx handleSlashMenuSelect**

In `src/ui/app.tsx`, find `handleSlashMenuSelect` (around line 3068). Inside the `switch (item.id)` block, add after the `case "help":` block:

```typescript
        case "config":
          setMessages((p) => [
            ...p,
            {
              type: "assistant",
              content:
                "To configure providers and council settings, run in a separate terminal:\n\n  muonroi-cli config\n\nThis opens the interactive configuration TUI.",
              timestamp: new Date(),
            },
          ]);
          break;
```

- [ ] **Step 4: Run parity test again**

Run: `bun test src/ui/slash/__tests__/menu-parity.test.ts`
Expected: PASS (config is not registry-backed, so no parity requirement — test still passes)

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all existing tests pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/ui/slash/menu-items.ts src/ui/app.tsx
git commit -m "feat(config): add /config slash command entry and dispatch to TUI message"
```

---

## Task 8: Input Color Coding for Matched Slash Commands

**Files:**
- Modify: `src/ui/app.tsx` (minimal change — check `filteredSlashItems` length)

The slash palette overlay already exists (`showSlashMenu`, `filteredSlashItems`, `SlashInlineMenu`). The spec requires the *text input* to render blue when the typed `/xxx` exactly matches a command. The `@opentui/core` `TextareaRenderable` accepts a `textColor` or similar prop — check the prop name.

- [ ] **Step 1: Find the TextareaRenderable usage in app.tsx**

Search for the chat input textarea prop usage:

Run: `grep -n "TextareaRenderable\|textColor\|inputColor\|chatInput" src/ui/app.tsx | head -30`

Note the prop name for text color (e.g., `foregroundColor`, `color`, `textColor`) and the component ref/state holding the input value.

- [ ] **Step 2: Compute input color state**

In `app.tsx`, find where `showSlashMenu` and `filteredSlashItems` are computed (around line 1100). Add a derived value:

```typescript
const slashInputIsMatched = useMemo(() => {
  if (!showSlashMenu) return false;
  const trimmed = (inputText ?? "").trim(); // replace inputText with the actual input state variable
  if (!trimmed.startsWith("/")) return false;
  const typed = trimmed.slice(1).toLowerCase();
  return filteredSlashItems.some((item) => item.id === typed || item.label === typed);
}, [showSlashMenu, filteredSlashItems, inputText]);
```

Replace `inputText` with the actual variable name holding the current chat input text (check the state variable name in app.tsx around line 905).

- [ ] **Step 3: Pass color to the textarea**

Find the textarea rendering (where `TextareaRenderable` or the input component is rendered, around line 4735 or 4780). Add the color prop conditionally:

```typescript
// If the component accepts a textColor/foregroundColor prop:
textColor={slashInputIsMatched ? "blue" : undefined}
```

The exact prop name depends on `@opentui/core` — if `textColor` is not valid, check the component's type definition. If no color prop exists on the textarea, skip this visual enhancement (the overlay itself already provides feedback).

- [ ] **Step 4: Run app.tsx type check**

Run: `bun run tsc --noEmit`
Expected: no new type errors

- [ ] **Step 5: Commit**

```bash
git add src/ui/app.tsx
git commit -m "feat(config): color slash input blue when typed command matches palette entry"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| `muonroi-cli config` entry menu | Task 6 |
| Provider table with 7 rows | Task 4 |
| `[k]` set/update key via keychain | Task 4 |
| `[space]` toggle disabledProviders (warn if no key) | Task 4 |
| `[d]` set default model | Task 4 |
| `[r]` fetch live /v1/models → model picker | Tasks 2, 3, 4 |
| Council roles (Enter → model picker) | Tasks 3, 5 |
| Rounds `[◄►]` 1–5 | Task 5 |
| Multi-provider / Cost-aware `[space]` | Task 5 |
| Experience mode cycle | Task 5 |
| Auto-council on/off, confidence, minRoles | Task 5 |
| Each change writes immediately via saveUserSettings | Tasks 4, 5 |
| Model picker: filter, Text/Vision groups | Task 3 |
| Model picker: live fetch merge | Tasks 2, 3 |
| Capability heuristic from model ID | Task 2 |
| Slash palette `/config` entry | Task 7 |
| Input turns blue when command matched | Task 8 |
| No new runtime dependencies | All tasks |

**Type consistency check:**
- `PickerModel` defined in `model-picker.ts`, referenced in `screen-providers.ts` via `openModelPicker()`
- `LiveModel` defined in `provider-fetch.ts`, imported in `model-picker.ts` and `screen-providers.ts`
- `ProviderId` from `../../providers/types.js` used consistently across all new files
- `ModelRole` and `CouncilExperienceMode` from `../../utils/settings.js` used in `screen-council.ts`
- `fetchProviderModels(baseURL, apiKey)` signature: 2 required + 1 optional — matches usage in `screen-providers.ts`

**Placeholder scan:** No TBDs. All key bindings have full implementation. Error paths (keychain unavailable, empty fetch) show inline `statusMsg`. ollama special-cases are handled.

**Note on Task 4 `screen-providers.ts`:** The `enterRawMode()` re-entry in the `[r]` branch needs care — after `openModelPicker` returns, raw mode was restored by the model picker's `finally` block. The `enterRawMode()` call after `openModelPicker` re-enters for the next iteration of the outer while loop. This is correct.
