# Discovery Interview + Project Context Artifact — Design

**Date:** 2026-05-13
**Last revised:** 2026-05-13 (post-review)
**Scope:** B+C of `/ideal` agile-team roadmap (subsystems B = structured discovery interview, C = `project-context.md` artifact)
**Status:** Draft for implementation
**Supersedes:** Free-form `gather` phase in `/ideal`

---

## 1. Background

`/ideal` currently runs a free-form `gather` phase with 3–5 generic questions about "unknowns". For a 1-prompt → mature-product vision, this is insufficient: the system has no structured understanding of product type, target platform, audience scale, stack, DB strategy, BA/design status, or deployment target. Downstream phases (research, scoping, sprint, future `/execute` handoff) cannot tailor their behavior without this context.

This spec replaces the discovery side of `/ideal` with a **structured 10-question interview**, **adaptive to existing-project context**, **with per-question recommendations from leader LLM (6 small Qs) or mini-council debate (4 big Qs)**, and persists the result to a versioned `project-context.md` artifact that all downstream phases consume.

Out of scope (deferred to later specs):
- Discord channel auto-provisioning (subsystem A)
- Recommendation-quality improvements via web research (subsystem D extensions)
- `gsd-bridge` export to PLAN.md (subsystem E)
- New done-gate conditions #7–#9 (subsystem F)
- `/ideal revise` re-entry command

## 2. Goals

- Capture 10 structured product dimensions before research phase starts
- Adaptive: skip questions already answered by prompt parsing or existing-project detection
- Cost-bounded: realistic ~$0.80–$1.50 total discovery spend, cost guard prevents runaway
- Resumable: crash mid-interview → resume from last good state with no torn writes
- Single source of truth: `project-context.md` injected into all downstream prompts

## 3. Non-Goals

- Full re-discovery mid-sprint (requires explicit `/ideal revise` command, future spec)
- Replacing council debate for research phase (only used here for big-4 recommendations)
- Frontend image-based UI workflows (hard-blocked by FE policy)
- Multi-user collaborative discovery (single TUI user only)

## 4. Architecture

### 4.1 Module layout

The product-loop directory is **flat by convention** (24 sibling files, only `__tests__/` is nested). To preserve this:

```
src/product-loop/
├── gather.ts                          [MODIFIED — adaptive dispatcher]
├── discovery-detection.ts             [NEW] existing-project signals
├── discovery-schema.ts                [NEW] types: DiscoveryQuestion, ProjectContext, ...
├── discovery-interview.ts             [NEW] 10-question script + branching
├── discovery-prompt-parser.ts         [NEW] leader LLM call to extract pre-fills from idea
├── discovery-recommender.ts           [NEW] leader inline (6) + council wrapper (4 big)
├── discovery-persistence.ts           [NEW] read/write state.md::Discovery + project-context.md
├── discovery-migrations.ts            [NEW] schema migrator registry
├── artifact-io.ts                     [MODIFIED — add readProjectContext / writeProjectContext]
├── types.ts                           [MODIFIED — add ProjectContext, DiscoveryState]
└── __tests__/
    ├── discovery-detection.test.ts
    ├── discovery-prompt-parser.test.ts
    ├── discovery-interview.test.ts
    ├── discovery-recommender.test.ts
    ├── discovery-persistence.test.ts
    ├── discovery-migrations.test.ts
    └── discovery-integration.test.ts
```

Rationale: existing modules like `phase-budget.ts`, `typed-artifacts.ts`, `cross-run-memory.ts` all live flat under `product-loop/`. Subfolder would be a precedent-break with no offsetting benefit.

### 4.2 FSM placement

Existing FSM `discover → gather → research → scoping → sprint` is unchanged. `gather.ts` becomes an adaptive dispatcher that always uses the 10-question structured interview, differing only in how many answers are pre-filled before the user is prompted:

- Greenfield (detected) → structured interview, minimal pre-fill (only what prompt parser extracted)
- Existing project (detected) → structured interview, heavy pre-fill from detection: `backendStack.language`, `backendStack.framework`, `targetPlatform` (inferred from project type) auto-populated; user confirms or overrides
- Adaptive (prompt parser pre-filled fields) → structured interview with prompt-derived answers pre-filled; user confirms/edits per field

