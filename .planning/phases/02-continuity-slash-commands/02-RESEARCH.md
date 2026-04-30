# Phase 2: Continuity & Slash Commands - Research

**Researched:** 2026-04-30
**Domain:** File-backed workflow artifacts, deliberate compaction, slash command system, session continuity
**Confidence:** HIGH

## Summary

Phase 2 builds the `.muonroi-flow/` artifact system that coordinates state across sessions and slash commands. The core technical challenges are: (1) a tolerant markdown section parser/writer with atomic-rename durability, (2) a two-pass compaction engine that extracts decisions before compressing chat, (3) seven new slash commands wired through the existing registry, (4) kill-and-restart continuity proven by integration test, and (5) migration from the existing `.quick-codex-flow/` format.

The existing codebase provides strong foundations: `atomic-io.ts` handles `.tmp`+rename writes, `registry.ts` provides `registerSlash`/`dispatchSlash`, the `/route` handler shows the exact slash command pattern to follow, `compaction.ts` has the existing grok-cli compaction engine (single-pass LLM summarization) that Phase 2 replaces with a deliberate two-pass approach, and `sessions.ts` manages SQLite-backed session state. The `.quick-codex-flow/` on-disk format has been inspected in the workspace -- files are heading-delimited markdown with `## Section Name` headings and tolerant key-value or table content under each heading.

**Primary recommendation:** Build a heading-delimited markdown parser (`src/flow/parser.ts`) as the foundation for all `.muonroi-flow/` reads/writes, then layer the slash commands and compaction engine on top.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **5-plan slicing by workflow area:**
  - 01-PLAN: .muonroi-flow/ scaffolding + tolerant parser + migration (FLOW-01, FLOW-02, FLOW-03)
  - 02-PLAN: /discuss + /plan + /execute slash commands (FLOW-05, FLOW-06, FLOW-07)
  - 03-PLAN: Two-pass compaction + /compact + /expand + /clear (FLOW-08, FLOW-09, FLOW-10, FLOW-11)
  - 04-PLAN: Kill-restart continuity + session resume (FLOW-04, FLOW-12)
  - 05-PLAN: /cost slash command (USAGE-08)
- **Compaction strategy:** Two-pass -- pass 1 extracts decisions/facts/constraints to `decisions.md`, pass 2 compresses remaining chat. Preserve-verbatim markers use inline HTML comments `<!-- preserve -->...<!-- /preserve -->`.
- **Directory structure locked:**
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
- **Migration:** Detect `.quick-codex-flow/` at boot, prompt user, one-shot copy with section heading renames.
- **Slash command framework:** Reuse `src/ui/slash/registry.ts` from Phase 1.

### Claude's Discretion
- Run ID generation strategy (UUID vs timestamp-based)
- Exact section heading names within `.muonroi-flow/` files
- Gray-area gate UX (inline warning vs modal prompt)
- Token budget for compaction pass 2

### Deferred Ideas (OUT OF SCOPE)
- Cloud sync of `.muonroi-flow/` artifacts -- Phase 4
- Sub-agent / delegate system documentation -- Phase 3 CORE-04
- Permission modes for slash commands -- Phase 3 CORE-07
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FLOW-01 | `.muonroi-flow/` directory with locked structure | Directory scaffolding, atomic-io reuse, heading-delimited format |
| FLOW-02 | Tolerant read (sections by heading, missing OK), deterministic write (atomic rename) | Regex-based section parser, atomicWriteText utility extending atomic-io.ts |
| FLOW-03 | `.quick-codex-flow/` one-shot migration | Section mapping from QC format inspected in workspace |
| FLOW-04 | Session resume reads `.muonroi-flow/` before chat transcript | Orchestrator integration point identified in `compactContext()` and session load path |
| FLOW-05 | `/discuss` slash command with gray-area gates | Slash registry pattern from `/route`, run artifact structure from QC templates |
| FLOW-06 | `/plan` slash command with gray-area resolution gate | Gray-area register from QC run format, gate UX recommendation |
| FLOW-07 | `/execute` slash command with QC-lock execution loop | Execution wave pattern from QC templates |
| FLOW-08 | `/compact` two-pass compaction | Existing compaction.ts engine provides serialization + token estimation; new pass-1 extraction layer |
| FLOW-09 | `/clear` relock from artifacts | Reads `.muonroi-flow/` state, discards chat messages, injects summary from artifacts |
| FLOW-10 | `/expand` reverses last `/compact` | History snapshot storage in `.muonroi-flow/history/` |
| FLOW-11 | Preserve-verbatim sections survive compaction | HTML comment markers `<!-- preserve -->...<!-- /preserve -->` in pass-2 |
| FLOW-12 | Hook-derived warnings persist in run artifacts | `renderInterceptWarning()` output captured to `runs/<id>/state.md` Experience Snapshot section |
| USAGE-08 | `/cost` prints status-bar contents on demand | `statusBarStore.getState()` provides all needed data |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| vitest | 4.1.5 | Test framework | Already pinned in project |
| ai (AI SDK) | 6.0.169 | Stream + model interface | Locked stack decision |
| @opentui/core | 0.1.107 | TUI rendering | Locked stack decision |

