# MCP Research Integration — Design Spec

**Date:** 2026-05-08
**Author:** muonroi (via Claude brainstorming)
**Scope:** Phase 1 (foundation). Future phases for cache, PIL routing, built-in fallback are out of scope.
**Status:** Draft → pending user review.

---

## 1. Problem Statement

`muonroi-cli` currently has no internet research capability. The agent grounds itself only in the codebase (`grep`, `read_file`) and the model's training cutoff. This produces stale, "tù" answers for:

- Library APIs that changed after model cutoff
- Recent CVEs / breaking changes
- Framework migration questions
- Debugging errors not in training data

The MCP runtime (`src/mcp/runtime.ts`, `@ai-sdk/mcp`, `@modelcontextprotocol/sdk`) is **already wired up**. Default config in `src/mcp/auto-setup.ts` registers `filesystem`, `playwright`, `memory`, `figma` — but no research-oriented servers.

This spec adds three MCP servers to fill the gap, with first-run onboarding for the one that requires a paid key.

## 2. Goals & Non-Goals

### Goals

- Add `context7`, `fetch`, `tavily` MCP servers to default config.
- Onboard new users through the existing first-run wizard, prompting for a Tavily API key (skippable).
- Migrate existing users with a one-time prompt for Tavily; silently enable `context7` + `fetch` (no key needed).
- Store Tavily key via the existing `keychain.ts` pattern (OS keychain → env → settings.json).
- Surface the three servers in the `/mcp add` catalog UI.

### Non-Goals (deferred to later phases)

- Qdrant cache layer for search results.
- PIL routing logic (intent → MCP server).
- PreToolUse research-gate hook.
- Built-in `web_search` / `web_fetch` tools as zero-config fallback.
- Council debate role `challenger-web` requiring web evidence.
- Multiple search provider support (Brave, Exa) — Tavily only for this phase.

## 3. Architecture

```
User → Onboarding (wizard | migration prompt | /mcp setup)
     → settings.json + OS keychain
     → src/mcp/auto-setup.ts (DEFAULT_CONFIGS expanded)
     → src/mcp/runtime.ts (existing, unchanged)
     → ToolSet { mcp_context7_*, mcp_fetch_*, mcp_tavily_* }
     → Orchestrator → Model decides usage per turn
```

### MCP server inventory

| ID | Label | Transport | URL / Command | Key | Default enabled |
|---|---|---|---|---|---|
| `context7` | Context7 (Library Docs) | http | `https://mcp.context7.com/mcp` | optional (free tier) | true |
| `fetch` | Fetch (URL → markdown) | stdio | `npx -y @modelcontextprotocol/server-fetch` | none | true |
| `tavily` | Tavily Web Search | stdio | `npx -y tavily-mcp` | required (`TAVILY_API_KEY`) | true if key present, else false |

### Module boundaries

| Module | Responsibility | Status |
|---|---|---|
| `src/mcp/auto-setup.ts` | Append three servers to `DEFAULT_CONFIGS`. Add migration logic: if user already has settings file but missing `context7`/`fetch`, append silently. Tavily migration handled by onboarding module. | Edit |
| `src/mcp/catalog.ts` | Add three entries to `POPULAR_MCP_CATALOG` for `/mcp add` UI. | Edit |
| `src/mcp/research-onboarding.ts` | New module. Exports `runResearchOnboarding(opts)` for first-run wizard and `runResearchMigrationPrompt(opts)` for existing users. Handles Tavily key prompt, validation, keychain write. | Create |
| `src/providers/keychain.ts` | Add `tavily` to `KEYCHAIN_SERVICE` accounts and `ENV_BY_PROVIDER` mapping (or factor out a separate `loadMcpKey` helper if `ProviderId` is too tight a coupling). | Edit |
| `src/cli/` (first-run flow) | After main API key step, call `runResearchOnboarding`. | Edit (location TBD by plan phase) |
| `src/cli/` (startup) | After settings load, call `runResearchMigrationPrompt` once if `webResearchPrompted` flag missing in settings. | Edit (location TBD by plan phase) |
| `src/utils/settings.ts` | Add `webResearchPrompted: boolean` field to settings schema. | Edit |

## 4. Data Flow

### 4.1 First-run wizard (new user)

```
1. User runs `muonroi-cli` first time.
2. Existing flow asks main API key (Anthropic/OpenAI/etc.).
3. NEW STEP: "Enable web research? [Y/n]" (default Y).
   3a. If Y: "Tavily API key (free tier 1k/mo at tavily.com, leave blank to skip): "
       - If key entered: validate via a minimal `POST https://api.tavily.com/search` with `query: "ping"` and `max_results: 1` (auth check); on HTTP 200 store in keychain and set `tavily.enabled=true`.
       - If blank: tavily.enabled=false, user can run `/mcp setup tavily` later.
   3b. If n: tavily.enabled=false.
