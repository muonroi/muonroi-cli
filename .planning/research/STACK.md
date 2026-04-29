# Technology Stack — muonroi-cli

**Project:** muonroi-cli (BYOK AI coding agent CLI, fork of grok-cli)
**Researched:** 2026-04-29
**Overall confidence:** HIGH for runtime/SDK choices, MEDIUM for fringe (auth pricing, packaging)
**Versions verified via:** npm registry (live `npm view` queries on 2026-04-29) + Context7 `/vercel/ai`, `/anomalyco/opentui`

> **TL;DR for the roadmapper:** Keep Bun + OpenTUI + AI SDK v6 + React 19 + MCP + LSP — they are *current*, not stale. But:
> 1. **Pin OpenTUI to `0.1.x`** (last `0.1.107`), not `0.2.0` which broke API yesterday and is too fresh for a 6-week beta.
> 2. **Replace `@ai-sdk/xai` (inherited) with `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google` + `@ai-sdk/openai-compatible` (DeepSeek/SiliconFlow) + `ollama-ai-provider-v2`.**
> 3. **Drop `@coinbase/agentkit`, `grammy` (Telegram), `agent-desktop`** — already in IDEA.md `delete` list.
> 4. **Stay on AI SDK v6 stable, not v7-beta**, until v7 hits stable in 2026 H2.
> 5. **Bun-only at runtime** is OK because TUI is the only Bun-side; EE backend stays Node 20. HTTP/IPC bridges them.

---

## Recommended Stack

### CLI Runtime (TUI side)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **Bun** | `1.3.13` (released 2026-04-20) | TUI runtime + bundler + test runner + native `--compile` for binaries | Inherited from grok-cli. OpenTUI is Bun-only (Node/Deno "in development" per official docs). Bun `--compile` produces single-file standalone binaries — solves CLI distribution without `pkg`/`nexe`. |
| **TypeScript** | `5.9.3` (grok-cli) → bump to `5.9.x` latest | Source language | Bun runs TS natively, no compile step in dev. Use `tsc --noEmit` for typecheck only. |
| **React** | `19.2.5` | TUI declarative rendering via OpenTUI react-reconciler | Locked by OpenTUI 0.2.0 (`react-reconciler ^0.32.0`) and by Ink v7 (`>=19.2.0`). React 19 is stable, no migration risk. |
| **@opentui/core** | **`0.1.107`** (NOT 0.2.0) | Native Zig TUI renderer | **0.2.0 shipped 2026-04-28 (yesterday) and bumped `react-reconciler` from 0.31→0.32.** That's a 17-hour-old release; no chance of beta-tier stability validation in our 6-week timeline. Pin to last 0.1.x and re-evaluate at Phase 3. |
| **@opentui/react** | **`0.1.107`** | React renderer binding | Same pin reason. |

**Confidence: HIGH** for Bun/React/TypeScript. **HIGH** for the *0.2.0 pin-back recommendation* (release date is fact-verified).

### AI Layer (Multi-Provider)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **ai** | `6.0.169` (latest stable) | Provider-agnostic abstraction: `streamText`, `generateText`, tool-use, agent loop (`stopWhen` + `isStepCount`) | **Stay on v6 stable. v7 is in beta (`7.0.0-beta.113` as of 2026-04-28).** v7 will land in 2026 H2 — too risky for a 6-week beta. v6 has uniform `streamText` + tools + structured outputs across all 5 providers we need. Confirmed via Context7 `/vercel/ai`. |
| **@ai-sdk/anthropic** | `3.0.72` | Claude Sonnet/Opus/Haiku adapter | Official, first-class. Used in MCP-equipped tool-call agent loops (Context7 verified). |
| **@ai-sdk/openai** | `3.0.54` | GPT-4o / GPT-5 / o-series adapter | Official. Includes `openai.responses(...)` for the new responses API and `customTool` for grammar-constrained outputs. |
| **@ai-sdk/google** | `3.0.65` | Gemini 1.5/2.x adapter | Official. Use `@ai-sdk/google` (Gemini API) NOT `@ai-sdk/google-vertex` (`4.0.113`) unless we need Vertex AI billing. Vertex requires GCP project; consumer Gemini is BYOK-friendly. |
| **@ai-sdk/openai-compatible** | `2.0.42` | DeepSeek + SiliconFlow + any other OpenAI-compatible endpoint | **One adapter handles both DeepSeek and SiliconFlow.** Don't use `@ai-sdk/deepseek` (`3.5.0`) — the dedicated package is fine but `openai-compatible` lets us add new providers (Together, Groq, Fireworks, OpenRouter) without new dependencies. |
| **ollama-ai-provider-v2** | `1.50.1` (active, last published 2026-03-17) | Ollama warm-tier (qwen2.5-coder on VPS) | Official `ollama-ai-provider` (`1.2.0`) was abandoned 2025-01-17. The community-maintained `-v2` fork is what everyone uses now. Confidence: HIGH (npm publish dates verified). |
| **@ai-sdk/mcp** | `1.0.37` | Bridge AI SDK tool calls to MCP servers | Released by Vercel 2026-04-29 (yesterday) at v1 stable. Lets `streamText({ tools })` consume MCP tools natively. **Use this together with `@modelcontextprotocol/sdk` for the client.** |
| **@modelcontextprotocol/sdk** | `1.29.0` | MCP client (and server, if we ship one) | Anthropic-maintained official SDK. Already battle-tested in grok-cli at 1.27.1; the bump to 1.29 is non-breaking. Note: pulls in Express 5, Hono, jose — sizable transitive dep tree but unavoidable. |