### Supporting (new for Phase 2)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | -- | -- | Phase 2 adds no new dependencies |

**No new dependencies required.** The entire phase uses built-in Node APIs (`node:fs`, `node:path`, `node:crypto`) plus the existing project stack. The heading-delimited parser and compaction engine are project-specific logic, not library candidates.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Regex heading parser | remark/unified AST | AST is heavier, slower, and overkill for heading-delimited sections with tolerant reads. Regex is simpler and matches existing codebase patterns. |
| chars/4 token estimation | tiktoken | tiktoken adds native dependency complexity on Windows. chars/4 is already accepted for cap projection (see `estimator.ts`). Phase 4 defers accurate counting. |
| UUID run IDs | Timestamp-based IDs | Recommendation: use `Date.now().toString(36)` for human-readable, sortable, collision-safe IDs. UUID is opaque in file listings. |

## Architecture Patterns

### Recommended Project Structure
```
src/flow/
├── index.ts              # re-exports public API
├── parser.ts             # heading-delimited section parser/writer
├── scaffold.ts           # .muonroi-flow/ directory scaffolding
├── migration.ts          # .quick-codex-flow/ -> .muonroi-flow/ migration
├── run-manager.ts        # create/load/update runs/<run-id>/
├── artifact-io.ts        # read/write .muonroi-flow/ top-level files
├── compaction/
│   ├── index.ts          # orchestrates two-pass compaction
│   ├── extract.ts        # pass 1: decision/fact/constraint extraction
│   ├── compress.ts       # pass 2: token-budget chat compression
│   └── preserve.ts       # preserve-verbatim marker handling
└── __tests__/
    ├── parser.test.ts
    ├── scaffold.test.ts
    ├── migration.test.ts
    ├── run-manager.test.ts
    ├── extract.test.ts
    └── compress.test.ts

src/ui/slash/
├── discuss.ts            # /discuss handler
├── plan.ts               # /plan handler
├── execute.ts            # /execute handler
├── compact.ts            # /compact handler
├── clear.ts              # /clear handler
├── expand.ts             # /expand handler
└── cost.ts               # /cost handler

tests/integration/
└── kill-restart.test.ts  # kill-and-restart continuity test
```

### Pattern 1: Heading-Delimited Section Parser
**What:** Parse markdown files into `Map<string, string>` keyed by `## Heading Name`, write them back deterministically.
**When to use:** Every `.muonroi-flow/` file read and write.
**Example:**
```typescript
// src/flow/parser.ts
export interface SectionMap {
  sections: Map<string, string>;  // heading -> content (trimmed)
  preamble: string;               // content before first heading
}

const HEADING_RE = /^##\s+(.+)$/m;

export function parseSections(markdown: string): SectionMap {
  const lines = markdown.split('\n');
  const sections = new Map<string, string>();
  let preamble = '';
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      if (currentHeading !== null) {
        sections.set(currentHeading, currentLines.join('\n').trim());
      } else {
        preamble = currentLines.join('\n').trim();
      }
      currentHeading = match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  // Flush last section
  if (currentHeading !== null) {
    sections.set(currentHeading, currentLines.join('\n').trim());
  } else {
    preamble = currentLines.join('\n').trim();
  }

  return { sections, preamble };
}

export function serializeSections(map: SectionMap, order?: string[]): string {
  const parts: string[] = [];
  if (map.preamble) parts.push(map.preamble);

  const headings = order
    ? [...new Set([...order, ...map.sections.keys()])]
    : [...map.sections.keys()];

  for (const h of headings) {
    const content = map.sections.get(h);
    if (content !== undefined) {
      parts.push(`## ${h}\n\n${content}`);
    }
  }
  return parts.join('\n\n') + '\n';
}

