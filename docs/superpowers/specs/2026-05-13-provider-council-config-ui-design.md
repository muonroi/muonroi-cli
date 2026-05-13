# Design: Provider & Council Config UI + Slash Command Palette

**Date:** 2026-05-13  
**Status:** Approved

---

## Problem

Three UX gaps that force users to manually edit `~/.muonroi-cli/user-settings.json`:

1. First-run wizard configures only one provider; adding more, disabling, or rotating keys requires raw JSON edits.
2. Council debate roles (`leader`, `implement`, `verify`, `research`) and tuning knobs (`councilRounds`, `councilCostAware`, etc.) have no interactive surface.
3. The main TUI has no slash command palette — users must remember command names; typed `/` is indistinguishable from free text visually.

---

## Scope

| Feature | Delivery |
|---------|----------|
| `muonroi-cli config` — Provider screen | This spec |
| `muonroi-cli config` — Council/Debate screen | This spec |
| Slash command palette in TUI chat input | This spec |
| General Settings screen (sandbox, LSP, autoCompact) | Future |

---

## Architecture

### New files

```
src/cli/config/
  index.ts            - Commander command: buildConfigCommand()
  tui.ts              - Raw-mode primitives: renderBox, captureKey, hiddenPrompt
  screen-providers.ts - Provider table screen
  screen-council.ts   - Council config screen
  model-picker.ts     - Model browser (catalog + live /v1/models)
  provider-fetch.ts   - Calls provider /v1/models endpoint
```

### Modified files

| File | Change |
|------|--------|
| `src/index.ts` | `program.addCommand(buildConfigCommand())` |
| `src/ee/render.ts` (or equivalent TUI input handler) | Slash palette integration |

### No new runtime dependencies

Uses `readline` + raw stdin (pattern already exists in `src/cli/keys.ts:promptHidden()`). ANSI escape codes for color/cursor. Commander for CLI registration.

---

## Feature 1: `muonroi-cli config`

### Entry menu

```
muonroi-cli config

┌─ Configuration ──────────────────────┐
│  > Providers      [3 configured]     │
│    Council/Debate [roles set]        │
└──────────────────────────────────────┘

[↑↓] navigate  [Enter] open  [q] quit
```

Main menu renders 2 items. Status badges read live from settings + keychain.

---

### Screen 1: Providers

```
Providers
────────────────────────────────────────────────────────
 Provider     Key              Status    Default
────────────────────────────────────────────────────────
>► anthropic    sk-ant-…4a2b    ENABLED   ★
   openai       (no key)        disabled
   google       AIza…9f3c       ENABLED
   deepseek     (no key)        disabled
   siliconflow  sk-sf-…abc1     ENABLED
   xai          (no key)        disabled
   ollama       localhost:11434 ENABLED
────────────────────────────────────────────────────────
[k] set/update key  [space] toggle enable  [d] set default  [r] fetch models  [Esc] back
```

#### Key bindings

| Key | Action |
|-----|--------|
| ↑ / ↓ | Move cursor |
| Space | Toggle `disabledProviders[]`. Blocked (with hint) if provider has no key. |
| k | Hidden prompt → `setKeyForProvider(provider, key)` via keychain |
| d | Set `defaultModel` to the first text model of this provider in catalog |
| r | Fetch `/v1/models` from provider endpoint, open Model Browser for that provider |
| Esc | Return to main menu |

#### Data sources

- **Keys:** `listStoredProviders()` + `loadKeyForProvider()` per row (masked display)
- **Status:** `isProviderDisabled(id)` from `getDisabledProviders()`
- **Default:** compare `getCurrentModel()` against `getModelsForProvider(id)[0]`

#### Constraints

- `[space]` toggle on a provider with no key shows inline warning: `"Press [k] to set key first"`
- `[d]` on ollama sets `defaultModel` to first ollama model in catalog (no key required)
- After `[k]`: re-read masked key in-place without re-rendering full screen

---

### Screen 2: Council / Debate

```
Council / Debate Configuration
────────────────────────────────────────────────────────
 Roles
   leader:      claude-opus-4-7       [Enter to change]
   implement:   gpt-4o                [Enter to change]
   verify:      (unset)               [Enter to set]
   research:    (unset)               [Enter to set]

 Debate Settings
   Rounds:             3     [◄ 1–5 ►]
   Multi-provider:     OFF   [space]
   Cost-aware:         ON    [space]
   Experience mode:    advisory  [space: off→advisory→enforcing]

 Auto-council
   Enabled:            ON    [space]
   Confidence:         0.85  [◄ 0.50–1.00 step 0.05 ►]
   Min roles:          2     [◄ 1–4 ►]
────────────────────────────────────────────────────────
[↑↓] navigate  [Enter] edit role  [space/◄►] adjust  [Esc] back
```