All three branches produce the same `project-context.md` schema. Existing-project branch simply has higher pre-fill density, leading to fewer interactive questions in practice.

### 4.3 Data flow

```
1. /ideal "<idea>" runs
2. discover phase:
   - detectExistingProject(cwd) → ExistingProjectSignals (weighted manifests + srcFileCount)
   - parsePromptForContext(idea, leader) → PartialContext { platform?, stack?, audience?, ... }
3. gather phase (adaptive):
   - pre-fill computed from PartialContext + detection (detection wins on conflict)
   - interview iterates 10 questions one-by-one:
     · skip if pre-filled with high confidence AND user confirms in 1-shot summary
     · 4 big (#4 BE-arch, #5 BE-stack, #6 DB, #10 deploy) → councilRecommend
     · 6 small → leaderRecommend
     · user picks [accept | alt N | more options | skip-optional]
     · saveAnswer(state.md::Discovery) via writeArtifact section update
4. After 6 required answered → render summary + user gate
5. On proceed:
   - mark state.md::Discovery `phase: "awaiting-artifact-write"`
   - derive ProjectContext from answers + recommendations
   - writeProjectContext(runDir, ctx) → project-context.md (atomic via writeArtifact)
   - mark state.md::Discovery `phase: "done"` (separate atomic write)
6. Continue to research phase; downstream prompts inject project-context via formatProjectContextForPrompt(ctx)
```

The two-write commit (artifact then state-marker) makes the artifact write idempotent on resume: if crash happens between answer-complete and artifact-write, resume sees `phase: "awaiting-artifact-write"` and re-derives + re-writes the artifact from the stored answers. If crash happens between artifact-write and state-marker, resume sees the artifact already on disk and just flips the marker.

## 5. Schemas

### 5.1 DiscoveryQuestion catalogue

| # | Field | Required | Type | Recommend mode |
|---|-------|----------|------|----------------|
| 1 | `productType` | yes | enum: saas / internal-tool / consumer-app / b2b-platform / marketplace / other | leader |
| 2 | `targetPlatform` | yes | enum[] (multi): web / mobile-ios / mobile-android / desktop-win / desktop-mac / desktop-linux / cli | leader |
| 3 | `audience` | yes | `{ persona: string, scale: enum, geography: string }` | leader |
| 4 | `backendArchitecture` | yes | enum: monolith / modular-monolith / microservices / serverless / none | **council** |
| 5 | `backendStack` | yes | `{ language, framework, runtime? }` | **council** |
| 6 | `dbStrategy` | yes | `{ mode: greenfield/existing-schema/migrate-from, engine, notes? }` | **council** |
| 7 | `frontendApproach` | optional* | `{ library: shadcn/radix/headlessui/none, framework: next/vite-react/svelte/none }` | leader |
| 8 | `baStatus` | optional | enum: complete / partial / none | leader |
| 9 | `designStatus` | optional | enum: system-exists / mockups-only / none | leader |
| 10 | `deployment` | optional | `{ target: self-host/cloud/hybrid, provider?, ciCd? }` | **council** |

*#7 becomes required if `targetPlatform` includes `web`. Hard-block on image-based UI choices — see §5.4 for exact rules.

### 5.2 `project-context.md` artifact

Section header in markdown file: `# Section: Project Context`. Body is a JSON blob with a **bespoke schema** (NOT the typed-artifacts P8 envelope — `project-context.md` is a singleton context object, not a list of items, so the `{ version, items[] }` envelope does not fit).