// Tolerant getter -- returns undefined for missing sections, never throws
export function getSection(map: SectionMap, heading: string): string | undefined {
  return map.sections.get(heading);
}
```

### Pattern 2: Slash Command Self-Registration
**What:** Each slash command file exports a handler and self-registers via `registerSlash()` on import.
**When to use:** Every new slash command.
**Example (following `/route` pattern):**
```typescript
// src/ui/slash/cost.ts
import { statusBarStore } from '../../ui/status-bar/store.js';
import type { SlashHandler } from './registry.js';
import { registerSlash } from './registry.js';

export const handleCostSlash: SlashHandler = async (_args, _ctx) => {
  const s = statusBarStore.getState();
  return [
    `Provider: ${s.provider}`,
    `Model:    ${s.model}`,
    `Tier:     ${s.tier}`,
    `Tokens:   ${s.in_tokens} in / ${s.out_tokens} out`,
    `Session:  $${s.session_usd.toFixed(4)}`,
    `Month:    $${s.month_usd.toFixed(4)} / $${s.cap_usd.toFixed(2)} (${s.current_pct.toFixed(1)}%)`,
  ].join('\n');
};

registerSlash('cost', handleCostSlash);
```

### Pattern 3: Two-Pass Compaction
**What:** Pass 1 extracts structured decisions/facts/constraints to `decisions.md`. Pass 2 compresses remaining chat within a token budget while respecting `<!-- preserve -->` markers.
**When to use:** `/compact` command and automatic compaction trigger.
**Key insight:** The existing `compaction.ts` provides `serializeConversation()`, `estimateMessageTokens()`, and `prepareCompaction()` which are reused. The new layer adds pass-1 extraction before calling the existing summarization engine for pass-2.

### Pattern 4: Atomic Text Write (extending atomic-io.ts)
**What:** Extend `atomicWriteJSON` pattern to handle plain text/markdown files.
**When to use:** All `.muonroi-flow/` file writes.
```typescript
// Extend src/storage/atomic-io.ts
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
```

### Anti-Patterns to Avoid
- **Don't parse markdown with a full AST library:** The files are simple heading-delimited sections. Regex is faster, simpler, and has zero dependency cost. The tolerant parser never throws on malformed input -- it just returns fewer sections.
- **Don't store run state in SQLite:** `.muonroi-flow/` is repo-local and git-trackable by design. SQLite is for session transcripts only. This separation is critical for Phase 4 cloud sync.
- **Don't make compaction pass-1 depend on LLM:** Decision extraction in pass-1 should be deterministic regex/pattern-based (find `<!-- preserve -->` blocks, find explicit "Decision:" patterns). Only pass-2 uses the LLM for summarization.
- **Don't block on EE for slash commands:** Slash commands run in the TUI process. EE calls are fire-and-forget (PostToolUse pattern). Slash handlers must return strings, not depend on EE availability.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Custom write-check-rename | Existing `atomicWriteJSON` pattern + new `atomicWriteText` | Edge cases with `.tmp` cleanup on abort already solved |
| Token estimation | Custom tokenizer | Existing `estimateMessageTokens()` from `compaction.ts` | chars/4 is accepted for Phase 2; tiktoken deferred to Phase 4 |
| Session management | Custom session lookup | Existing `SessionStore.openSession('latest')` | SQLite-backed, already handles workspace scoping |
| Slash command dispatch | Custom command router | Existing `registerSlash`/`dispatchSlash` from `registry.ts` | Pattern proven by `/route` handler |
| Conversation serialization | Custom message-to-text | Existing `serializeConversation()` from `compaction.ts` | Handles all message roles, tool calls, tool results correctly |

**Key insight:** Phase 2 builds ON TOP of Phase 0+1 infrastructure. The only genuinely new code is the heading-delimited parser, the `.muonroi-flow/` artifact layer, the two-pass compaction orchestrator, and the slash command handlers themselves.

## Common Pitfalls

### Pitfall 1: Compaction Drops Decisions
**What goes wrong:** Single-pass compaction summarizes everything including critical decisions, losing exact wording of user constraints and locked choices.
**Why it happens:** The existing grok-cli compaction is a single-pass LLM summarization that treats all content equally.
**How to avoid:** Two-pass design is locked: pass-1 extracts decisions/facts/constraints to `decisions.md` BEFORE pass-2 compresses. `<!-- preserve -->` markers ensure verbatim sections survive.
**Warning signs:** After `/compact`, user finds decisions missing from `decisions.md`. Test: verify every `<!-- preserve -->` block appears verbatim after compaction.

### Pitfall 2: Kill-Restart Loses State
**What goes wrong:** TUI killed with SIGKILL mid-write, restart finds corrupted or missing `.muonroi-flow/` artifacts.
**Why it happens:** Direct writes to final path without atomic rename; or reading from chat transcript instead of disk artifacts on restart.
**How to avoid:** All writes use atomic `.tmp`+rename. On restart, orchestrator reads `.muonroi-flow/runs/<id>/state.md` BEFORE loading chat transcript from SQLite.
**Warning signs:** Integration test kills TUI with SIGKILL and restart cannot find active run state.

### Pitfall 3: Migration Corrupts Files
**What goes wrong:** `.quick-codex-flow/` migration changes heading names incorrectly or drops sections that don't match the expected format.
**Why it happens:** Assuming QC files have a fixed structure. Inspected QC files show varying section counts and formats across different runs.
**How to avoid:** Migration copies files then applies heading renames using the tolerant parser. Unknown sections are preserved as-is. One-shot with user confirmation, no rollback needed (original `.quick-codex-flow/` is NOT deleted).
**Warning signs:** Migration produces files with fewer sections than the source.

### Pitfall 4: Gray-Area Gate Blocks Indefinitely
**What goes wrong:** `/plan` refuses to proceed because gray areas exist, but user doesn't know how to resolve them.
**Why it happens:** Gate UX is unclear -- user can't see which gray areas are open or how to resolve them.
**How to avoid:** When `/plan` is blocked by unresolved gray areas, print the exact list of open items with their IDs, questions, and resolution paths. Include a hint: "Resolve with /discuss or edit .muonroi-flow/runs/<id>/gray-areas.md directly."
**Warning signs:** User runs `/plan` repeatedly and gets the same block message with no actionable guidance.

### Pitfall 5: Expand After Multiple Compactions
**What goes wrong:** `/expand` restores from the wrong snapshot or loses track of compaction history depth.
**Why it happens:** Multiple `/compact` calls create multiple history snapshots. `/expand` must restore the most recent one.
**How to avoid:** History snapshots are timestamped (`history/<iso-timestamp>.md`). `/expand` always restores from the latest by filename sort. After restore, the snapshot file is deleted (preventing double-expand).
**Warning signs:** `/expand` + `/expand` restores the same content twice (snapshot not cleaned up).

### Pitfall 6: Slash Commands Access Flow State Without Active Run
**What goes wrong:** `/plan`, `/execute`, `/compact` crash or return confusing errors when no run is active.
**Why it happens:** Commands assume an active run exists in `.muonroi-flow/runs/`.
**How to avoid:** Every slash command that requires an active run should check first and return a helpful message: "No active run. Start with /discuss to create one."
**Warning signs:** Unhandled null/undefined when reading `runs/<id>/state.md`.

## Code Examples

### Existing Compaction Engine (grok-cli inherited)
The current `src/orchestrator/compaction.ts` provides:
- `estimateMessageTokens(message)` -- chars/4 estimation per message
- `estimateConversationTokens(systemPrompt, messages)` -- total conversation tokens
- `shouldCompactContext(contextTokens, contextWindow, settings)` -- trigger check
- `prepareCompaction(messages, systemPrompt, settings)` -- finds cut point, splits messages
- `serializeConversation(messages)` -- renders messages as text for summarization
- `generateCompactionSummary(provider, modelId, preparation)` -- LLM-based summarization

Phase 2's two-pass compaction wraps these: pass-1 runs BEFORE `prepareCompaction()`, extracting decisions to disk. Pass-2 calls the existing engine for the remaining chat.

### Session Resume Flow (existing)
```
SessionStore.openSession('latest') -> SQLite lookup -> SessionInfo
  -> loadTranscript(sessionId) -> buildEffectiveTranscript() -> ModelMessage[]
  -> orchestrator loads messages into this.messages
