# Phase 0: Fork & Skeleton - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

A forked, amputated `muonroi-cli` boots on the dev box, renders the OpenTUI shell, runs an Anthropic-only stub conversation against renamed storage paths, talks to EE via HTTP (not shell-spawn), and refuses to leak the user's API key.

**In scope:** FORK-01..08, TUI-01..04, USAGE-01, USAGE-06, EE-01, PROV-03, PROV-07.
**Out of scope (Phase 1+):** TUI-05 status bar, USAGE-02..05/07 enforcement, USAGE-08 `/cost` slash, PROV-01/02/04/05/06 multi-provider, EE-02..10 hooks/judge/scope/principles, ROUTE-*, FLOW-*, CORE-*, OPS-*.

</domain>

<decisions>
## Implementation Decisions

### Fork & Strip Strategy
- **Fork source point:** grok-cli `main` HEAD at fork time. Capture commit hash in `UPSTREAM_DEPS.md` (FORK-05). No upstream tracking after fork (per Out-of-Scope in PROJECT.md).
- **Strip granularity:** Multi-commit per requirement — one commit each for FORK-01 (fork + IDEA reference), FORK-02 (delete telegram/audio/wallet/payments/grok/vision-input + their tests), FORK-04 (deps swap + pin), FORK-07 (folder layout move). Bisectable on regression.
- **Storage rename (FORK-03):** Single codebase-wide commit replacing `~/.grok/` → `~/.muonroi-cli/` across sessions, transcripts, configs, credentials. No migration helper — clean break per `Out of Scope > Migrating existing ~/.grok/ sessions`.
- **LICENSE files:** Keep `LICENSE-grok-cli` immutable at repo root + add new `LICENSE` (MIT, attribution to Vibe Kit retained inside). Per D-001 + Pitfall 15.

### TUI Boot & Anthropic Stub
- **Boot validation (SC1, FORK-08):** Manual smoke — `bun install && bun run dev` opens OpenTUI, renders inherited grok-cli component tree (input box, output stream, slash command palette), Ctrl+C unmounts cleanly with no orphan stdout. No automated TUI render test in Phase 0 (overkill for solo maintainer; manual smoke gates Phase 1).
- **Anthropic stub conversation (SC2, TUI-02, PROV-03):** Real API call. Read key from OS keychain via keytar (per PROV-03 decision below), fall back to env with redactor warning. Stream a "say hi" prompt round-trip to prove streaming + key-load + log-redaction together.
- **Streaming pattern:** Preserve grok-cli's async-generator-of-StreamChunk pattern as-is. Wrap inside new `src/providers/anthropic.ts` shell. Adapter interface (PROV-01) deferred to Phase 1 — Phase 0 ships only the Anthropic implementation under the future-friendly path.
- **`--session latest` resume (SC3, TUI-03):** Manual smoke (start session → kill → restart with `--session latest`, verify last messages restored from `~/.muonroi-cli/sessions/`). Automated test deferred to Phase 1 once first artifact files exist; full continuity test belongs in Phase 2 with `.muonroi-flow/`.

