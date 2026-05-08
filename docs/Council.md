# Council — Integrated Multi-Agent Debate

`/council <topic>` runs a structured multi-model adversarial debate. This document describes every phase of the pipeline from user input to persisted memory.

## Flow Overview

```
User input (/council <topic>)
  │
  ├─ [A] PIL Pipeline (runPipeline)
  │    taskType, complexityTier, domain, outputStyle, grayAreas
  │
  ├─ [B] EE Experience Pre-fetch (queryExperience — parallel with A)
  │    Queries experience-behavioral + experience-principles collections
  │    High-confidence warnings → auto-add "Experience Auditor" stance
  │
  ├─ [C] Clarification (runClarification)
  │    Leader generates clarifying questions (seeded by PIL grayAreas)
  │    User answers → ClarifiedSpec (problemStatement, constraints, successCriteria, scope)
  │
  ├─ [D] Preflight (runPreflight)
  │    User reviews participant list + research flag → approve/reject
  │
  ├─ [E] Debate Planning (planDebate)
  │    Leader generates DebatePlan: stances + outputShape (sections + guardrails)
  │    Experience Auditor stance injected if EE warnings present
  │
  ├─ [F] Debate (runDebate)
  │    ├─ Research phase (llm.research) — filesystem + tavily + playwright MCP
  │    │   └─ [Council Tool Trace] system messages persisted per tool call
  │    ├─ Opening statements (parallel per participant)
  │    └─ Rounds (up to 8):
  │         each pair calls llm.debate() → verify-then-refute pattern
  │         [Council Tool Trace] per tool call
  │         [Council Round N] persisted after each round
  │         Leader evaluation: evidenceDensity, disagreementResolved
  │         Mid-debate research injected if evidenceDensity < 0.3 at round >= 2
  │
  ├─ [G] Synthesis (runPlanning)
  │    Leader synthesizes to EnhancedCouncilOutcome JSON
  │    parseOutcome: JSON parse → shape-based fallback → raw log on failure
  │    outputStyle (concise/balanced/detailed) from PIL propagated
  │
  ├─ [H] EE Judge (judgeCouncilOutcome)
  │    Returns confidence ∈ [0,1]; < 0.5 → [NEEDS HUMAN REVIEW] flag
  │
  ├─ [I] EE Record (recordCouncilOutcome)
  │    Posts synthesis + verdict to EE brain (fire-and-forget)
  │
  └─ [J] Persist ([Council Memory])
       Full record stored as system message in session DB
```

## Phase-by-Phase Reference

### A — PIL Pipeline

`runPipeline(topic, { sessionId })` in `src/pil/pipeline.ts`.

Returns `PipelineContext`:
- `taskType`: "feature" | "bugfix" | "refactor" | "question" | "research" | ...
- `complexityTier`: "trivial" | "moderate" | "complex"
- `domain`: detected domain string (e.g. "backend", "frontend", "data")
- `outputStyle`: "concise" | "balanced" | "detailed"
- `grayAreas`: string[] of unresolved questions seeded into clarification

Fail-open: if PIL throws, council continues without context.

### B — EE Experience Pre-fetch

`queryExperience(topic, domain, signal)` in `src/ee/council-bridge.ts`.

Single `searchByText` call to `experience-behavioral` + `experience-principles` collections on EE VPS (`experience.muonroi.com`). Hard latency cap: 1.5s on the critical path. Falls back to `{ warnings: [] }` on timeout or VPS unreachable.

Controlled by `council.experienceMode` setting (`off` | `advisory` | `enforcing`, default: `advisory`). Set via `/gsd-settings`.

When `experienceMode = off`: skipped entirely (zero latency cost).

### C — Clarification

Leader LLM generates 3–5 clarifying questions. Gray-area questions from PIL are prepended. User answers inline. Produces `ClarifiedSpec`.

Skip with `options.skipClarification = true` (used by Product Loop auto-council).

### D — Preflight

User reviews: participant list, models assigned, whether research is needed. Approve or reject (cancels council).

### E — Debate Planning

`planDebate(spec, leaderModelId, llm, eeWarnings, experienceMode, taskType, complexityTier)` in `src/council/debate-planner.ts`.

