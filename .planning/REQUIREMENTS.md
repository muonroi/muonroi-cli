# Requirements: muonroi-cli

**Defined:** 2026-05-01
**Core Value:** Sell the orchestration intelligence (memory + router + cap + compaction) that stretches BYOK tokens 2-3x further than any subscription-locked tool.

## v1.2 Requirements

Requirements for closing the EE learning loop. Each maps to roadmap phases.

### Session Extraction

- [x] **EXTRACT-01**: CLI calls /api/extract with session transcript when session ends (cleanup/SIGINT)
- [x] **EXTRACT-02**: Transcript is compacted before sending to extract (reuse existing compaction logic)
- [x] **EXTRACT-03**: Extraction is fire-and-forget — does not block CLI shutdown beyond 2s
- [x] **EXTRACT-04**: Extraction skipped if session < 5 messages (no meaningful content)

### Offline Queue

- [x] **QUEUE-01**: EE client buffers failed requests to local queue when server unreachable
- [x] **QUEUE-02**: Queue persists on disk (~/.muonroi-cli/ee-offline-queue/)
- [x] **QUEUE-03**: Queue replays automatically when EE server becomes reachable again
- [x] **QUEUE-04**: Queue has max size cap (100 entries) to prevent unbounded growth
- [x] **QUEUE-05**: Heavy events (extract) drain separately in background

### Prompt-stale Reconciliation

- [x] **STALE-01**: PIL Layer 3 tracks suggestions injected into prompt
- [x] **STALE-02**: After each turn, call /api/prompt-stale for suggestions not used by agent
- [x] **STALE-03**: Reconciliation is async fire-and-forget (does not block next turn)

## v1.6 Requirements — Council Quality & Trust

> **Context:** `.planning/research/v1.6-council-quality-context.md` (full audit, root causes, design rationale).
> **Trigger:** 2026-05-08 audit of council session `1b4f7528ddc8` — debate produced zero-citation synthesis from 2 LLM monologues; research role couldn't reach internet/URL/source as user requested.

### Council Accounting & Research Wiring (Phase 14)

- [ ] **CQ-01**: `[Council Memory]` records expose accurate `stats.calls` matching the actual count of LLM API calls made during the run (no longer always `0`)
- [ ] **CQ-02**: `[Council Memory] finalPositions` reflects each agent's actual end-of-debate position (no longer always empty strings)
- [ ] **CQ-03**: When MCP servers (tavily, playwright, chrome-devtools, filesystem) are enabled, `llm.research()` exposes them as tools alongside builtin (bash/grep/read_file)
- [ ] **CQ-04**: When the topic contains an `https?://` URL, the research role MUST invoke a Playwright/Chrome-DevTools tool at least once before returning findings; absence of such a call is logged as a research gap
- [ ] **CQ-05**: Research output enforces three labelled sections — `## Source Code Findings` / `## Internet Findings` / `## Frontend Findings (live)` — with each finding citing `[file:line]`, `[url]`, or `[snapshot:uid]`

### Tool-grounded Debate Rounds (Phase 15)

- [ ] **CQ-06**: Opening, response, and follow-up debate calls accept and use a merged `tools` parameter (MCP + builtin), so agents can verify claims with grep/fetch/browser during rounds
- [ ] **CQ-07**: Stance prompts mandate a verify-then-refute pattern; when an agent disputes a verifiable claim from its partner, the response must include a `[REFUTED via <tool>:<evidence>]` citation
- [ ] **CQ-08**: `evaluateDebate` (leader judge) computes `evidenceDensity` (citations per claim) and `disagreementResolved` (refutes + concessions count); when `evidenceDensity < 0.3` after ≥2 rounds, leader forces `needsResearch=true` with a specific query
- [ ] **CQ-09**: Each round's exchanges persist to the session DB as a `[Council Round N]` system message including each speaker's response and citations
- [ ] **CQ-10**: Debate-planner uses structured JSON output (provider schema mode where supported) and retries once with explicit schema feedback before falling back to generic stances

### PIL + EE Integration into Council (Phase 16)