```json
{
  "version": 1,
  "schemaName": "project-context",
  "generatedAt": "2026-05-13T10:00:00Z",
  "idea": "<original user prompt>",
  "detection": {
    "isGitRepo": true,
    "isExistingProject": false,
    "classification": "greenfield",
    "srcFileCount": 0,
    "manifests": [],
    "languages": [],
    "frameworks": []
  },
  "context": {
    "productType": "saas",
    "targetPlatform": ["web"],
    "audience": { "persona": "...", "scale": "1k-100k", "geography": "SEA" },
    "backendArchitecture": "modular-monolith",
    "backendStack": { "language": "TypeScript", "framework": "NestJS", "runtime": "Node 22" },
    "dbStrategy": { "mode": "greenfield", "engine": "PostgreSQL 16" },
    "frontendApproach": { "library": "shadcn", "framework": "next" },
    "baStatus": "partial",
    "designStatus": "none",
    "deployment": { "target": "self-host", "provider": "VPS", "ciCd": "GitHub Actions" }
  },
  "recommendations": {
    "byField": {
      "backendArchitecture": {
        "chosen": "modular-monolith",
        "alternatives": ["microservices", "serverless"],
        "rationale": "Team size 1-3, audience 1k-100k → microservices overkill; serverless rules out long-running jobs",
        "source": "council",
        "debateRef": "council-debate-id-xxx",
        "tiebreakUsed": false
      }
    },
    "constraints": {
      "fePolicy": "headless-ui-only",
      "feEnforced": true
    }
  },
  "userOverrides": [
    {
      "seq": 1,
      "timestampUtc": "2026-05-13T10:05:32Z",
      "field": "backendStack",
      "from": "Go+Gin",
      "to": "TypeScript+NestJS",
      "reason": "team familiarity"
    }
  ]
}
```

Invariants:
- `version: 1` — readers must consult `discovery-migrations.ts` for handling other versions (see §14)
- `userOverrides[]` is append-only with monotonic `seq` and UTC `timestampUtc` — reorder detectable, history preserved
- `debateRef` links to council session for audit
- `tiebreakUsed: true` indicates synthesizer pass was needed (see §6)

### 5.3 `state.md::Discovery` persistence section

```json
{
  "version": 1,
  "phase": "interview" | "awaiting-artifact-write" | "done",
  "classification": "greenfield" | "existing" | "ambiguous",
  "prefillSource": { "fromDetection": ["backendStack"], "fromPrompt": ["productType"] },
  "questionsAsked": ["productType", "targetPlatform", "audience"],
  "questionsAnswered": ["productType", "targetPlatform"],
  "currentQuestion": "audience",
  "answers": { "productType": "...", "targetPlatform": [...] },
  "recommendations": { ... },
  "userOverrides": [],
  "userGatePassed": false,
  "cumulativeRecommenderCostUsd": 0.42
}
```

**Persistence path**: writes go through `readArtifact(runDir, "state.md")` and `writeArtifact(runDir, "state.md", map)` from `flow/artifact-io.js`, setting `sections.set("Discovery", JSON.stringify(state))`. **The discovery module never calls `atomicWriteText` directly on `state.md`** — the section-map abstraction owns the file. Atomic-write semantics are inherited from `writeArtifact`.

Write frequency: after every answered question, after user-gate pass, after artifact-write completion. Cumulative ~10–15 writes per discovery run, all sub-millisecond on typical SSD.

### 5.4 FE policy hard-block (exact rules)

The FE policy enforces "headless UI only" for `frontendApproach.library`:

- Accepted values: `shadcn`, `radix`, `headlessui`, `none`
- Rejected categorical: any image-based / pixel-derived / Figma-screenshot-driven approaches
- The user **cannot override via prompt or recommend pick**: only the four accepted values are selectable
- Hard-block scope is the `library` field only. Other fields (`baStatus`, `designStatus`) may reference Figma/mockup sources for context — that is allowed; the block targets only the UI-generation approach

This is the only field with no override path. All other recommendations are user-overridable.

## 6. Recommender engine

### 6.1 Leader-recommend API (small questions)

```typescript
interface RecommendInput {
  question: DiscoveryQuestion;
  context: PartialContext;            // accumulated answers so far
  priorRunsDigest?: string;           // from P5 cross-run-memory
  detection: ExistingProjectSignals;
}

interface Recommendation {
  primary: { value: any; rationale: string };
  alternatives: { value: any; rationale: string }[];   // up to 2 alts
  source: "leader" | "council" | "user-only";
  costUsd: number;
  debateRef?: string;
  tiebreakUsed?: boolean;
}

async function leaderRecommend(input: RecommendInput): Promise<Recommendation>;
```