Returns `DebatePlan`:
```typescript
{
  intentSummary: string;        // one-sentence intent
  stances: DebateStance[];      // leader-proposed debate lenses
  outputShape: {
    kind: string;               // e.g. "evaluation", "decision"
    sections: OutputSection[];  // dynamic JSON keys + headings
    guardrails: string[];       // synthesizer constraints
  };
}
```

When `eeWarnings.length >= 1`: an "Experience Auditor" stance is auto-added with a lens built from the top warning.

Uses structured JSON output (`generateObject`) with one retry on schema failure; fallback rate < 10%.

### F — Debate

#### Research Phase

`llm.research(model, topic, context, signal, persistTrace)` in `src/council/llm.ts`.

Tools available (merged): builtin (bash, grep, read_file) + MCP (tavily, playwright, chrome-devtools, filesystem) when enabled.

When topic contains `https?://`: system prompt mandates at least one playwright/chrome-devtools call. If omitted, a `## Research Gap` section is appended to the output.

Output format enforced (three sections):
- `## Source Code Findings` — `[file:line]` citations
- `## Internet Findings` — `[url]` citations
- `## Frontend Findings (live)` — `[snapshot:uid]` citations

Each section marked `(no findings — gap noted)` if empty.

After every tool call: `persistTrace` callback emits `[Council Tool Trace] tool=<name> args=<truncated 2KB> result=<truncated 2KB>` as a `council_status` chunk, which the orchestrator persists as a system message.

#### Debate Rounds

Up to 8 rounds. Each round:
1. Each pair calls `llm.debate(model, system, prompt, signal, persistTrace)`.
2. `debate()` uses `wrapToolsWithEeCheck` — EE PreToolUse intercept fires before each tool call.
3. Tool traces persisted as above.
4. Round persisted as `[Council Round N]` system message.
5. Leader evaluates: `evidenceDensity` (citations/claims ratio), `disagreementResolved` (REFUTED count).
6. If `evidenceDensity < 0.3` at round ≥ 2: forced mid-debate research query injected.
7. Leader sets `shouldContinue = false` when convergence reached.

Agents use verify-then-refute pattern:
- Claims challenged with: `[REFUTED via <tool>:<evidence>]` or explicit concession.

### G — Synthesis

`runPlanning(debateState, spec, participants, leaderModelId, respondToPreflight, llm, debatePlan, outputStyle)` in `src/council/planner.ts`.

Leader synthesizes all exchange logs + final positions into `EnhancedCouncilOutcome` JSON matching `debatePlan.outputShape`.

`parseOutcome` resilience (CQ-20):
1. JSON parse attempted.
2. On failure: `console.error('[Council] parseOutcome failed — raw synthesis text:', synthesisText)`.
3. Shape-based fallback: builds outcome from `debatePlan.outputShape.sections` (empty list/text per section type) with first ≥20-char line as `summary`.
4. Returns `null` only if both JSON parse and shape fallback fail.

### H — EE Judge

`judgeCouncilOutcome(synthesisText)` in `src/ee/judge.ts`.

Returns `{ confidence: number (0-1), reason: string }`.

If `confidence < 0.5`:
- `[NEEDS HUMAN REVIEW] Council synthesis confidence: NN%. Reason: ...` appended as system message.

### I — EE Record

`recordCouncilOutcome(topic, synthesisText, verdict, { sessionId, durationMs })` in `src/ee/phase-outcome.ts`.

Fire-and-forget POST to EE brain. Never blocks the response. Errors silently swallowed.

### J — Persisted Council Memory

After synthesis, `runCouncil` calls `appendSystemMessage(sessionId, '[Council Memory] ' + JSON.stringify(record))`.

Record shape:
```typescript
{
  topic: string;
  spec: ClarifiedSpec;
  debatePlan: DebatePlan;
  participants: Array<{ role: string; model: string; stance?: DebateStance }>;
  finalPositions: Array<{ role: string; position: string }>;  // truncated 1000 chars
  synthesis: string;  // truncated 2000 chars
  stats: { calls: number; durationMs: number; phases: Array<{ name: string; durationMs: number }> };
  timestamp: string;  // ISO 8601
}
```