```
Phase 2 inserts a hook: AFTER session lookup, BEFORE transcript load, read `.muonroi-flow/runs/<id>/state.md` and inject the Resume Digest into the system prompt.

### Quick Codex Flow Format (inspected from workspace)
Top-level files: `STATE.md`, `PROJECT-ROADMAP.md`, `BACKLOG.md`
Run files: `<slug>.md` with heading-delimited sections

Migration mapping:
| QC File | -> | muonroi-flow File |
|---------|-----|-------------------|
| `STATE.md` | -> | `state.md` |
| `PROJECT-ROADMAP.md` | -> | `roadmap.md` |
| `BACKLOG.md` | -> | `backlog.md` |
| `<run>.md` sections `## Resume Digest` | -> | `runs/<id>/state.md` |
| `<run>.md` sections `## Gray Area Register` | -> | `runs/<id>/gray-areas.md` |
| `<run>.md` sections `## Delegation State` | -> | `runs/<id>/delegations.md` |
| `<run>.md` sections `## Delivery Roadmap` | -> | `runs/<id>/roadmap.md` |
| `<run>.md` sections `## Decision Register` | -> | `decisions.md` (appended) |

### Kill-Restart Integration Test Pattern
```typescript
// tests/integration/kill-restart.test.ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

describe('kill-restart continuity', () => {
  it('restores .muonroi-flow/ state after SIGKILL', async () => {
    const cwd = /* temp dir with .muonroi-flow/ pre-seeded */;

    // 1. Spawn CLI process
    const proc = spawn('bun', ['run', 'src/index.ts', '--session', 'latest'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 2. Wait for boot (check stdout for ready signal)
    await waitForReady(proc);

    // 3. Write state to .muonroi-flow/ via /discuss
    proc.stdin.write('/discuss test scenario\n');
    await waitForOutput(proc, 'run created');

    // 4. SIGKILL (not SIGTERM -- no cleanup handlers)
    proc.kill('SIGKILL');

    // 5. Verify .muonroi-flow/ state survived on disk
    const state = await fs.readFile(
      path.join(cwd, '.muonroi-flow/runs/*/state.md'),
      'utf8'
    );
    expect(state).toContain('## Resume Digest');

    // 6. Restart and verify state restoration
    const proc2 = spawn('bun', ['run', 'src/index.ts', '--session', 'latest'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForReady(proc2);
    // Verify the orchestrator loaded .muonroi-flow/ state
    proc2.stdin.write('/cost\n');
    const output = await waitForOutput(proc2, 'Provider:');
    proc2.kill();
    expect(output).toBeTruthy();
  }, 30_000);
});
```