- [ ] **CQ-11**: `runCouncil` invokes `runPipeline(topic)` at the start of the run and propagates `taskType`, `complexityTier`, `domain`, and `outputStyle` to debate-planner and synthesis
- [ ] **CQ-12**: New `ee/council-bridge.ts` module exposes `queryExperience(topic, domain)` returning relevant past EE warnings/principles; degrades gracefully when EE is offline
- [ ] **CQ-13**: Debate-planner injects experience snippets into stance generation so leader proposes stances calibrated by past mistakes
- [ ] **CQ-14**: When EE returns ≥1 high-confidence warning, an additional "Experience Auditor" stance is auto-added with a lens dynamically built from the top warning
- [ ] **CQ-15**: Tools used inside debate rounds are wrapped with `wrapToolWithEeCheck` so PreToolUse experience warnings stream into the debate output before the tool executes
- [ ] **CQ-16**: After synthesis, `ee/judge.ts:judgeOutcome` scores confidence ∈ [0,1]; when confidence `< 0.5` the leader either forces another debate round or marks the synthesis `[NEEDS HUMAN REVIEW]`
- [ ] **CQ-17**: `ee/phase-outcome.ts:recordCouncilOutcome` pushes the synthesis + verdict + confidence to the EE brain so it learns from each council run
- [ ] **CQ-18**: Synthesis text respects `ctx.outputStyle` (concise/balanced/detailed) from PIL Layer 6 instead of always using a hard default
- [ ] **CQ-19**: A user-facing feature flag `council.experienceMode = off | advisory | enforcing` controls EE involvement (default `advisory`) and is documented in `/gsd-settings`

### Council Robustness & Observability (Phase 17)

- [ ] **CQ-20**: `parseOutcome` logs the raw synthesis text on parse failure and tries a shape-based fallback parser using `debatePlan.outputShape.sections` before giving up
- [ ] **CQ-21**: New slash command `/council inspect <session-id>` renders any past `[Council Memory]` record with citations, per-agent tool calls, evidence density, and the leader's per-round evaluation
- [ ] **CQ-22**: Every tool call inside research and rounds persists as a `[Council Tool Trace]` system message (truncated to 2KB per arg/result) so a session can be forensically replayed
- [ ] **CQ-23**: `muonroi doctor` warns when MCP `tavily` or `playwright` is not enabled but the user has run ≥3 debates whose topic contained URLs or research keywords
- [ ] **CQ-24**: New `docs/Council.md` documents the integrated flow (PIL → EE warnings → planner → debate with tools → EE judge → synthesis) with a worked example

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Deeper EE Integration

- **DEEP-01**: Local mistake detection in CLI (mirror EE's 5 pattern detector)
- **DEEP-02**: CLI-triggered evolution cycle after N sessions
- **DEEP-03**: Principle sharing between CLI instances via portable JSON

## Out of Scope

| Feature | Reason |
|---------|--------|
| Local EE brain (embedded) | CLI uses EE via HTTP/bridge — embedding the full brain is a v2+ concern |
| Shell bootstrap integration | CLI has its own `doctor` command; EE shell bootstrap is for standalone EE |
| Multi-user isolation | Single-user CLI; multi-user is a cloud/SaaS concern |
| EE admin tools (demote, seed, dogfood) | These are EE-side tools, not CLI concerns |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXTRACT-01 | Phase 08 | Complete |
| EXTRACT-02 | Phase 08 | Complete |
| EXTRACT-03 | Phase 08 | Complete |
| EXTRACT-04 | Phase 08 | Complete |
| QUEUE-01 | Phase 09 | Complete |
| QUEUE-02 | Phase 09 | Complete |
| QUEUE-03 | Phase 09 | Complete |
| QUEUE-04 | Phase 09 | Complete |
| QUEUE-05 | Phase 09 | Complete |
| STALE-01 | Phase 10 | Complete |
| STALE-02 | Phase 10 | Complete |
| STALE-03 | Phase 10 | Complete |
| CQ-01 | Phase 14 | Pending |
| CQ-02 | Phase 14 | Pending |
| CQ-03 | Phase 14 | Pending |
| CQ-04 | Phase 14 | Pending |
| CQ-05 | Phase 14 | Pending |
| CQ-06 | Phase 15 | Pending |
| CQ-07 | Phase 15 | Pending |
| CQ-08 | Phase 15 | Pending |
| CQ-09 | Phase 15 | Pending |
| CQ-10 | Phase 15 | Pending |
| CQ-11 | Phase 16 | Pending |
| CQ-12 | Phase 16 | Pending |
| CQ-13 | Phase 16 | Pending |
| CQ-14 | Phase 16 | Pending |
| CQ-15 | Phase 16 | Pending |
| CQ-16 | Phase 16 | Pending |
| CQ-17 | Phase 16 | Pending |
| CQ-18 | Phase 16 | Pending |
| CQ-19 | Phase 16 | Pending |
| CQ-20 | Phase 17 | Pending |
| CQ-21 | Phase 17 | Pending |
| CQ-22 | Phase 17 | Pending |
| CQ-23 | Phase 17 | Pending |
| CQ-24 | Phase 17 | Pending |

**Coverage:**
- v1.2 requirements: 12 total — all mapped, all complete
- v1.6 requirements: 24 total — all mapped to Phases 14–17, all pending
- Total mapped: 36 / 36
- Unmapped: 0

---
*Requirements defined: 2026-05-01*
*Last updated: 2026-05-08 — added v1.6 (CQ-01..CQ-24) for Council Quality & Trust milestone*