Additional system messages per run:
- `[Council Decision]` — human-readable summary
- `[Council Outcome]` — full JSON outcome
- `[Council Round N]` — per-round exchange text (including tool names)
- `[Council Tool Trace]` — per-tool-call forensic entries (2KB truncation)

## Inspect Past Debates

```
/council inspect <session-id>
```

Loads all council-related system messages for the session and renders:
- Topic, timestamp, API call count, total duration
- Participants with assigned stances
- Final positions per participant
- Per-round leader evaluations (criteria met count, reason, evidenceDensity)
- Tool call traces
- Citations extracted from synthesis

Session IDs are shown in `/sessions` and in the session header on resume.

## Doctor Checks

`muonroi doctor` includes a `council.mcp` check (CQ-23):

Warns when:
- Neither `tavily` nor `playwright` is enabled in `mcpServers` config, AND
- ≥3 recent council sessions had topics containing URLs or research keywords.

Fix: add MCP server entries to `~/.muonroi-cli/user-settings.json`:
```json
{
  "mcpServers": [
    { "name": "tavily", "command": "tavily-mcp", "args": [], "env": { "TAVILY_API_KEY": "..." } },
    { "name": "playwright", "command": "playwright-mcp", "args": [] }
  ]
}
```

## Worked Example

**Topic:** "Should we switch from REST to gRPC for our internal microservices?"

**Step A — PIL context:**
- taskType: "architecture"
- domain: "backend"
- outputStyle: "balanced"
- grayAreas: ["What is current API call volume?", "Do any clients require browser access?"]

**Step B — EE pre-fetch:**
- Warning: "gRPC streams can cause memory pressure in Node.js without backpressure" (confidence: 0.82)
- → "Experience Auditor" stance auto-added: lens "Watch for operational pitfalls the team has hit before"

**Step E — Debate Plan:**
```
Stances:
  - Pragmatist: "Evaluate based on current team capability and migration cost"
  - Performance Analyst: "Measure latency/throughput impact with actual numbers"
  - Experience Auditor: "Watch for operational pitfalls the team has hit before"

Output Shape (kind: "decision"):
  - recommendation: text — the recommended approach
  - rationale: list — key decision drivers
  - risks: list — identified risks
  - migration_steps: list — if switch recommended
```

**Step F — Research findings (excerpt):**
```
## Source Code Findings
- [src/api/users.ts:12] REST handlers using express-validator for input
- [src/services/gateway.ts:88] API gateway currently HTTP/1.1 only [file:88]

## Internet Findings
- [https://grpc.io/docs/languages/node/] Node.js gRPC supports streaming
- [https://buf.build/blog/connect-for-node] ConnectRPC for browser-compatible gRPC [url]

## Frontend Findings (live)
(no findings — gap noted)
```

**Step F — Round 1 exchange (excerpt):**
```
[Pragmatist] → [Performance Analyst]:
REST has zero migration cost and our team knows it. gRPC adds proto schema maintenance.
[REFUTED via tavily:https://news.ycombinator.com/item?id=12345 — "Proto tooling has improved significantly in 2024"]

[Performance Analyst] → [Pragmatist]:
Benchmarks show 40% lower latency for internal calls. [CONFIRMED via bash:hyperfine results]
```

**Step G — Synthesis (excerpt):**
```json
{
  "type": "decision",
  "summary": "Adopt gRPC for internal microservices with a phased migration starting from the highest-traffic service pair.",
  "recommendation": "Adopt gRPC — latency gains justify migration cost at current scale.",
  "rationale": ["40% measured latency reduction", "Strong proto tooling ecosystem in 2024"],
  "risks": ["Memory pressure with streaming (per Experience Auditor)", "Browser clients need ConnectRPC"],
  "migration_steps": ["Instrument one service pair in parallel", "Validate memory usage under load", "Roll out to remaining services"]
}
```

**Step H — EE Judge:**
```
confidence: 0.78 (evidence-grounded, convergence reached)
```

**Persisted memory includes:**
- `[Council Memory]` — full record with stats (8 API calls, 42s)
- `[Council Round 1]` — exchange text with REFUTED tags
- `[Council Tool Trace] tool=tavily_search args={"query":"gRPC Node.js performance 2024"} result=...` (×3)
- `[Council Tool Trace] tool=bash args={"command":"hyperfine..."} result=...` (×1)