### Key Safety & EE Skeleton
- **API key source (PROV-03):** Keytar OS keychain primary. Env var fallback (`ANTHROPIC_API_KEY`) accepted with one-line warning at startup. The redactor enrolls the env-loaded value before any log line emits, so Pitfall 2 is mitigated by redactor not by refusing env.
- **Log redactor (PROV-07):** Full middleware day 1. Scrubs by regex (`sk-[A-Za-z0-9_-]{20,}`, `ANTHROPIC_API_KEY=...`, JWT shape `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, `Authorization:` header) AND by enrolled live values (the actual key string read from keychain/env). Applies to every `console.*`, every error stack, the bug-report bundle. Pitfall 2 is HIGH severity — no half-skeleton.
- **EE HTTP client surface (EE-01, SC5):** Ship `src/ee/client.ts` with three methods — `health()` GET, `intercept(toolCall)` blocking POST to `/api/intercept`, `posttool(toolCall, outcome)` fire-and-forget POST to `/api/posttool`. Replace grok-cli's `src/hooks/executor.ts` shell-spawn calls with HTTP calls. When EE returns 5xx or unreachable, intercept short-circuits to `decision: 'allow'` + logs (so dev box without EE still works); `posttool` swallows errors silently.
- **Usage guard skeleton (USAGE-01, USAGE-06):** Write `~/.muonroi-cli/config.json` schema with `cap.monthly_usd` (default 15); read on boot. Create `~/.muonroi-cli/usage.json` skeleton with `{ current_month_utc: "YYYY-MM", current_usd: 0, reservations: [] }`; read/write via atomic-rename pattern (`.tmp` then rename). No enforcement in Phase 0 — that's Phase 1 USAGE-02..05/07. File-owner role for cap state locks here per cross-phase note in ROADMAP Phase 0.

### Testing, Tooling & CI
- **Test runner:** Bun test (built into Bun runtime, zero config). Jest-style API; matches stack pin `bun >= 1.3.13`.
- **CI in Phase 0 (FORK-08):** GitHub Actions Windows-only smoke job — `bun install`, `bun test`, then a headless boot smoke that runs `bun run dev` with stdin piped, asserts OpenTUI renders within 3s, then sends Ctrl+C and asserts clean exit. Block Phase 1 if fails. Plus a weekly `bun outdated` job per FORK-05. Full matrix (Win/Mac/Linux) lands in Phase 3 CORE-05.
- **Commit style:** Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Enables automated changelog later; signals intent without ceremony.
- **TypeScript config:** Inherit grok-cli's `tsconfig.json` baseline. Adjust only `compilerOptions.paths` to map our `src/{ui, orchestrator, providers, router, usage, ee, flow, gsd, lsp, mcp, headless, tools, storage, utils}` layout (FORK-07). Strict mode + ESM-only refactor deferred — Phase 0 minimizes churn.

### Claude's Discretion
- Specific commit messages, file paths, and small refactors during execution.
- Choice of which inherited grok-cli files map to which new folder during FORK-07 (use the layout note in PROJECT.md as guide).
- Test naming and granularity within the Bun test framework.
- GitHub Actions YAML structure and matrix details for the Windows smoke job.

</decisions>

<code_context>
## Existing Code Insights

### Source — Upstream `grok-cli`
The fork base is the `grok-cli` repo (Vibe Kit, MIT). Key inherited surfaces (per IDEA.md + research/SUMMARY.md):
- `src/agent/` — TUI input loop, streaming output renderer, slash command palette (preserve & rehome to `src/ui/`).
- `src/ai/` — AI SDK v6 wiring, async-generator-of-StreamChunk pattern (preserve, rehome to `src/providers/`).
- `src/sessions/` — local session persistence under `~/.grok/sessions/` (preserve, rename storage path to `~/.muonroi-cli/sessions/`).
- `src/hooks/executor.ts` — shell-spawn hook executor (REPLACE with HTTP client to localhost:8082).
- `src/mcp/`, `src/lsp/`, `src/headless/`, `src/daemon/`, `src/tools/` — preserve verbatim, rehome.
- `src/telegram/`, `src/audio/`, `src/wallet/`, `src/payments/`, `src/grok/`, `src/agent/vision-input.*` — DELETE in FORK-02.
- `package.json` — strip deprecated deps (`@ai-sdk/xai`, `@coinbase/agentkit`, `grammy`, `agent-desktop`); pin per `research/SUMMARY.md` Locked Stack.

### Reusable Assets
- OpenTUI component tree from grok-cli — input box, output stream, slash palette, status frame.
- Streaming async-generator pattern — keep verbatim in Phase 0, abstract in Phase 1.
- AI SDK v6 (`ai@6.0.169`) — Anthropic provider via `@ai-sdk/anthropic`.
- `keytar` — already in grok-cli's tree (used by `~/.grok/` credentials store), retarget at `~/.muonroi-cli/` keys.

### Established Patterns (from grok-cli)
- Bun runtime + ESM modules.
- React 19 + OpenTUI for terminal rendering.
- Async generators for stream chunks.
- File-backed session storage with JSON-per-session.

### Integration Points (Phase 0 deliveries)
- `src/providers/anthropic.ts` — first Anthropic adapter shell (PROV-03/07).
- `src/ee/client.ts` — replaces `src/hooks/executor.ts` shell-spawn (EE-01).
- `src/storage/usage.ts` + `src/storage/config.ts` — owners of `~/.muonroi-cli/usage.json` + `config.json` (USAGE-01/06).
- `src/utils/redactor.ts` — global log scrubber (PROV-07).
- `~/.muonroi-cli/` directory structure — owned here, consumed by all later phases.
- `LICENSE`, `LICENSE-grok-cli`, `DECISIONS.md`, `UPSTREAM_DEPS.md` — repo-root files (FORK-01/05/06).
- `.github/workflows/windows-smoke.yml`, `.github/workflows/deps-check.yml` — CI jobs (FORK-08, FORK-05).

</code_context>

<specifics>
## Specific Ideas

- Anthropic stub uses `say hi` as the test prompt — short, deterministic, cheap to repeat.
- The Phase 0 "skeleton" for USAGE means: write the schema + read on boot + atomic file ops, but no enforcement, no thresholds, no auto-downgrade — those land in Phase 1. The ownership boundary (TUI process, never EE) is locked here.
- The redactor must enroll runtime-loaded key values, not just regex-match — a user's key may not match the public regex shape if a provider rotates formats.
- EE client gracefully degrades when `localhost:8082` is unreachable so Phase 0 dev is not blocked by EE uptime.

</specifics>

<deferred>
## Deferred Ideas

- TUI-05 status bar (model/tier/tokens/USD) — Phase 1.
- Multi-provider adapter interface and 4 other providers — Phase 1 PROV-01/02/04/05/06.
- Full PreToolUse/PostToolUse hook payloads with principle parsing + scope filter — Phase 1 EE-02..10.
- Cap enforcement, threshold events, auto-downgrade chain, runaway-scenario tests — Phase 1 USAGE-02..05/07.
- `/cost` slash command — Phase 2 USAGE-08.
- `.muonroi-flow/` artifacts and slash commands — Phase 2.
- CI matrix (Win/Mac/Linux), permission modes, `doctor`, `bug-report`, headless JSON mode, MCP/LSP smoke — Phase 3.
- Cloud EE, Stripe billing, web dashboard — Phase 4.
- Automated TUI render tests via `node-pty` — Phase 1 once we have the harness need.

</deferred>