**Note on SIGKILL on Windows:** `process.kill('SIGKILL')` maps to `TerminateProcess` on Windows. Bun.spawn and child_process.spawn both support this. The test should work cross-platform but may need a longer timeout on Windows.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| grok-cli single-pass LLM compaction | Two-pass: extract decisions first, then compress | Phase 2 (new) | Decisions never lost during compaction |
| `.quick-codex-flow/` monolithic run files | `.muonroi-flow/` split into structured directory | Phase 2 (new) | Enables per-aspect reads, Phase 4 cloud sync |
| Chat transcript as sole session state | `.muonroi-flow/` artifacts as primary state, chat as supplement | Phase 2 (new) | Kill-restart continuity from disk alone |
| grok-cli compaction-summary-only resume | Resume Digest in `.muonroi-flow/runs/<id>/state.md` | Phase 2 (new) | Structured resume with exact file paths, decisions, next steps |

## Open Questions

1. **SIGKILL test reliability on Windows CI**
   - What we know: `process.kill('SIGKILL')` works on Windows via TerminateProcess. Bun.spawn supports it.
   - What's unclear: Whether GitHub Actions Windows runners handle SIGKILL+restart reliably in CI (timing sensitivity).
   - Recommendation: Implement the test, mark it with a generous timeout (30s). If flaky in CI, gate it as `test.skipIf(process.platform === 'win32')` and rely on manual verification on dev box.