#### Key bindings

| Key | Action |
|-----|--------|
| ↑ / ↓ | Move cursor between rows |
| Enter | On a role row → open Model Picker |
| Space | Toggle boolean settings; cycle `experienceMode` |
| ◄ / ► | Adjust numeric values (rounds, confidence, minRoles) |
| Esc | Save all pending changes, return to main menu |

#### Persistence

Each change writes immediately via `saveUserSettings()` (no separate Save action needed — matches existing `setProviderDisabled()` pattern).

---

### Sub-feature: Model Picker

Opened from Council role rows and optionally from Provider `[r]`.

```
Select model for: leader
────────────────────────────────────────────
Filter: [/type to search____________]

Text / Chat
  claude-opus-4-7          anthropic  premium
  claude-sonnet-4-6        anthropic  balanced
> gpt-4o                   openai     premium
  deepseek-v3              deepseek   balanced
  Qwen/Qwen3-235B-A22B     siliconflow premium  ← from live /models fetch

Vision / Multimodal
  claude-opus-4-7          anthropic  premium
  gemini-2.0-flash         google     balanced

[r] Fetch live models for a provider  [Enter] select  [Esc] cancel
```

#### Grouping logic

- `supportsVision === true` → "Vision / Multimodal" group
- All others → "Text / Chat" group
- Future: "Image Generation", "Video" when `ModelInfo` gains `modalities` field

#### Live model fetch (`provider-fetch.ts`)

Triggered by `[r]` or auto-triggered when user selects a provider whose models are not in catalog:

1. Read stored API key for provider via `loadKeyForProvider()`
2. GET `{baseURL}/v1/models` with `Authorization: Bearer {key}`
3. Parse OpenAI-compatible response (`data[].id`, `data[].object`, optional `data[].capabilities`)
4. Map to lightweight display model: `{ id, displayName, capability: "text"|"vision"|"image"|"video" }`
5. Capability heuristic from model ID if API doesn't return modalities:
   - contains `vision|vl|multimodal` → vision
   - contains `flux|stable-diffusion|imagen|dall-e` → image
   - contains `video|wan|kling|hailuo` → video
   - default → text
6. Merge with catalog models (catalog entries take priority for known IDs)

---

## Feature 2: Slash Command Palette in TUI

When the user types `/` as the first character of their input in the chat prompt, the TUI shows a command palette overlay — matching Claude CLI behavior.

### Color behavior

| Condition | Input color |
|-----------|-------------|
| `/` followed by text that matches a known command | **Blue** (ANSI `\x1b[34m` or bright blue `\x1b[94m`) |
| `/` followed by text with no match (free text or partial) | **White** (default) |
| No leading `/` | Default terminal color |

### Palette overlay

```
) /co█

/color                  Set the prompt bar color for this session
/compact                Free up context by summarizing the conversation so far
/config                 Open config panel
/context                Visualize current context usage as a colored grid
/copy                   Copy last response to clipboard
```

- Filters in real-time as user types after `/`
- Matched prefix: command name rendered in **blue**, description in dim white
- `[↑↓]` navigate list, `[Tab]` or `[Enter]` complete selected command
- `[Esc]` dismiss palette, keep typed text as free text (sends as normal message)
- When typed text exactly matches one command: input turns blue; description appears inline

### Known commands list

Defined in a static registry (like Claude Code's slash commands). Commands include:
- Built-in CLI commands (`/config`, `/keys`, `/update`, etc.)
- Session commands (`/clear`, `/compact`, `/context`, etc.)
- Future: user-defined shortcuts

### Implementation location

The input handler in the main TUI loop (wherever the chat prompt reads keyboard input). The palette renders above the input line using ANSI cursor-up + clear-line before the next render tick.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Keychain unavailable | `[k]` shows error inline: "OS keychain unavailable — set env var instead" |
| `/v1/models` fetch fails | Model picker shows: "Could not fetch models (check key/network). Using catalog only." |
| Catalog empty | Model picker shows catalog models only; `[r]` still available |
| Invalid model ID selected | `saveUserSettings` validates against catalog; shows warning if not found |

---

## Out of Scope

- General Settings screen (sandbox, LSP, autoCompact, shell) — future milestone
- Bitwarden import flow changes — existing `keys import-bw` unchanged
- MCP key management — existing flow unchanged
- Video/image model capability fields in `ModelInfo` — heuristic fallback is sufficient for now