**Confidence: HIGH.** Versions verified live on npm 2026-04-29.

### LSP / Code Intel

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **vscode-jsonrpc** | `8.2.1` | Low-level JSON-RPC transport for LSP | Official Microsoft, stable since 2024. grok-cli already uses it. No drop-in alternative. |
| **vscode-languageserver-types** | `3.17.5` | LSP type definitions | Official, stable. Don't pull in `vscode-languageclient` (`9.0.1`) — that's a VS Code extension client, not for CLIs. We talk to LSPs directly via stdio + jsonrpc. |
| **web-tree-sitter** | `0.26.8` | Hot-path classifier (regex → AST patterns when needed) | **Use the WASM build, not the native `tree-sitter` (`0.25.0`) Node addon.** Native `tree-sitter` is 0.25 last published 2025-06, and Node native modules are *the* Bun gotcha (FFI mismatches across Bun/Node). WASM runs identically in Bun and Node. |
| **tree-sitter-typescript / -javascript / -python / etc.** | Per-grammar | Language grammars for the classifier | Pull only the languages we route on. WASM grammars are ~500KB each. |

**Confidence: HIGH** for vscode-* packages. **MEDIUM** for tree-sitter-WASM choice — the rationale is correct (Bun FFI gotchas with native addons are well-documented) but the team should validate WASM perf on a 2K-token classifier query before committing the entire hot path.

### Vector DB Client

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **@qdrant/js-client-rest** | `1.17.0` | Qdrant REST client (matches our Qdrant 1.x server) | Official Qdrant package. Uses `undici ^6.23.0` — Bun has its own fetch impl, expect zero issues. **Don't use `@qdrant/js-client-grpc`** unless we hit REST throughput limits — gRPC pulls protobuf and is overkill for the EE workload. |

**Confidence: HIGH.**

### IPC: TUI ↔ Experience Engine

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **Native fetch** | (built-in) | TUI → EE HTTP calls | EE already exposes `localhost:8082`. Bun's native `fetch` matches Node 18+ — no client library. |
| **eventsource** (or built-in) | `4.1.0` | SSE for streaming hook responses if EE pushes them | Only needed if EE adds push channels. **Default to plain HTTP with JSON request/response** — simpler, debuggable, matches the existing `experience-core.js` interceptor model. |
| **ws** | `8.20.0` | WebSocket fallback | Only if hooks become bidirectional. **Defer to Phase 2.** |

**Confidence: HIGH.** We do not need a gRPC layer between TUI and EE — JSON over loopback is <1ms for hook payloads.

### Local Heuristic Classifier (Hot Path)

| Approach | Use case | Notes |
|----------|----------|-------|
| **Plain regex** (TS, no library) | 80% of routing decisions | "starts with `npm test`", "contains `git rebase`", "ends with `.tsx`" — submillisecond, zero dep. |
| **web-tree-sitter** | When regex misses (e.g., "is this a refactor or a fix?") | Parse user prompt + diff; check AST shape. Use WASM build for cross-runtime safety. |
| **fast-levenshtein** (`3.0.0`) | Fuzzy match against known principle keys before hitting Qdrant | Cheap pre-filter saves a vector search. |

