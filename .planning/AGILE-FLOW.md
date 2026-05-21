# AGILE-FLOW Design Doc — `/ideal` end-to-end as a real Agile team

> Status: **Draft** · Author: Phase 5–8 planning (post P1/P2/P4) · Last updated: 2026-05-21
>
> **Purpose**: lock the shape of R1–R4 (user's expanded vision) before we write
> code for P5/P6/P7/P8. Refactoring backlog+sprint+reporter once you've shipped
> them is expensive — this doc forces those decisions upfront so each phase
> ships a piece that doesn't need to be reshaped later.

---

## Recap: requirements from user

| Req | Quote | Maps to |
|---|---|---|
| R1 | *"khi gõ ideal kèm input phải hỏi user tới khi hiểu cần làm gì"* | P5 — clarify ready-gate loop |
| R2 | *"đảm bảo mọi thứ đều được lưu và kế thừa tránh hỏi xong rồi debate nội dung khác"* | P6 — backlog as source of truth |
| R3 | *"define bao nhiêu backlog, bao nhiêu sprint, rã backlog, gán sprint 1, active sprint 1, done bao nhiêu %, báo cáo user"* | P7 — Agile mgmt + dashboard |
| R4 | *"người nói chuyện với user ở discord nên là 1 agent nằm ngoài để quan sát được toàn bộ quá trình"* | P8 — reporter agent |

---

## Model & provider discipline (hard rule)

**No code path in P5/P6/P7/P8 may hardcode a model id, provider name, or tier label.**
Every LLM call site MUST go through `pickCouncilTaskModel(taskTag, leaderModelId, costAware)`
(see `src/council/task-model.ts`) which:

1. Reads enabled providers + models from `~/.muonroi-cli/user-settings.json`.
2. Filters by the catalog's `taskTag` capability (e.g. only models that
   declare `tasks: ["effort_estimate"]` participate in #2 above).
3. Picks the cheapest eligible option, falling back to `leaderModelId` if
   none match.
4. Returns a model id string the orchestrator can pass to providers.

If a new task tag is needed (e.g. `readiness_judge`, `effort_estimate`,
`reporter_qa`), add it to the catalog FIRST, then reference by tag — never
by model id. This means user-settings toggles are the single switchboard:
disable a provider → it stops appearing in any phase.

Forbidden patterns (will be caught in code review):
```ts
const judge = "claude-haiku-4-5-20251001";                  // ❌ hardcoded model
const provider = "anthropic";                                // ❌ hardcoded provider
if (modelId.startsWith("deepseek-")) ...                     // ❌ provider sniffing
```

Required patterns:
```ts
const judge = pickCouncilTaskModel("readiness_judge", leaderModelId, true);  // ✅
const caps = getProviderCapabilities(detectProviderForModel(modelId));        // ✅
```

## Existing infrastructure we leverage

Found while scoping (no new build needed for these):

- `src/chat/types.ts` — `ChatClient` interface with `getChannelMessages` + `postMessage` + `PollCursor`. Discord polling already supported.
- `src/chat/providers/discord/client.ts` — `DiscordChatProvider` implements `ChatClient`.
- `src/chat/channel-manager.ts` — per-product channel mapping via `discord-channels.json`.
- `src/chat/verdict-resolver.ts` — `discordAwaitVerdict()` already polls Discord for user replies (used for verdict cards).
- `src/product-loop/stakeholder-acl.ts` — ACL store for who can answer per product.
- `src/types/index.ts:CouncilPhaseEvent` (Phase 4) — already includes `startedAt` + state lifecycle, the event shape reporter will consume.
- `src/storage/ui-interaction-log.ts` — every askcard / sprint_stage / sprint_halt is already persisted to `interaction_logs` table. Reporter can read this table to reconstruct state for any prompt.

**Implication**: P8 is *smaller* than originally feared. The reporter doesn't need to invent a transport — it polls the same `discord-channels.json` mapping + reads `interaction_logs` from the muonroi-cli SQLite DB.

---

## Cross-phase data model (locked)

These shapes are the contract. P5–P8 read/write them; nothing else should add ad-hoc state.

### `ClarifiedSpec` (P5 output, P6 input)

Already exists in `src/council/types.ts` but extended for P5:

```ts
interface ClarifiedSpec {
  problemStatement: string;         // 1-3 sentence canonical statement
  constraints: string[];
  successCriteria: string[];
  scope: string;
  // P5 additions
  confidenceScore: number;          // 0-1, self-judged by agent
  remainingGaps: string[];          // empty array when ready=true
  ready: boolean;                   // ready === remainingGaps.length === 0
  clarifyHistory: Array<{
    question: string;
    answer: string;
    ts: string;                     // ISO
  }>;
  // P6 link
  backlogId?: string;               // populated when P6 generates the backlog
}
```

### `Backlog` + `BacklogItem` (P6 — new)

```ts
interface BacklogItem {
  id: string;                       // ULID, stable across runs
  title: string;                    // 1-line summary
  description: string;              // 1-3 sentences
  acceptance_criteria: string[];    // Gherkin or assertions (from Phase 1 debate output)
  entities: Array<{ name: string; fields: string; relationships?: string }>;
  endpoints: Array<{ method: string; path: string; request_body?: string; response_body?: string; auth_required: boolean }>;
  mvp_priority: "v1" | "v2" | "later";  // from Phase 1 mvp_definition
  deferral_reason?: string;         // when not v1
  status: "backlog" | "in_sprint" | "in_progress" | "done" | "blocked";
  assigned_sprint?: string;         // Sprint.id, when in_sprint
  blockers?: string[];              // other BacklogItem.id refs
  effortPoints: 1 | 3 | 5;          // S/M/L estimate from router (task=effort_estimate). P6 fills.
  createdAtUtc: string;
  updatedAtUtc: string;
}

interface Backlog {
  runId: string;
  productSlug: string;              // matches discord-channels.json key
  items: BacklogItem[];
  derivedFromClarifyId: string;     // ClarifiedSpec hash
  createdAtUtc: string;
}
```

Storage: `.planning/runs/<runId>/backlog.json`. Atomic write via temp-rename.

### `Sprint` (P7 — new)

```ts
interface Sprint {
  id: string;                       // e.g. "sprint-1"
  number: number;                   // 1, 2, 3
  goal: string;                     // 1-line — what this sprint delivers
  itemIds: string[];                // BacklogItem.id refs
  status: "planned" | "active" | "done" | "abandoned";
  startedAtUtc?: string;
  endedAtUtc?: string;
  // Computed live, not stored:
  //   percentDone = sum(items.acceptance_criteria.met) / sum(items.acceptance_criteria.total)
  //   blockerCount = items.filter(i => i.status === "blocked").length
}

interface SprintPlan {
  runId: string;
  sprints: Sprint[];
  activeSprintId?: string;          // null until first sprint starts
  createdAtUtc: string;
}
```

Storage: `.planning/runs/<runId>/sprint-plan.json`.

### `ProgressSnapshot` (P7 → P8 — read-only projection)

This is what `/status` slash command renders AND what the reporter agent serves to Discord queries. Computed on demand from Backlog + SprintPlan + interaction_logs:

```ts
interface ProgressSnapshot {
  runId: string;
  productSlug: string;
  capturedAtUtc: string;
  // Clarify
  clarifyReady: boolean;
  clarifyGaps: string[];
  // Backlog
  backlogTotal: number;
  backlogV1Count: number;
  backlogDeferredCount: number;
  // Sprint
  sprintTotal: number;
  activeSprintNumber: number | null;
  activeSprintGoal: string | null;
  activeSprintPercentDone: number;       // 0-100
  activeSprintItems: Array<{
    id: string;
    title: string;
    status: BacklogItem["status"];
    criteriaMet: number;
    criteriaTotal: number;
  }>;
  blockers: Array<{ itemId: string; title: string; reason: string }>;
  // Worker liveness
  workerLastEventUtc: string;
  workerCurrentStage: string | null;     // "Sprint 1 — Planning" etc, from latest sprint_stage chunk
}
```

Always computable — no event sequencing race. Reporter can return this for any Discord query.

---

## Phase boundaries (locked)

### P5 — Clarify ready-gate loop

**Goal**: replace fixed 8-askcard sequence with an adaptive loop that ends when agent self-judges ready.

**Files**:
- `src/council/clarifier.ts` — add `judgeReadiness(spec)` call after each user answer
- `src/council/prompts.ts` — new `buildReadinessJudgePrompt(spec)`
- `src/product-loop/discovery-interview.ts` — wrap the question loop to check readiness between asks

**Algorithm**:
```
spec = initialClarifiedSpec(prompt)
ask = [...REQUIRED_QUESTION_IDS]
while ask.length > 0 AND clarifyRounds < MAX_CLARIFY_ROUNDS (default 12):
    question = ask.shift()
    answer = askUser(question)
    spec = persistAnswer(spec, question, answer)
    verdict = await judgeReadiness(spec)   // LLM call, cheap (Haiku tier)
    spec.confidenceScore = verdict.confidence
    spec.remainingGaps = verdict.gaps
    if verdict.ready:
        break
    // re-queue any gap that wasn't already in ask
    for gap in verdict.gaps:
        if gap.questionId not in answered AND gap.questionId not in ask:
            ask.push(gap.questionId)
spec.ready = (spec.remainingGaps.length === 0)
return spec
```

**Done criteria**:
- Unit test: feeding "todo app" → at least 3 gap-driven questions asked beyond REQUIRED.
- Unit test: feeding detailed prompt → 0-1 follow-up questions.
- Integration test: `judgeReadiness` uses router (`pickCouncilTaskModel("readiness_judge", leaderModelId, costAware=true)`) — never a literal model name; max 12 rounds total.

### P6 — Backlog persistence

**Goal**: clarify → Backlog conversion; debate inputs reference backlog IDs.

**Files**:
- `src/product-loop/backlog-store.ts` — new. Read/write `backlog.json` atomically.
- `src/product-loop/backlog-builder.ts` — new. Given a `ClarifiedSpec` + debate `implementation_plan` artifact (entities/endpoints/mvp_definition from Phase 1), produce `BacklogItem[]`.
- `src/product-loop/sprint-runner.ts` — when emitting council topic, prepend `## Active Backlog Item\n<JSON>` so debate stays anchored.

**Done criteria**:
- Unit test: a `ClarifiedSpec` + sample `implementation_plan` → backlog with ≥ 1 v1 item and matching acceptance_criteria.
- Smoke test: re-running `/ideal --resume <runId>` reads the persisted backlog instead of re-clarifying.
- Drift guard: sprint-runner test asserts council topic contains literal substring `Active Backlog Item:`.

### P7 — Agile sprint mgmt + `/status`

**Goal**: backlog → sprint plan → active sprint → % done → user-visible report.

**Files**:
- `src/product-loop/sprint-planner.ts` — new. Given backlog, propose `SprintPlan` (auto: group v1 items into N sprints by dependency + size estimate).
- `src/product-loop/progress-snapshot.ts` — new. Pure function: (backlog, sprintPlan, recentInteractionLogs) → `ProgressSnapshot`.
- `src/ui/slash/status.ts` — new slash command `/status` → renders snapshot as markdown card.
- `src/ui/app.tsx` — bind `/status` command. Auto-emit snapshot every sprint boundary (so user sees rolling progress without typing).

**Done criteria**:
- Unit test: sprint-planner — backlog of 10 v1 items + average size → 2-3 sprints.
- Unit test: progress-snapshot — synthetic backlog + criteria status counts → correct percentDone.
- Smoke: `/status` after Sprint 1 done shows `activeSprintNumber: 2` with `percentDone: 0`.

### P8 — Observer/Reporter agent

**Goal**: separate process that polls Discord + serves snapshot queries; worker continues uninterrupted.

**Architecture**:
```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ Worker process    │ writes  │  SQLite DB +     │ reads   │ Reporter process  │
│ (muonroi-cli      │────────▶│  backlog.json +  │◀────────│  (muonroi-cli     │
│ /ideal flow)      │ events  │  sprint-plan.json│         │  reporter mode)   │
└──────────────────┘         └──────────────────┘         └──────────┬───────┘
                                                                      │ poll +
                                                                      │ postMessage
                                                                      ▼
                                                              ┌──────────────┐
                                                              │ Discord API  │
                                                              └──────────────┘
```

- Worker writes are already in place (interaction_logs, backlog.json after P6, sprint-plan.json after P7).
- Reporter is a new entry point: `muonroi reporter --run <runId>` — runs forever, polls Discord every 5s, polls the data dir every 2s, responds to user queries with a `ProgressSnapshot` rendered via templates.
- Reporter does NOT call any LLM by default (uses templates) — keeps cost zero and latency sub-second. Only escalate to LLM for free-form user questions ("explain the architecture decision in sprint 1"), with a per-channel quota.
- Stakeholder ACL (`stakeholder-acl.ts`) already gates who can ask.

**Files**:
- `src/reporter/index.ts` — new entry point + main loop
- `src/reporter/templates.ts` — `Snapshot → discord-markdown` templates (compact)
- `src/reporter/query-router.ts` — parse user question → "show progress" / "show sprint N" / "show item X" / "free-form"
- `src/cli/reporter-cmd.ts` — `muonroi reporter` subcommand wire-up

**Done criteria**:
- Manual: launch worker on /ideal in one terminal, reporter in another. Worker takes ~5 min on debate. While worker is debating, type "progress?" in the product's Discord channel → reporter replies within 5s with current ProgressSnapshot.
- Unit test: query-router classifies 10 sample questions correctly.
- Integration test: write a synthetic backlog + sprint plan, spin up reporter for 2 ticks, assert it postMessage'd the expected snapshot once.

---

## Decisions locked (answered 2026-05-21)

1. **MAX_CLARIFY_ROUNDS = 12** — clarify loop hard-caps at 12 rounds; ready-gate
   can short-circuit earlier when judge=ready.
2. **Sprint sizing = LLM effort estimation** — each BacklogItem gets an
   `effortPoints: 1 (S) | 3 (M) | 5 (L)` field assigned via an LLM call during
   backlog build. Sprint-planner packs items so `sum(effortPoints) ≈ 8` per
   sprint. Cost guard: cap at $0.10 for the entire effort-estimation batch.
   **Model selection**: router-driven via `pickCouncilTaskModel("effort_estimate", leaderModelId, costAware)`
   — never hardcode a model name or provider in code. User toggles which
   providers/models are eligible via `~/.muonroi-cli/user-settings.json`;
   router picks cheapest enabled option per task tier.
3. **Reporter LLM = full free-form** — reporter may call LLM for any user
   question with no per-question quota. Cost discipline lives in:
     - `reporter.conf` `daily_llm_budget_usd` (default $0.50/run/day)
     - Hard halt when budget exceeded → switch back to templates with note
       "LLM budget exhausted for today; resumes UTC midnight"
   **Model selection**: router-driven via `pickCouncilTaskModel("reporter_qa", leaderModelId, costAware=true)`
   — same constraint as #2, no hardcoded model/provider. Reporter respects
   user-settings provider toggles; if user disabled all providers, reporter
   degrades to template-only with a visible "(LLM disabled)" note in replies.
4. **Non-stakeholder behavior = informative reply** — reporter replies:
   *"Not authorized. Current stakeholders: @user1, @user2. Contact them to be
   added via `/ideal stakeholder add` from the worker."* Trade-off accepted:
   leaks stakeholder usernames; non-stakeholder spam is gated by Discord's
   own per-user rate limit (5 messages/5s).

These are baseline. Tweakable via config later but no longer block P5.

---

## Out of scope for P5–P8

Explicitly NOT in this design:
- Multi-product orchestration in 1 reporter (1 reporter per run for v1).
- Sprint retrospective LLM analysis (the council already does "judgment"; P7 surfaces it, doesn't add new analysis).
- Reporter as a long-running service (v1 = manual launch per run; daemonization later).
- Email/Slack reporters (Discord only for v1 — `ChatClient` abstraction means P8 can extend to others later without re-architecture).