Internally `leaderRecommend` resolves the leader model via `resolveLeaderModel` from `src/council/leader.ts` and calls `llm.generate(modelId, system, prompt, maxTokens)` using `createCouncilLLM` from `src/council/llm.ts`.

### 6.2 Council-recommend wrapper (big-4)

Council `runDebate` is an async generator with signature:

```typescript
function* runDebate(spec: ClarifiedSpec, config: CouncilConfig, llm: CouncilLLM): AsyncIterable<StreamChunk>
```

Stances live inside `config.debatePlan: DebatePlan` and are normally leader-proposed at plan time. For discovery big-4 we **bypass the leader-plan step and inject a hardcoded DebatePlan**:

```typescript
async function councilRecommend(input: RecommendInput): Promise<Recommendation> {
  const plan: DebatePlan = {
    stances: [
      { role: "pragmatist", lens: "team skill, delivery speed, ecosystem maturity" },
      { role: "scaler",     lens: "audience scale, performance, future growth" },
      { role: "cost-optimizer", lens: "infra cost, dev hours, total TCO" },
    ],
    plannedRounds: 1,
    kindCap: 1,
    costAware: true,
  };
  const spec = buildSpecForBig4Question(input);
  const config = buildConfigWithPlan(plan);
  const llm = createCouncilLLM();
  const chunks = [];
  for await (const c of runDebate(spec, config, llm)) chunks.push(c);
  return synthesizeRecommendationFromDebate(chunks, input);
}
```

### 6.3 Deadlock / tiebreak protocol

If the three stances pick three different `primary` values (no majority), an extra leader synthesizer call (~$0.01–0.02) resolves the deadlock:

- Input: the three stance positions + their rationales
- Output: chosen primary + the two other positions reframed as alternatives
- `tiebreakUsed: true` set on the resulting `Recommendation`

If stances agree on a primary (2 of 3 or 3 of 3): no synthesizer needed, top vote wins, third position becomes the second alternative.

### 6.4 Realistic cost budget

Per the cost-feasibility review:

- Council debate (1 round, 3 stances, with eval + possible synth): **$0.18–$0.35 each**
- 4 big-4 debates: **$0.72–$1.40**
- 6 leader-only recommends: **$0.03–$0.12**
- Prompt-parser leader call: **$0.01–$0.02**
- **Total discovery realistic: $0.80–$1.55**

This is significantly above the original $0.15 target. The acceptance criteria in §13 are revised accordingly.

### 6.5 Cost guard

The guard prevents runaway when cap is low or unexpected debate cost overruns hit:

```typescript
const COUNCIL_HARD_FLOOR_USD = 1.50;   // absolute minimum reserved for big-4 even at low caps
const guard = Math.max(COUNCIL_HARD_FLOOR_USD, 0.15 * capUsd);

// Before each council debate:
const estimatedNextCost = 0.35;  // pessimistic per-debate
if (cumulativeRecommenderSpent + estimatedNextCost > guard) {
  // fallback this question and all subsequent to leaderRecommend
}
```

At `capUsd = $50` → guard $7.50 (room for ~20 leader calls plus all 4 debates).
At `capUsd = $20` → guard $3.00 (room for all 4 debates).
At `capUsd = $10` → guard $1.50 (room for ~4 debates if cheap, fallback path absorbs overruns).

If cumulative spend approaches the absolute CB-1 cost cap during interview, CB-1 hard-stops the run (existing behavior, unchanged).

## 7. Detection module

### 7.1 Signals

```typescript
interface ManifestDetection {
  file: string;                  // absolute path
  type: ManifestType;
  weight: number;                // 0.0–1.0; deps count + non-empty src nearby raises it
  inferredLang: string;
  inferredFrameworks: string[];
}

interface ExistingProjectSignals {
  isGitRepo: boolean;
  hasCommitHistory: boolean;
  srcFileCount: number;          // non-doc, non-config source files anywhere in cwd
  manifests: ManifestDetection[]; // ALL manifests, weighted (not just first)
  languages: string[];           // derived from weighted manifest aggregate
  frameworks: string[];
  classification: "greenfield" | "existing" | "ambiguous";
}
```