**Anti-recommendation:** Do not pull in `compromise`, `natural`, or any general NLP library for the classifier. Hot-path means <1ms; NLP libs are 50–200ms. Stay regex-first.

### Build / Packaging / Distribution

| Tool | Version | Purpose | Why |
|------|---------|---------|-----|
| **`bun build --compile`** | (Bun 1.3.13) | Cross-platform standalone binaries (`--target=bun-linux-x64`, `bun-darwin-arm64`, `bun-windows-x64`) | **Built-in. Use this.** Native, fast, single-file. grok-cli already wires `build:binary`. |
| ~~`pkg`~~ | abandoned (Vercel) | — | **Do NOT use.** Officially deprecated 2023, no Bun support. |
| ~~`nexe`~~ | dormant | — | **Do NOT use.** Last meaningful release 2024, Node-only, not Bun. |
| **Biome** | `2.4.13` | Lint + format (replaces ESLint + Prettier) | grok-cli already uses Biome 2.4.8. Fast, single config, Bun-friendly. |
| **Vitest** | `4.1.5` (or `4.1.0` from grok-cli) | Test runner | grok-cli inherits Vitest 4.1.0. **Bun has its own `bun test` — use it for unit tests of pure logic, keep Vitest for anything that needs jsdom or React Testing Library equivalents.** Hybrid is fine. |
| **husky** + **lint-staged** | `9.1.7` / `16.4.0` | Pre-commit hooks | Already configured. Keep. |

**Confidence: HIGH.** Bun's `--compile` is documented in OpenTUI's own build instructions (`Build production applications with Bun`, Context7-verified).

### Phase 4 (Billing + Auth) — Defer Until Beta Validates Demand

