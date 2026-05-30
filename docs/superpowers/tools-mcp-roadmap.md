# muonroi tools-mcp — Roadmap (client ↔ native gap closure)

**Purpose:** Track the remaining capabilities needed to bring a *client* Claude
session (e.g. Claude Code driving this repo, subscription-auth, ToS-clean) as
close as possible to the *native* muonroi-cli agent — by exposing native
capabilities over the `muonroi tools-mcp` stdio MCP server.

**Why a roadmap, not one plan:** each remaining gap is an *independent
subsystem* with its own dependencies, design questions, and security surface.
Bundling them into a single implementation plan would couple unrelated work and
create tech debt. Each piece below gets its own `spec → plan → impl` cycle (the
piece 1–3 pattern). This file is the umbrella tracker.

---

## Done (on `master` as of 2026-05-30, merge `0b01acc`)

`muonroi tools-mcp` server — 9 tools:

| Piece | Tools | Spec / Plan |
|---|---|---|
| 1 | `selfverify.{start,status,result,list,cancel}` | `specs/2026-05-30-muonroi-tools-mcp-self-verify-design.md` · `plans/2026-05-30-tools-mcp-self-verify.md` |
| 2 | `ee.query`, `ee.health`, `usage.forensics` | `specs/2026-05-30-tools-mcp-ee-forensics-design.md` · `plans/2026-05-30-tools-mcp-ee-forensics.md` |
| 3 | `lsp.query` | `specs/2026-05-30-tools-mcp-lsp-design.md` · `plans/2026-05-30-tools-mcp-lsp.md` |

Client ↔ native parity for *developing the CLI*: **~9/10**.

---

## Remaining pieces (each = its own spec → plan → impl)

### Piece 4 — computer-use over MCP  ⟶ biggest capability gap
- **What:** wrap the native `computer_*` toolset (14 ops: snapshot, screenshot,
  click, mouse_move, type, press, scroll, launch, list_windows, focus_window,
  wait, get) so a client can drive native desktop/GUI apps.
- **Blocker / dependency:** native impl shells out to the `agent-desktop` npm
  package, which is **NOT installed** (`node_modules/agent-desktop` absent) and
  is accessibility-tree centric (likely macOS-first). Needs a feasibility spike
  on **Windows** before any design.
- **Relevance to dev:** LOW for *developing the CLI*; HIGH for *end-user agent*
  scenarios. Defer unless an end-user-agent use case drives it.
- **Design questions for its spec:** which subset of the 14 ops; security
  boundary for desktop control over MCP; gating/allowlist; per-op timeouts;
  async (job model like self-verify) vs sync given screenshot latency.
- **Effort:** L (depends on agent-desktop availability + cross-platform).

### Piece 5 — media generation (`generate_image`, `generate_video`)
- **What:** wrap native media-gen tools so a client can produce images/video.
- **Dependency:** provider wiring + output-path handling; cost (paid model
  calls) — must respect the same cost discipline as the rest of the CLI.
- **Relevance to dev:** LOW. Niche for CLI development.
- **Effort:** M.

### Piece 6 — x402 wallet (`paid_request`, `fetch_payment_info`, `wallet_*`)
- **What:** autonomous micropayment access to paywalled resources via the local
  crypto wallet + `brin` security scan.
- **Security surface:** HIGH — spends real funds; native flow prompts the user
  to approve each payment. Exposing over MCP needs an explicit approval gate
  and a hard spend cap; do NOT expose `paid_request` without human-in-loop.
- **Relevance to dev:** LOW. Niche.
- **Effort:** M–L (payment approval UX over MCP is the hard part).

### Piece 7 — `search_x` (X/Twitter real-time search)
- **What:** wrap native `search_x`.
- **Relevance to dev:** LOW. Tiny single-tool wrap if a native impl exists.
- **Effort:** S.

### Housekeeping — register `mcp-driver` (`tui.*`) in `.mcp.json`
- The harness `tui.*` tools (16) are reachable today via the environment but the
  repo `.mcp.json` only declares `muonroi-tools`. Add a `muonroi-harness` entry
  (`bun run src/index.ts mcp-driver`) so harness-drive is explicit alongside the
  tools server. **Effort: XS.**

---

## NOT buildable (architectural boundary / N/A — do not plan)

- **Orchestrator loop** — council / sprint / `/ideal` / loop-driver, cost caps,
  compaction, prompt-cache-key, sub-agent budgets, EE injection. These ARE
  muonroi's own agent loop; they only run when the *model* is inside that loop.
  A client cannot host them — it uses Claude Code's own loop as the analog. This
  is the irreducible final ~1/10 and is **out of scope by design**.
- **Vision proxy** (`analyze_image`, `ask_vision_proxy`, `list_vision_cache`) —
  exists only to give *text-only* models eyes. A client Claude session is
  already a vision model → **N/A**, not a gap.

---

## Suggested order (by dev-value × ToS-clean × low-dependency)

1. **Housekeeping** (`tui.*` in `.mcp.json`) — XS, immediate.
2. **Piece 4 (computer-use)** — only after a Windows `agent-desktop` feasibility
   spike confirms it works; biggest gap but lowest dev-relevance.
3. **Pieces 5–7 (media-gen, wallet, search_x)** — niche; build on demand when a
   concrete use case appears. Wallet requires a payment-approval gate first.

For *developing muonroi-cli*, pieces 1–3 already close the gap to ~9/10; the
remaining pieces mainly serve end-user-agent scenarios.