2. **Token budget for compaction pass-2**
   - What we know: Existing `DEFAULT_KEEP_RECENT_TOKENS = 20_000` and `DEFAULT_RESERVE_TOKENS = 16_384` in `compaction.ts`. chars/4 estimator accepted.
   - What's unclear: Optimal percentage of context window for the compressed output.
   - Recommendation: Use 80% of context window minus reserve tokens as the budget for pass-2. This leaves 20% headroom for system prompt + user's next message. Make it configurable via `flow-config` in `.muonroi-flow/`.

3. **Run ID collision with timestamp-based IDs**
   - What we know: `Date.now().toString(36)` gives ~8-char sortable IDs.
   - What's unclear: Whether two rapid `/discuss` calls could collide.
   - Recommendation: Use `Date.now().toString(36) + randomBytes(2).toString('hex')` for 12-char IDs (similar to session ID pattern). Sortable, readable, collision-safe.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 |
| Config file | `vitest.config.ts` |
| Quick run command | `bunx vitest run --reporter=verbose` |
| Full suite command | `bunx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FLOW-01 | .muonroi-flow/ directory scaffolding | unit | `bunx vitest run src/flow/__tests__/scaffold.test.ts -x` | Wave 0 |
| FLOW-02 | Tolerant section parser + atomic write | unit | `bunx vitest run src/flow/__tests__/parser.test.ts -x` | Wave 0 |
| FLOW-03 | .quick-codex-flow/ migration | unit | `bunx vitest run src/flow/__tests__/migration.test.ts -x` | Wave 0 |
| FLOW-04 | Kill-restart state restoration | integration | `bunx vitest run tests/integration/kill-restart.test.ts -x` | Wave 0 |
| FLOW-05 | /discuss creates run + gray-area gates | unit | `bunx vitest run src/ui/slash/__tests__/discuss.test.ts -x` | Wave 0 |
| FLOW-06 | /plan blocks on unresolved gray areas | unit | `bunx vitest run src/ui/slash/__tests__/plan.test.ts -x` | Wave 0 |
| FLOW-07 | /execute enters QC-lock loop | unit | `bunx vitest run src/ui/slash/__tests__/execute.test.ts -x` | Wave 0 |
| FLOW-08 | /compact two-pass compaction | unit | `bunx vitest run src/flow/compaction/__tests__/extract.test.ts -x` | Wave 0 |
| FLOW-09 | /clear relocks from artifacts | unit | `bunx vitest run src/ui/slash/__tests__/clear.test.ts -x` | Wave 0 |
| FLOW-10 | /expand reverses last /compact | unit | `bunx vitest run src/ui/slash/__tests__/expand.test.ts -x` | Wave 0 |
| FLOW-11 | Preserve-verbatim survives compaction | unit | `bunx vitest run src/flow/compaction/__tests__/preserve.test.ts -x` | Wave 0 |
| FLOW-12 | Hook warnings persist in run artifacts | unit | `bunx vitest run src/flow/__tests__/run-manager.test.ts -x` | Wave 0 |
| USAGE-08 | /cost prints status-bar contents | unit | `bunx vitest run src/ui/slash/__tests__/cost.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `bunx vitest run --reporter=verbose`
- **Per wave merge:** `bunx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/flow/__tests__/parser.test.ts` -- tolerant section parser tests
- [ ] `src/flow/__tests__/scaffold.test.ts` -- directory scaffolding tests
- [ ] `src/flow/__tests__/migration.test.ts` -- QC migration tests
- [ ] `src/flow/__tests__/run-manager.test.ts` -- run create/load/update tests
- [ ] `src/flow/compaction/__tests__/extract.test.ts` -- pass-1 decision extraction
- [ ] `src/flow/compaction/__tests__/preserve.test.ts` -- preserve-verbatim handling
- [ ] `src/ui/slash/__tests__/discuss.test.ts` -- /discuss handler
- [ ] `src/ui/slash/__tests__/plan.test.ts` -- /plan handler with gray-area gate
- [ ] `src/ui/slash/__tests__/execute.test.ts` -- /execute handler
- [ ] `src/ui/slash/__tests__/compact.test.ts` -- /compact handler
- [ ] `src/ui/slash/__tests__/clear.test.ts` -- /clear handler
- [ ] `src/ui/slash/__tests__/expand.test.ts` -- /expand handler
- [ ] `src/ui/slash/__tests__/cost.test.ts` -- /cost handler
- [ ] `tests/integration/kill-restart.test.ts` -- kill-and-restart integration test

