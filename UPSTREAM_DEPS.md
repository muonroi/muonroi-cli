# UPSTREAM_DEPS.md

> Locks the dependencies we accepted ownership of when forking from grok-cli.
> Per Pitfall 1 (research/PITFALLS.md) and FORK-05 — "no upstream tracking" applies
> to the grok-cli codebase, NOT to dependency releases. We must watch every
> upstream listed below for CVE / breaking-change announcements.

## Fork Base

| Field | Value |
|---|---|
| Upstream repo | https://github.com/muonroi/grok-cli.git (personal fork of superagent-ai/grok-cli) |
| Fork commit hash | `09b64bc518f110424cb58bdbb3cf2ce2b388dbe5` |
| Fork commit date | 2026-04-29 (per `git log -1 --format=%cI`) |
| Fork commit subject | docs: add troubleshooting section with common issues and solutions (#277) |
| Forked at | 2026-04-29 |

grok-cli upstream tracking is OUT OF SCOPE per IDEA.md "Out of scope" line and
PROJECT.md "Tracking grok-cli upstream — Upstream priorities conflict with ours."
We OWN the diff from `09b64bc` forward.

## Runtime Dependencies (watched for CVE + breaking changes)

| Package | Pinned | Source | Release feed | Notes |
|---|---|---|---|---|
| bun (runtime) | `>=1.3.13` | https://github.com/oven-sh/bun/releases | GitHub releases | D-003. Pitfall 16: validate every minor bump on Windows 11 before adopting. |
| ai | `6.0.169` | https://github.com/vercel/ai/releases | GitHub releases | Locked in research/STACK.md. v7-beta excluded until 2026 H2. |
| @ai-sdk/anthropic | `3.0.72` | https://www.npmjs.com/package/@ai-sdk/anthropic | npm | First provider implemented in Phase 0 (TUI-02, PROV-03). |
| @ai-sdk/openai | `3.0.54` | https://www.npmjs.com/package/@ai-sdk/openai | npm | Phase 1 PROV-01. Tracked here so deps swap commit doesn't drift. |
| @ai-sdk/google | `3.0.65` | https://www.npmjs.com/package/@ai-sdk/google | npm | Phase 1 PROV-01. |
| @ai-sdk/openai-compatible | `2.0.42` | https://www.npmjs.com/package/@ai-sdk/openai-compatible | npm | DeepSeek + SiliconFlow share this adapter (D-006). |
| @ai-sdk/mcp | `1.0.37` | https://www.npmjs.com/package/@ai-sdk/mcp | npm | grok-cli's existing MCP integration. |
| ollama-ai-provider-v2 | `1.50.1` | https://www.npmjs.com/package/ollama-ai-provider-v2 | npm | Legacy `ollama-ai-provider` is abandoned 2025-01-17 — DO NOT add it. |
| @opentui/core | `0.1.107` | https://www.npmjs.com/package/@opentui/core | npm | NOT 0.2.0 — breaking react-reconciler bump. Re-evaluate Phase 3. |
| @opentui/react | `0.1.107` | https://www.npmjs.com/package/@opentui/react | npm | Match @opentui/core version exactly. |
| react | `19.2.5` | https://www.npmjs.com/package/react | npm | OpenTUI peer. |
| @modelcontextprotocol/sdk | `1.29.0` | https://github.com/modelcontextprotocol/typescript-sdk/releases | GitHub | Inherited from grok-cli. |
| vscode-jsonrpc | `8.2.1` | https://www.npmjs.com/package/vscode-jsonrpc | npm | LSP integration (CORE-03). |
| vscode-languageserver-types | `3.17.5` | https://www.npmjs.com/package/vscode-languageserver-types | npm | LSP types. |
| web-tree-sitter | `0.26.8` | https://www.npmjs.com/package/web-tree-sitter | npm | WASM (NOT native) — Bun FFI gotchas with native node addons. |
| @qdrant/js-client-rest | `1.17.0` | https://www.npmjs.com/package/@qdrant/js-client-rest | npm | EE talks to Qdrant. We do not (per architecture). Listed for completeness. |
| keytar | `^7.9.0` (NEW) | https://www.npmjs.com/package/keytar | npm | OS keychain (PROV-03 / Pitfall 2). NEW dependency added in plan 00-04 — NOT inherited from grok-cli (verified absent from grok-cli package.json and src/). Plan 00-05 uses dynamic import() with env-var fallback. |
| commander | inherited | https://www.npmjs.com/package/commander | npm | CLI parsing inherited from grok-cli. |
| zod | inherited | https://www.npmjs.com/package/zod | npm | Validation inherited. |

## Removed in Phase 0 (FORK-04)

These are stripped in plan 00-04. Listed here so future audits know they were
intentionally dropped:

| Package | Reason for removal |
|---|---|
| @ai-sdk/xai | Single-vendor xAI tie-in; replaced by multi-provider adapter. |
| @coinbase/agentkit | Crypto wallet feature out of scope (PROJECT.md Out of Scope). |
| grammy | Telegram bot deleted (FORK-02). |
| agent-desktop | macOS-only computer-use sub-agent — conflicts with cross-platform constraint. |
| @npmcli/arborist | Audit on next dependency review; not currently consumed by retained surface. |
| dotenv | Bun has built-in .env support; redundant. |

## Watch Cadence

- **Weekly automated:** `bun outdated` runs in `.github/workflows/deps-check.yml`
  (added in plan 00-08). Output is a CI artifact; failures DO NOT block merges
  but DO file an issue.
- **Manual review:** Solo maintainer reviews this file at every phase boundary
  (`/gsd-transition`).
- **CVE fast-track:** Subscribe to `ai`, `@opentui/core`, `bun`, and
  `@modelcontextprotocol/sdk` releases. CVE patches land within 7 days.

## Phase 4 Holdback

These are deferred per research/SUMMARY.md "Phase 4 deps (do NOT install in Phase 0)":

- stripe (~22.x) — added at Phase 4 kickoff after auth/billing re-research.
- @clerk/backend (~3.x) — same.