4. Always: write context7 + fetch to settings (enabled=true).
5. Set webResearchPrompted=true.
6. Continue to existing flow.
```

### 4.2 Migration prompt (existing user)

```
1. User updates to new version, runs `muonroi-cli`.
2. Settings load. Detect: webResearchPrompted !== true.
3. Silently merge context7 + fetch into mcpServers if absent (enabled=true).
4. Show one-time prompt:
   "📚 New: web research is available.
    • context7 (library docs) and fetch (URL extraction) — enabled.
    • Tavily web search needs a free API key (tavily.com).
    Set up Tavily now? [Y/n/never]"
5. Y → same Tavily key flow as 3a.
6. n → skip this session, ask again next start.
7. never → set webResearchPrompted=true, never ask again.
8. Y after key save → set webResearchPrompted=true.
```

### 4.3 Explicit setup (`/mcp setup tavily`)

```
1. User runs slash command from REPL.
2. Prompt for key (with link to tavily.com).
3. Validate, store in keychain, flip tavily.enabled=true in settings.
4. Reload MCP runtime so tools become available without restart (if runtime supports hot reload; otherwise inform user to restart).
```

### 4.4 Tool execution path (no change to runtime)

```
Model emits tool call → mcp_tavily_search(query="...")
  → runtime.ts dispatches to spawned tavily-mcp process
  → tavily-mcp reads TAVILY_API_KEY from env (loaded from keychain at spawn)
  → returns search results JSON
  → orchestrator delivers to model as tool result
```

## 5. Error Handling

| Failure | Behavior |
|---|---|
| User enters invalid Tavily key in wizard | Show "key validation failed (HTTP 401). Try again or skip?" — re-prompt up to 3 times, then skip with `tavily.enabled=false`. |
| Tavily key valid in wizard but API down at runtime | Tool call returns error; model sees error string, retries or falls back to `context7`/`fetch`. No crash. |
| context7 HTTP endpoint unreachable | `runtime.ts` already collects errors per server (`McpToolBundle.errors`); show non-fatal warning at startup, continue without context7 tools. |
| `npx tavily-mcp` package install fails (offline / npm issue) | Stdio transport spawn fails; existing error path in `runtime.ts` reports it; user can retry or disable in `/mcp` menu. |
| User skips wizard, later runs `/mcp setup tavily` | Same key prompt + validate + keychain write. |
| Migration prompt: user picks "never" then changes mind | Document in `/help`: "Run `/mcp setup tavily` anytime." |
| Settings file corrupt or missing `webResearchPrompted` | Treat as `false` → trigger migration prompt. Idempotent. |

## 6. Testing Strategy

| Layer | Test | File |
|---|---|---|
| Unit | `runResearchOnboarding` — Y path stores key, n path sets disabled, blank key skips, invalid key re-prompts | `src/mcp/__tests__/research-onboarding.test.ts` |
| Unit | `runResearchMigrationPrompt` — silent merge of context7+fetch, prompts only when flag absent, "never" sets flag | same file |
| Unit | Keychain write/read for `tavily` account | extend `src/providers/keychain.test.ts` |
| Unit | `auto-setup.ts` migration: existing user missing context7 → appended; existing context7 entry preserved (no overwrite) | `src/mcp/__tests__/auto-setup.test.ts` (create or extend) |
| Integration | Spawn `tavily-mcp` with fake `TAVILY_API_KEY=test` env, assert tool registration `mcp_tavily_search` appears in ToolSet | extend `src/mcp/smoke.test.ts` |
| Manual | First-run flow on clean machine — wizard appears, key validates, tools work in next turn | manual checklist in PR |
| Manual | Update path on existing install — migration prompt appears once, accepting "never" prevents re-prompt | manual checklist |

## 7. Security & Privacy

- Tavily key stored in OS keychain via `keytar` (already in deps), same pattern as Anthropic/OpenAI keys. Fallback to `TAVILY_API_KEY` env var.
- Key never logged. Reuse `redactor.ts` for any debug output that touches the key.
- context7 HTTP endpoint is over TLS; no key required for free tier so no secret transit.
- `fetch` MCP can hit arbitrary URLs — same risk as existing Playwright MCP. Document in `/help` that `fetch` will be used by the model autonomously.

## 8. Rollout & Versioning

- Bump to `v1.3.0` (minor — new feature, backward compatible).
- CHANGELOG entry: "Added MCP-based web research: context7 (library docs), fetch (URL → markdown), Tavily (web search). First-run wizard and migration prompt for Tavily key."
- No flag-gated rollout — feature is opt-in by design (Tavily) and zero-cost (context7, fetch).

## 9. Open Questions Deferred to Plan Phase

- Exact location in CLI startup code where the wizard hook goes (depends on existing first-run code structure not yet read in detail).
- Whether to support hot-reload of MCP runtime after `/mcp setup tavily`, or require restart (depends on `runtime.ts` API).
- Migration prompt UI: terminal `prompts` library vs `@opentui/react` modal — match existing wizard style.

These are implementation details, not design decisions.