## Detailed Technical Findings

### Research Q1: Quick Codex On-Disk Format
**Confidence: HIGH** (inspected actual files in workspace)

`.quick-codex-flow/` contains:
- **Top-level**: `STATE.md` (active run pointer, lock, gate, phase), `PROJECT-ROADMAP.md` (milestone/track/run register), `BACKLOG.md` (parking lot, deferred decisions, future seeds)
- **Run files**: Individual `.md` files per run (NOT in subdirectories), containing all sections in one file: `## Requirement Baseline`, `## Project Alignment`, `## Workflow State`, `## Delegation State`, `## Gray Area Register`, `## Delivery Roadmap`, `## Resume Digest`, `## Compact-Safe Summary`, `## Experience Snapshot`, `## Verified Plan`, etc.

Key difference from `.muonroi-flow/`: QC stores everything in a single run file; muonroi-flow splits into per-aspect files in `runs/<id>/`. Migration needs to SPLIT a single QC run file into 4 target files (roadmap.md, state.md, delegations.md, gray-areas.md).

### Research Q2: Existing Compaction Path
**Confidence: HIGH** (read source code)

The inherited grok-cli compaction in `src/orchestrator/compaction.ts`:
1. `shouldCompactContext()` checks if tokens exceed `contextWindow - reserveTokens`
2. `prepareCompaction()` finds a cut point keeping recent messages (~20k tokens)
3. `serializeConversation()` renders messages as labeled text blocks
4. `generateCompactionSummary()` calls LLM with summarization prompt
5. Result stored as `[Context checkpoint summary]` system message

The orchestrator's `compactContext()` method (line ~1663) calls this pipeline, stores the compaction in SQLite via `appendCompaction()`, and replaces `this.messages`.

**Phase 2 changes:** Insert pass-1 before step 2. Pass-1 scans messages for decisions/facts/constraints (via `<!-- preserve -->` markers and pattern matching), writes them to `.muonroi-flow/decisions.md`, then pass-2 runs the existing pipeline on the remaining (non-preserved) content. The existing summarization prompts in `compaction.ts` can be reused for pass-2.

### Research Q3: Tolerant Section Parsing
**Confidence: HIGH** (design decision, no external dependency)

Regex-based parsing is the right approach for this use case:
- Files are `## Heading`-delimited with free-form content under each heading
- Missing sections must be tolerated (return undefined, not throw)
- Writer must be deterministic (same sections -> same output) for atomic-rename safety
- No need for AST features like nested headings, link resolution, or frontmatter parsing

The pattern is already used informally in the codebase (compaction summary header detection uses `startsWith`). Formalizing it in `parser.ts` with proper tests is the clean path.

### Research Q4: Kill-and-Restart Integration Test
**Confidence: MEDIUM** (Bun.spawn works, CI reliability uncertain)

`child_process.spawn` (or `Bun.spawn`) can launch the CLI, pipe stdin, and `kill('SIGKILL')`. On Windows, SIGKILL maps to `TerminateProcess`. The key test assertion:
1. Pre-seed `.muonroi-flow/` state in a temp directory
2. Launch CLI with `--session latest`
3. Verify CLI writes state to `.muonroi-flow/` (via /discuss)
4. SIGKILL the process
5. Verify `.muonroi-flow/` files survive on disk
6. Relaunch with `--session latest`
7. Verify state restoration (check /cost or similar output)

**Risk:** The test needs the full TUI boot path, which requires OpenTUI. In integration tests, this may need `--headless` mode (Phase 3 CORE-01). Alternative: test at the module level -- call the flow state read/write functions directly and verify atomic-write crash safety with simulated interruption.

### Research Q5: Gray-Area Gate UX
**Confidence: HIGH** (recommendation based on QC patterns)