### 7.2 Classification rules

- `greenfield`: `srcFileCount === 0` AND (cwd empty OR only `.git/` OR only top-level docs)
- `existing`: `srcFileCount > 5` AND at least one manifest with `weight > 0.5`
- `ambiguous`: every other case — including:
  - manifest present but `srcFileCount <= 5` (scaffolded `create-next-app`, untouched template)
  - `srcFileCount > 5` but no manifest (vendored sources without root manifest, monorepo subdir)
  - manifest with empty deps
  - multiple manifests competing (polyglot — return all weighted, ambiguous classification, user picks primary)
  - vendored `node_modules/` detected but no root `package.json`

Ambiguous classification routes to the user gate: a one-shot confirmation step before pre-fill computation, asking "I detected X, Y, Z — which best describes this project?"

### 7.3 Manifest types covered

`package.json` (Node), `Cargo.toml` (Rust), `go.mod` (Go), `pyproject.toml` (Python), `*.csproj` (C#), `pom.xml` (Java/Maven), `build.gradle` (Java/Gradle).

For nested git workspaces: detection picks the innermost `.git` boundary, not the parent monorepo — the user invoked `/ideal` in a specific dir intentionally.

## 8. Conflict resolution

When prompt-parser claim and detection result disagree:

- Detection wins for codebase facts (`languages`, `frameworks`, `isExistingProject`)
- Prompt fills only the gaps detection cannot derive (audience, productType, deployment intent)
- If detection contradicts a prompt assertion (e.g., prompt says "Python" but cwd is JS project) → flag in summary, ask user to confirm intended interpretation; log the conflict resolution in `userOverrides[]` with `field: "<detected-field>"` and `reason: "detection-vs-prompt-conflict"`

## 9. Error handling

| Error | Behavior |
|-------|----------|
| Leader timeout on prompt-parser | Skip parsing, all 10 questions ask from scratch. Log warning. |
| Leader returns malformed JSON for recommender | Retry once with strict JSON instruction. If still bad → fallback to user-only for that question. |
| Leader fail on `leaderRecommend` after retry | Ask user directly, mark `source: "user-only"` |
| Council fail on big-4 | Fallback to `leaderRecommend`. If leader fails too → user-only. All three paths tested. |
| Council deadlock (3 different stances, synth call fails) | Use stance position with highest confidence score as primary; mark `tiebreakUsed: true` with `synthFailed: true` |
| Detection fail (FS permission) | Treat as greenfield. Log warning. Confirm with user. |
| User picks FE option violating policy | Reject inline. Re-prompt with only accepted values. |
| Resume from corrupt `state.md::Discovery` | Show diff with backup, ask restart-discovery / abort. No silent auto-recovery. |
| Resume finds `phase: "awaiting-artifact-write"` | Re-derive ProjectContext from answers, write artifact, flip state to `done`. Idempotent. |
| Cost cap (CB-1) hit mid-interview | Hard stop. Save partial state. User resumes after raising `--max-cost`. |
| `project-context.md` write fail | Retry once. If still fail → leave state in `awaiting-artifact-write`, abort run with explicit "rerun /ideal resume to retry artifact write" message. |
| Concurrent `/ideal` run on same flowDir | Second run detects existing run via lockfile-style check on `runs/<runId>/state.md` mtime; fail fast with clear message. |
| LLM returns extra/unknown ProjectContext fields | Schema validator strips unknown, does not throw. Warn in logs. |

## 10. Testing strategy

### 10.1 Layout

```
src/product-loop/__tests__/
├── discovery-detection.test.ts          ~12 tests
├── discovery-prompt-parser.test.ts      ~8 tests (mock leader)
├── discovery-interview.test.ts          ~14 tests (mock recommender)
├── discovery-recommender.test.ts        ~14 tests (mock leader + council)
├── discovery-persistence.test.ts        ~12 tests (tmp dir + crash sim)
├── discovery-migrations.test.ts         ~6 tests
└── discovery-integration.test.ts        ~8 tests (full flow with mocks)
```

Flat layout matches the project's 26-sibling-test convention.

### 10.2 Critical test cases (consolidated from spec + reviewer additions)

Detection (12):
1. Greenfield: empty cwd
2. Greenfield: only `.git/` + README
3. Existing JS: `package.json` + 50 src files → `existing`
4. Existing Rust: `Cargo.toml` + src
5. Multi-lang: polyglot returns all weighted manifests → `ambiguous`
6. No-git: srcFiles present, no `.git` → still classifies on manifest
7. Nested workspace: picks innermost `.git`
8. Empty `package.json` (no deps) → `ambiguous`
9. Scaffolded `create-next-app` untouched (`srcFileCount <= 5`) → `ambiguous`
10. Vendored `node_modules/` without root manifest → `ambiguous`
11. FS permission denied on cwd subdir → treat as greenfield, log warning
12. Manifest detected but unreadable → manifest weight 0, skip

Prompt parser (8):
13. Empty prompt → all 10 questions ask
14. Full prompt covering all 10 → pre-fill all, user confirms 1-shot
15. Partial prompt covering 3 fields → 3 pre-filled, 7 ask
16. Contradictory prompt vs detection → detection wins, conflict logged
17. Prompt with image-based FE → FE policy auto-reject, ask user
18. Prompt parser timeout → fallback ask all
19. Prompt parser returns malformed JSON → retry once → fallback
20. Prompt parser returns extra fields → strip, warn

Interview (14):
21. Pre-fill density: greenfield minimal / existing heavy / ambiguous via user gate
22. Required vs optional skip — skip optional with `[skip]` works
23. Skip required → rejected
24. User gate at 6/6 required → summary rendered + accept proceeds
25. User gate reject → re-enter question loop
26. Recommendation source dispatch: 6 small → leader / 4 big → council
27. Cost-cap fallback: council → leader after guard trips
28. FE policy hard-block: shadcn accepted / image-based rejected / `none` for non-FE platform accepted
29. User override → logged in `userOverrides[]` with seq + timestamp, monotonic
30. Last-write-wins on quick change-mind within same question
31. Interview crash mid-question → resume from last good question, no torn write
32. Resume after user-gate pass before artifact-write → re-derive + write artifact, flip state to done
33. Resume after artifact-write before state-marker flip → detect artifact present, just flip
34. Concurrent run on same flowDir → second fails fast

Recommender (14):
35. Leader-only happy path
36. Council happy path (stances agree)
37. Council deadlock: 3 different stances → synth resolves, `tiebreakUsed: true`
38. Council deadlock: synth call fails → highest-confidence wins, `synthFailed: true`
39. Council fail → fallback to leader (chain link 1)
40. Leader also fails → fallback to user-only (chain link 2, full chain tested)
41. Cost-guard trips → all subsequent council swaps to leader
42. Realistic cost-per-debate within $0.18–$0.35 (mocked tokens)
43. Cross-run memory injection — prior context truncated to budget, not silently dropped
44. Recommender returns malformed JSON → retry once → user-only
45. Council debate ID propagated to `debateRef`
46. Prior project context cite appears in rationale when relevant
47. Leader-only recommend produces 1 primary + up to 2 alternatives
48. Detection conflict — detection-wins logged in `userOverrides[]` with `reason: "detection-vs-prompt-conflict"`

Persistence (12):
49. Write after each answer → readable, correct seq
50. Resume from any midpoint produces identical final artifact byte-for-byte
51. Corrupted `state.md::Discovery` (invalid JSON) → user gate offers restart / abort
52. Truncated mid-write `state.md` → next resume reads previous valid state (atomic-write contract)
53. Concurrent write contention → either old or new state, never partial
54. Artifact write fail → state stays at `awaiting-artifact-write`, abort with clear retry message
55. Schema v0 read (no version field) → migration to v1 attempted; if fail, ask user
56. Schema v2 (future) read → "unknown version" path, ask user (no silent corruption)
57. Round-trip write+read identical
58. Cumulative cost tracked across resumes
59. Concurrent `/ideal` on same flowDir → second fails fast via lockfile check
60. Persistence module 100% coverage gate

Migrations (6):
61. Registry shape: `migrators: Record<number, (prev) => next>`
62. v0→v1 migrator applies for legacy files (no version field assumed v0)
63. v1→v1 is no-op
64. v2+ unknown → return null, caller asks user
65. Migrator throws → fallback to ask user, log error
66. Migrator chain (when v3 added in future) — verified by stub migrator

Integration (8):
67. End-to-end greenfield happy path
68. End-to-end existing JS project
69. End-to-end with prompt parser pre-fill
70. End-to-end with cost-guard trip mid-interview
71. End-to-end with council deadlock + synth resolve
72. End-to-end with user override on big-4
73. End-to-end with detection-prompt conflict
74. End-to-end with resume from crash at every checkpoint

Coverage targets:
- ≥92% line coverage on discovery-* modules
- 100% line coverage on `discovery-persistence.ts` and `discovery-migrations.ts` (atomic IO + schema correctness are non-negotiable)
- ≥85% branch coverage overall

All LLM calls mocked in unit tests. Integration test uses fake LLM stub returning canned responses with adjustable failure modes.

No e2e/TUI tests in this spec — manual TUI validation deferred.

## 11. Downstream integration

`formatProjectContextForPrompt(context)` produces a deterministic string injected into:
- Research phase: council debate topic prefix
- Sprint phase: task generation prompt
- Done-gate cond #2 (`evidence_regex`): regex tailored to chosen stack (e.g., `*.ts` for TS, `*.go` for Go)
- Future `/gsd execute` handoff (subsystem E spec)
- Future done-gate conds #7 (`discovery_complete`) and #8 (`context_artifact_present`) (subsystem F spec)

## 12. Open questions / future work

- Discovery interview localization (English-only for now; multilingual deferred)
- Per-team customization of council stances (currently hardcoded; config option deferred)
- Multi-revision support: `/ideal revise` re-entry (future spec)
- Recommender quality improvement via web search / context7 lookup (subsystem D extension)
- Privacy allowlist for cross-run memory: which fields may leak from prior project context (audience.persona could be client-sensitive — currently injected wholesale; future allowlist deferred)

## 13. Acceptance criteria

- All 74 critical test cases pass (vs original 12)
- ≥92% line coverage on discovery-* modules; 100% on `discovery-persistence.ts` + `discovery-migrations.ts`
- Existing `/ideal` greenfield run produces non-empty `project-context.md` with all 6 required fields populated
- Existing `/ideal` on a populated repo correctly classifies as `existing` and pre-fills detected fields
- Discovery phase realistic cost in range $0.80–$1.55; cost-guard prevents exceeding `max(0.15 * capUsd, $1.50)`
- Resume from any question index OR from `awaiting-artifact-write` state produces identical final `project-context.md` as continuous run
- FE policy hard-block: image-based UI choices never reachable via any code path
- Council deadlock cases always produce a primary recommendation (synth pass or confidence-fallback)

## 14. Schema migration registry

`discovery-migrations.ts` exports a registry:

```typescript
export interface MigrationContext { /* fields available to migrators */ }
export type Migrator = (prev: any, ctx: MigrationContext) => any;
export const migrators: Record<number, Migrator> = {
  // 0 → 1: legacy files without version field
  0: (prev) => ({ ...prev, version: 1, schemaName: "project-context" }),
  // future: 1 → 2 added here when needed
};

export function readProjectContextWithMigration(raw: string): ProjectContext | null;
```

Read path:
1. Parse raw JSON; if no `version` field, treat as v0
2. While `current.version < CURRENT_VERSION`: apply `migrators[current.version]` to advance
3. If no migrator chains to `CURRENT_VERSION`: return null; caller surfaces user gate to ask "incompatible artifact, restart discovery?"

Forward-compat policy: readers do not silently drop unknown fields they cannot interpret — they preserve them through the migration chain so downstream tools can still see them. v0→v1 demo migrator and v1→v1 no-op are both shipped with this spec to prove the chain works.