| Technology | Version | Purpose | Notes |
|------------|---------|---------|-------|
| **stripe** | `22.1.0` (released 2026-04-24, Node SDK) | Subscriptions, metered billing | Mature, no real alternative for SaaS. v22 is the current LTS-grade major. Server-side only — never embed in CLI. |
| **@clerk/backend** | `3.4.1` (released ~recent) | Auth (JWT verification + REST) | **Recommended over Auth0** for solo maintainer SaaS:<br>• Clerk free tier: 10k MAUs (vs Auth0's 7.5k)<br>• Clerk dev experience for Next.js dashboard is best-in-class<br>• Better support for "magic link + GitHub OAuth" combo expected for a developer audience<br>**Caveat:** Clerk pricing climbs once you exceed free tier; budget ~$25/mo at first paid traffic. |
| ~~**auth0**~~ | `5.8.0` | — | Considered, rejected. Auth0's SDK is fine but pricing per MAU is steeper at the relevant tier, and Clerk's component library accelerates the dashboard build. *Concern level: low — we can swap if Clerk costs blow up.* |

**Confidence: MEDIUM** — the Clerk-vs-Auth0 call is opinionated and pricing tiers shift; revisit at Phase 4 kickoff with current pricing pages.

---

## What NOT to Use (And Why)

| Package | Status | Replacement |
|---------|--------|-------------|
| `@ai-sdk/xai` (`3.0.84`) | Inherited from grok-cli, single-vendor | Drop — we route across providers, not Grok-only |
| `@coinbase/agentkit` (`0.10.4`) | In IDEA.md delete list | Stripe in Phase 4 |
| `grammy` (`1.41.1`) | Telegram bot — out of scope | Delete |
| `agent-desktop` (`0.1.11`) | Headless browser sidekick — not needed for CLI | Delete |
| `@npmcli/arborist` (`9.4.2`) | Used for npm install management in grok-cli | **Audit — keep only if we automate `package.json` mutation. Otherwise delete.** |
| `ollama-ai-provider` (legacy `1.2.0`) | Last publish 2025-01-17, unmaintained | `ollama-ai-provider-v2` |
| `pkg`, `nexe` | Dead/abandoned packagers | `bun build --compile` |
| AI SDK v7 beta | Unstable, breaking changes still landing | Stay on v6 stable until 2026 H2 |
| OpenTUI `0.2.0` | <24h old at this writing, breaking React reconciler bump | Pin `0.1.107` until Phase 3 |
| `vscode-languageclient` | VS Code extension API, wrong layer | Talk to LSPs directly via `vscode-jsonrpc` over stdio |
| `@ai-sdk/google-vertex` | Requires GCP project setup, BYOK-hostile | `@ai-sdk/google` (consumer Gemini) |
| Native `tree-sitter` (`0.25.0`) | Bun FFI/Node addon ABI hazard | `web-tree-sitter` WASM |
| `dotenv` (`16.6.1`) | Bun has built-in `.env` loading | Drop in Bun-only paths; keep only if EE side needs it |

---

## Bun-Specific Gotchas (Surface Now, Not in Phase 2)

1. **OpenTUI is Bun-only.** Node and Deno support is "in development" per their getting-started docs. Our TUI process must run under Bun. Mitigation: keep EE backend on Node 20, talk over HTTP. **No shared TUI/EE process.**
2. **Native Node addons are a landmine.** Bun emulates N-API but mismatches happen. Avoid `tree-sitter` native, `node-pty` (used by quick-codex — keep on Node side), `better-sqlite3`, `bcrypt`. Use WASM/pure-JS variants on the Bun side.
3. **`--compile` produces large binaries** (typically 50–90MB) because Bun bundles the runtime. Acceptable for a developer CLI; surface this in download docs.
4. **Cross-platform binaries are produced by cross-compiling from one host.** `bun build --compile --target=bun-linux-x64` works from Windows. Test all three targets in CI from Phase 0.
5. **Bun's `fetch` is mostly Node-compatible but not 100%.** Streaming response bodies through `ReadableStream` is fine; `keep-alive` agent tuning differs. We use undici only via the Qdrant client transitively — should be fine.
6. **Quick Codex uses `node-pty` (`^1.1.0`) and `ink` (`^5.2.1`).** Those are Node-side. **Do NOT try to merge QC's TUI with ours.** Integrate QC at the workflow contract layer (file-based artifacts in `.muonroi-flow/`), not at runtime.
7. **`react-reconciler` version pinning is fragile.** OpenTUI 0.2.0 bumped to 0.32; Ink stayed on 0.33. If we ever consider pulling Ink components into an OpenTUI app, the reconciler version mismatch will explode. Don't.

---

## Cross-Platform Notes

| Concern | Windows (primary dev) | Linux (VPS) | macOS |
|---------|----------------------|-------------|-------|
| Bun install | `powershell -c "irm bun.sh/install.ps1 \| iex"` | `curl -fsSL https://bun.sh/install \| bash` | `brew install oven-sh/bun/bun` |
| OpenTUI native Zig core | Prebuilt binaries shipped via `bun-ffi-structs` | Prebuilt | Prebuilt |
| Path handling | Use `node:path` with `path.posix` for relative artifact paths to avoid `\` leaking into `.muonroi-flow/` files | Native | Native |
| Terminal escape sequences | Windows Terminal + WSL fine; old `cmd.exe` may need `OPENTUI_FORCE_EXPLICIT_WIDTH=false` (Context7-documented) | Native | Native |
| LSP child processes | `child_process.spawn` works in Bun on Windows; no `node-pty` needed for LSP | Native | Native |

**Confidence: MEDIUM** — Windows is the primary dev target per IDEA.md, but OpenTUI is Bun-first and Bun on Windows has historically been newer than Bun on Linux/macOS. Validate in Phase 0 day 1 (run grok-cli unmodified on the dev box, confirm OpenTUI renders).

---

## Provider-Specific Validation Checklist (Phase 1 acceptance gate)

For each provider, confirm via integration test:
- [ ] `streamText` produces token-by-token output
- [ ] Tool calls (≥3 tools, parallel) round-trip correctly
- [ ] Token usage reported in `result.usage.inputTokens` / `outputTokens`
- [ ] Cost calculable from usage × known per-token rate
- [ ] Aborting via `AbortController` cleanly tears down the stream

| Provider | Adapter | Streaming | Tool-use | Usage reporting | Notes |
|----------|---------|-----------|----------|-----------------|-------|
| Anthropic | `@ai-sdk/anthropic@3.0.72` | YES | YES | YES | First-class, Context7 example shown |
| OpenAI | `@ai-sdk/openai@3.0.54` | YES | YES | YES | Includes `responses()` API |
| Gemini | `@ai-sdk/google@3.0.65` | YES | YES | YES | Tool-use parity verified in v6 |
| DeepSeek | `@ai-sdk/openai-compatible@2.0.42` against `https://api.deepseek.com/v1` | YES | YES | YES | DeepSeek emulates OpenAI API; pass `apiKey` + `baseURL` |
| SiliconFlow | `@ai-sdk/openai-compatible@2.0.42` against SiliconFlow base URL | YES | YES (model-dependent) | YES | Cold-tier; same adapter as DeepSeek |
| Ollama (warm) | `ollama-ai-provider-v2@1.50.1` against `http://72.61.127.154:11434` | YES | Limited (model-dependent — qwen2.5-coder supports it) | Partial (no cost, just tokens) | Free tier, no $ tracking needed |

**Confidence: HIGH** for the first 3, **MEDIUM** for DeepSeek/SiliconFlow tool-use (depends on chosen model — Qwen 2.5 72b on SiliconFlow does, V3 mostly does), **MEDIUM** for Ollama tool-use (model-dependent, qwen2.5-coder 7b+ does support it but reliability < paid models).

---

## Installation Plan (Phase 0)

```bash
# After fork, in muonroi-cli root, prune grok-cli's deps:
bun remove @ai-sdk/xai @coinbase/agentkit grammy agent-desktop @ai-sdk/mcp

# Pin OpenTUI to last 0.1.x stable
bun add @opentui/core@0.1.107 @opentui/react@0.1.107

# AI SDK + provider adapters
bun add ai@6.0.169 \
  @ai-sdk/anthropic@3.0.72 \
  @ai-sdk/openai@3.0.54 \
  @ai-sdk/google@3.0.65 \
  @ai-sdk/openai-compatible@2.0.42 \
  ollama-ai-provider-v2@1.50.1 \
  @ai-sdk/mcp@1.0.37

# MCP + LSP + code intel (most already present from grok-cli)
bun add @modelcontextprotocol/sdk@1.29.0 \
  vscode-jsonrpc@8.2.1 \
  vscode-languageserver-types@3.17.5 \
  web-tree-sitter@0.26.8

# Vector + integrations
bun add @qdrant/js-client-rest@1.17.0

# Phase 4 only (do not install in Phase 0):
# bun add stripe@22.1.0 @clerk/backend@3.4.1
```

---

## Sources

- npm registry, live queries 2026-04-29 (versions, peer deps, publish timestamps)
- Context7 `/vercel/ai` (AI SDK v6 tool-calling, `streamText`, `stopWhen`)
- Context7 `/anomalyco/opentui` (OpenTUI runtime support, Bun-only constraint, `bun build --compile` usage, terminal compat env vars)
- GitHub Releases API: `oven-sh/bun` (Bun 1.3.13 release date), `anomalyco/opentui` (0.2.0 release date)
- npm publish timestamps for `ollama-ai-provider` (last publish 2025-01-17, abandoned) vs `ollama-ai-provider-v2` (active, 2026-03-17)
- Inherited package.json: `D:/sources/Core/grok-cli/package.json`
- IDEA.md scope decisions: `D:/sources/Core/muonroi-cli/IDEA.md`

---

## Confidence Summary

| Recommendation | Confidence | Reason |
|----------------|------------|--------|
| Keep Bun + OpenTUI + React 19 + AI SDK v6 | HIGH | All current, all Context7-verified, all match the inherited stack |
| Pin OpenTUI to 0.1.107, not 0.2.0 | HIGH | 0.2.0 is 17 hours old at writing — defensible engineering call |
| Stay on AI SDK v6 (not v7-beta) | HIGH | v7 in beta, v6 has all features we need |
| Use `@ai-sdk/openai-compatible` for DeepSeek + SiliconFlow | HIGH | Single adapter, easy to add OpenRouter/Groq later |
| Use `ollama-ai-provider-v2` not legacy | HIGH | Verified abandonment date of legacy |
| `web-tree-sitter` over native `tree-sitter` | MEDIUM | Bun FFI gotchas are real but should be empirically validated |
| Clerk over Auth0 for Phase 4 | MEDIUM | Pricing tiers shift; revisit at Phase 4 kickoff |
| `bun build --compile` for distribution | HIGH | Built-in, OpenTUI docs use it |
| Drop `@ai-sdk/xai`, Coinbase, Telegram, agent-desktop | HIGH | Already in IDEA.md delete list |