Recommendation: **Inline warning, not modal prompt.**
- When `/plan` is invoked with unresolved gray areas, print:
  ```
  /plan blocked: 2 unresolved gray areas

  G1 [open] Should we use X or Y for the migration?
     Resolution path: Ask user in /discuss
  G3 [open] Token budget for pass 2?
     Resolution path: Claude's discretion — recommend and document

  Resolve these before running /plan, or edit .muonroi-flow/runs/<id>/gray-areas.md directly.
  ```
- This follows the existing slash command pattern (return a string, no interactive prompt)
- The QC format already has a `## Gray Area Register` table with ID, Type, Question, Owner, Resolution path, Status columns

### Research Q6: Token Counting for Compaction Budget
**Confidence: HIGH** (read source code)

AI SDK v6 does NOT expose a standalone token counting API. The project already has `estimateMessageTokens()` in `compaction.ts` using chars/4. The `estimator.ts` file in `src/usage/` confirms this is the accepted approach for Phase 2:

> "Phase 1 explicitly accepts chars/4 estimator -- fine for cap projection, NOT for billing. Phase 4 swaps in tiktoken-encoder for actual token counts."

**Recommendation:** Reuse `estimateMessageTokens()` and `estimateConversationTokens()` from the existing compaction engine. The token budget for pass-2 should be `0.8 * contextWindow - reserveTokens` (80% of context minus reserve). This matches the existing `DEFAULT_RESERVE_TOKENS = 16_384` pattern.

### Research Q7: Session Resume and .muonroi-flow/ Integration
**Confidence: HIGH** (read source code)

Current session resume flow:
1. `SessionStore.openSession('latest')` returns `SessionInfo` with `id`, `cwdLast`
2. `loadTranscript(sessionId)` calls `buildEffectiveTranscript()` which applies the latest compaction
3. Orchestrator sets `this.messages` from the transcript
4. If a compaction exists, it's prepended as a `[Context checkpoint summary]` system message

**Phase 2 integration point:** After step 1 (have `sessionId` and `cwdLast`), BEFORE step 2:
- Read `.muonroi-flow/state.md` from `cwdLast` to find active run ID
- Read `.muonroi-flow/runs/<id>/state.md` for Resume Digest
- Inject Resume Digest into the system prompt (prepend to existing system instructions)
- This ensures `.muonroi-flow/` state is loaded even if the chat transcript is empty (e.g., after SIGKILL before any messages were saved)

The `getSessionDir()` function in `session-dir.ts` resolves the session's on-disk directory, but `.muonroi-flow/` lives in the WORKSPACE (cwd), not in the session directory. The integration reads from `cwdLast` (the session's last working directory).

## Sources

### Primary (HIGH confidence)
- `src/orchestrator/compaction.ts` -- existing compaction engine, token estimation, serialization
- `src/storage/sessions.ts` -- SessionStore, session resume flow
- `src/storage/transcript.ts` -- transcript loading, compaction application
- `src/ui/slash/registry.ts` -- slash command registration pattern
- `src/ui/slash/route.ts` -- slash command handler example
- `src/storage/atomic-io.ts` -- atomic write pattern
- `src/ui/status-bar/store.ts` -- StatusBarState interface for /cost
- `src/ee/render.ts` -- EE warning rendering for FLOW-12
- `D:/Personal/Core/.quick-codex-flow/` -- actual QC files on disk (migration source format)
- `D:/Personal/Core/quick-codex/templates/.quick-codex-flow/` -- QC template format

### Secondary (MEDIUM confidence)
- `src/orchestrator/orchestrator.ts` -- compactContext() integration point (~line 1663)
- `src/usage/estimator.ts` -- confirms chars/4 accepted for Phase 2

### Tertiary (LOW confidence)
- SIGKILL behavior on Windows CI -- inferred from Node.js docs, not tested in this specific CI environment

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing patterns reused
- Architecture: HIGH -- directory structure locked in CONTEXT.md, parser pattern well-understood
- Pitfalls: HIGH -- inspected existing compaction code and QC format directly
- Integration: MEDIUM -- kill-restart test reliability on Windows CI uncertain

**Research date:** 2026-04-30
**Valid until:** 2026-05-30 (stable domain, no fast-moving dependencies)

## RESEARCH COMPLETE
