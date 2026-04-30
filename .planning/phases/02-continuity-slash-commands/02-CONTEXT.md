# Phase 2: Continuity & Slash Commands - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

`.muonroi-flow/` artifacts coordinate state across sessions and slash commands; deliberate two-pass compaction never drops decisions; `/discuss /plan /execute /compact /clear /expand /cost /route` all work; killing the TUI mid-task and restarting clean restores work from disk alone.

**In scope:** FLOW-01..12, USAGE-08.
**Out of scope:** CORE/OPS (Phase 3), CLOUD/BILL/WEB (Phase 4).

**Cross-phase obligations (from ROADMAP):**
- `.muonroi-flow/` directory structure and section format locked in DECISIONS.md before Phase 4 — cloud sync depends on stable on-disk format.
- Hook-derived warnings persist into active run artifacts so compaction never erases relevant EE constraints.

</domain>

<decisions>
## Implementation Decisions

### Plan Slicing (5 plans by workflow area)
- **01-PLAN: .muonroi-flow/ scaffolding + tolerant parser + migration** — Directory structure, section-by-heading tolerant reader/writer, atomic-rename writes, `.quick-codex-flow/` one-shot migration (FLOW-01, FLOW-02, FLOW-03).
- **02-PLAN: /discuss + /plan + /execute slash commands** — Gray-area gates, plan evidence-based scope, QC-lock execution loop, all reading/writing `.muonroi-flow/runs/<id>/` (FLOW-05, FLOW-06, FLOW-07).
- **03-PLAN: Two-pass compaction + /compact + /expand + /clear** — Extract decisions/facts/constraints first, then compress chat; preserve-verbatim markers survive; `/expand` reverses; `/clear` relocks from artifacts (FLOW-08, FLOW-09, FLOW-10, FLOW-11).
- **04-PLAN: Kill-restart continuity + session resume** — `.muonroi-flow/` state read before chat transcript on cold start; kill-and-restart integration test; hook-warning persistence in run artifacts (FLOW-04, FLOW-12).
- **05-PLAN: /cost slash command** — Prints status-bar contents on demand (USAGE-08).

### Compaction Strategy (FLOW-08, FLOW-11)
- **Preserve-verbatim markers:** Inline HTML comments `<!-- preserve -->...<!-- /preserve -->` in chat messages. Compactor extracts decisions/facts/constraints to `.muonroi-flow/decisions.md` first (pass 1), then compresses everything EXCEPT marked sections (pass 2). No UI change needed.
- **Two-pass order:** Pass 1 = decision extraction (structured write to decisions.md). Pass 2 = token-budget compression of remaining chat. This ensures decisions survive even if the chat is fully compressed.
- **History for /expand:** Before compacting, snapshot full chat to `.muonroi-flow/history/<timestamp>.md`. `/expand` restores from latest snapshot.

### .muonroi-flow/ Directory Structure (FLOW-01)
Locked per ROADMAP cross-phase note:
```
.muonroi-flow/
├── roadmap.md
├── state.md
├── backlog.md
├── decisions.md
├── history/          # compaction snapshots for /expand
└── runs/
    └── <run-id>/
        ├── roadmap.md
        ├── state.md
        ├── delegations.md
        └── gray-areas.md
```
Section format: heading-delimited, tolerant reader (missing sections OK), deterministic writer (atomic-rename via `.tmp`).

### Migration (.quick-codex-flow/ → .muonroi-flow/, FLOW-03)
- Detect `.quick-codex-flow/` at boot.
- Prompt user: "Found .quick-codex-flow/ — migrate to .muonroi-flow/? [Y/n]"
- On yes: copy files with section heading renames where needed (formats are similar). One-shot, no rollback.
- On no: warn and continue without migration.

### Slash Command Framework
- Reuse `src/ui/slash/registry.ts` from Phase 1 (registerSlash/dispatchSlash).
- New commands: `/discuss`, `/plan`, `/execute`, `/compact`, `/clear`, `/expand`, `/cost`.
- `/route` already landed in Phase 1.

### Claude's Discretion
- Run ID generation strategy (UUID vs timestamp-based).
- Exact section heading names within `.muonroi-flow/` files (as long as the parser is heading-delimited and tolerant).
- Gray-area gate UX (how unresolved gray areas block `/plan` — inline warning vs modal prompt).
- Token budget for compaction pass 2 (percentage of context window, or fixed token count).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets (from Phase 0 + Phase 1)
- `src/storage/atomic-io.ts` — atomic-rename write utility, reuse for all `.muonroi-flow/` writes.
- `src/ui/slash/registry.ts` — registerSlash/dispatchSlash/listSlashCommands from Phase 1 Plan 05.
- `src/ui/slash/route.ts` — `/route` handler pattern to follow for new slash commands.
- `src/ui/status-bar/store.ts` — statusBarStore for `/cost` to read current values.
- `src/storage/session-dir.ts` — session directory resolver (for `--session latest` cold-start path).
- `src/ee/render.ts` — warning renderer; hook-warning persistence needs to capture rendered warnings into run artifacts.

### Established Patterns
- Async-generator streaming, React 19 + OpenTUI for TUI.
- Atomic-rename `.tmp` for cross-process safe writes.
- Heading-delimited section parsing (already used in grok-cli inherited code).
- Vitest@4.1.5 for tests; `bunx vitest run` as quick command.

### Integration Points (Phase 2 owns)
- `src/flow/` — new directory for `.muonroi-flow/` artifact system (parser, writer, migration, run manager).
- `src/flow/compaction/` — two-pass compaction engine.
- `src/ui/slash/{discuss,plan,execute,compact,clear,expand,cost}.ts` — 7 new slash command handlers.
- `tests/integration/kill-restart.test.ts` — kill-and-restart integration test.

</code_context>

<specifics>
## Specific Ideas

- The kill-restart test should use `Bun.spawn` to launch the CLI, pipe a prompt, then SIGKILL, then restart with `--session latest` and verify `.muonroi-flow/` state is restored.
- `/cost` is the simplest command — just reads statusBarStore and prints formatted output. Good quick win for Plan 05.
- Compaction should respect a token budget (e.g., 80% of context window) rather than a fixed character count — use the provider's token counting if available, or estimate at 4 chars/token.

</specifics>

<deferred>
## Deferred Ideas

- Cloud sync of `.muonroi-flow/` artifacts — Phase 4.
- Sub-agent / delegate system documentation — Phase 3 CORE-04.
- Permission modes for slash commands — Phase 3 CORE-07.

</deferred>
