# Discovery Interview + Project Context Artifact — Design

**Date:** 2026-05-13
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
- Cost-bounded: ~$0.15 budget for 4 council debates + small leader calls, hard fallback if cap-near
- Resumable: crash mid-interview → resume from last answered question
- Single source of truth: `project-context.md` injected into all downstream prompts

## 3. Non-Goals

- Full re-discovery mid-sprint (requires explicit `/ideal revise` command, future spec)
- Replacing council debate for research phase (only used here for big-4 recommendations)
- Frontend image-based UI workflows (hard-blocked by FE policy)
- Multi-user collaborative discovery (single TUI user only)

## 4. Architecture

### 4.1 Module layout

```
src/product-loop/
├── gather.ts                   [MODIFIED — becomes thin dispatcher]
├── discovery/                  [NEW]
│   ├── detection.ts            Detect existing project signals
│   ├── schema.ts               Types: DiscoveryQuestion, DiscoveryAnswer, ProjectContext
│   ├── interview.ts            10-question script + branching logic
│   ├── prompt-parser.ts        Leader LLM call: extract pre-filled fields from idea
│   ├── recommender.ts          Leader inline (6) + council (4 big)
│   └── persistence.ts          Read/write state.md::Discovery + project-context.md
├── artifact-io.ts              [MODIFIED — add readProjectContext / writeProjectContext]
└── types.ts                    [MODIFIED — add ProjectContext, DiscoveryState]
```

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
   - detection.detectExistingProject(cwd) → ExistingProjectSignals
   - promptParser.parse(idea, leader) → PartialContext { platform?, stack?, audience?, ... }
3. gather phase (adaptive):
   - branch decision based on signals.classification + partial coverage
   - interview.run() iterates 10 questions:
     · Pre-fill from PartialContext where confidence high; ask user to confirm in summary
     · For unfilled: ask one-by-one
     · 4 big questions (BE arch, BE stack, DB, deploy) → recommender.councilRecommend
     · 6 small → recommender.leaderRecommend
     · User picks [accept | alt N | more options | skip-optional]
     · persistence.saveAnswer(state.md::Discovery)
4. After 6 required answered:
   - Render summary
   - User gate: "context đủ chưa? proceed / hỏi thêm"
   - On proceed: persistence.writeProjectContext(runDir, ProjectContext) → project-context.md
5. Continue to research phase; downstream prompts inject project-context via formatProjectContextForPrompt(ctx)
```

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

*#7 becomes required if `targetPlatform` includes `web` or mobile-web. Hard-block on image-based UI choices.

Big-4 council questions (#4, #5, #6, #10) target cumulative ~$0.15 cost.

### 5.2 `project-context.md` artifact

Section header in markdown file: `# Section: Project Context`. Body is a JSON blob using the P8 versioned-envelope pattern.

```json
{
  "version": 1,
  "generatedAt": "2026-05-13T10:00:00Z",
  "idea": "<original user prompt>",
  "detection": {
    "isGitRepo": true,
    "isExistingProject": false,
    "detectedManifests": [],
    "detectedLanguages": [],
    "detectedFrameworks": []
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
        "debateRef": "council-debate-id-xxx"
      }
    },
    "constraints": {
      "fePolicy": "headless-ui-only",
      "feEnforced": true
    }
  },
  "userOverrides": [
    { "field": "backendStack", "from": "Go+Gin", "to": "TypeScript+NestJS", "reason": "team familiarity" }
  ]
}
```

Invariants:
- `version: 1` for future migrations
- `userOverrides[]` logs every alternative pick to preserve decision trace
- `debateRef` links to council session for audit

### 5.3 `state.md::Discovery` persistence section

```json
{
  "version": 1,
  "phase": "interview",
  "classification": "greenfield" | "existing" | "ambiguous",
  "prefillSource": { "fromDetection": ["backendStack"], "fromPrompt": ["productType"] },
  "questionsAsked": ["productType", "targetPlatform", "audience"],
  "questionsAnswered": ["productType", "targetPlatform"],
  "currentQuestion": "audience",
  "answers": { "productType": "...", "targetPlatform": [...] },
  "recommendations": { ... },
  "userOverrides": [],
  "userGatePassed": false
}
```

Written atomically (`atomicWriteText`) after every answer.

## 6. Recommender engine

```typescript
interface RecommendInput {
  question: DiscoveryQuestion;
  context: PartialContext;
  priorRunsDigest?: string;          // from P5 cross-run-memory
  detection: ExistingProjectSignals;
}

interface Recommendation {
  primary: { value: any; rationale: string };
  alternatives: { value: any; rationale: string }[];   // 2 alts
  source: "leader" | "council";
  costUsd: number;
  debateRef?: string;
}

async function leaderRecommend(input: RecommendInput): Promise<Recommendation>;
async function councilRecommend(input: RecommendInput): Promise<Recommendation>;
```

Council debate config for big-4:
- `rounds: 1` (single round; full multi-round debate is overkill for these scopes)
- Stances: `pragmatist` (team skill, delivery speed, ecosystem) / `scaler` (audience scale, performance, future growth) / `cost-optimizer` (infra cost, dev hours, TCO)
- Topic prompt is question-specific, builds context from prior answers

Cost guard: cumulative recommender spend > `0.5 * PHASE_HINTS.gather * capUsd` → fallback all subsequent recommends to `leader`. Warn user inline.

## 7. Detection module

```typescript
interface ExistingProjectSignals {
  isGitRepo: boolean;
  hasCommitHistory: boolean;
  manifests: { file: string; type: ManifestType }[];
  languages: string[];
  frameworks: string[];
  classification: "greenfield" | "existing" | "ambiguous";
}
```

Classification rules:
- `greenfield`: cwd empty OR only `.git/` OR only top-level docs (README/LICENSE)
- `existing`: at least one manifest detected and src-like directory non-empty
- `ambiguous`: edge cases (e.g., `package.json` with empty deps) — user gate confirms

Manifest types covered: `package.json` (Node), `Cargo.toml` (Rust), `go.mod` (Go), `pyproject.toml` (Python), `*.csproj` (C#), `pom.xml` (Java/Maven), `build.gradle` (Java/Gradle).

## 8. Conflict resolution

When prompt-parser claim and detection result disagree:
- Detection wins for codebase facts (`languages`, `frameworks`, `isExistingProject`)
- Prompt fills gaps
- If detection contradicts prompt assertion → flag in summary, ask user to confirm intended interpretation

## 9. Error handling

| Error | Behavior |
|-------|----------|
| Leader timeout on prompt-parser | Skip parsing, ask all 10 from scratch. Log warning. |
| Leader fail on `leaderRecommend` | Ask user directly, mark `source: "user-only"` |
| Council fail on big-4 | Fallback to `leaderRecommend`. If leader fails too → user-only. |
| Detection fail (FS permission) | Treat as greenfield. Log warning. Confirm with user. |
| User picks FE option violating policy | Reject inline with clear message. Re-prompt. |
| Resume from corrupt `state.md::Discovery` | Show diff, ask restart-discovery / abort. No auto-recovery. |
| Cost cap hit mid-interview (CB-1) | Hard stop. Save partial state. User resumes after raising `--max-cost`. |
| `project-context.md` write fail | Retry once. If still fail → abort run with clear error (downstream depends on this). |

## 10. Testing strategy

```
src/product-loop/discovery/__tests__/
├── detection.test.ts          ~8 tests
├── prompt-parser.test.ts      ~6 tests, mock leader
├── interview.test.ts          ~12 tests, mock recommender
├── recommender.test.ts        ~10 tests, mock leader + council
├── persistence.test.ts        ~8 tests, tmp dir
└── integration.test.ts        ~5 tests, full discovery flow with mocks
```

Critical cases:
1. Detection variants: greenfield / existing JS / Rust / multi-lang / ambiguous / no-git / nested workspace
2. Prompt parser: empty / full / partial / contradictory prompt (detection wins)
3. Interview pre-fill density: greenfield (minimal pre-fill) / existing (heavy pre-fill from detection) / ambiguous (user gate confirms classification before pre-fill)
4. Required vs optional skip semantics
5. User gate at 6/6 required
6. Recommendation source dispatch + cost-cap fallback
7. FE policy hard-block
8. User override logging
9. Persistence write + resume from any midpoint
10. Atomic write crash safety
11. Cross-run memory injection into recommender
12. Schema version v1 read; v0/v2 fallback to user

Coverage target: ≥85% line coverage on `discovery/` module. All LLM calls mocked in unit tests. Integration test uses fake LLM stub.

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
- Multi-revision support: `userOverrides[]` only tracks single-pass discovery; revising via `/ideal revise` needs append-with-timestamp (future spec)
- Recommender quality improvement via web search / context7 lookup (subsystem D extension)

## 13. Acceptance criteria

- All 12 critical test cases pass
- ≥85% line coverage on `discovery/` module
- Existing `/ideal` greenfield runs produce non-empty `project-context.md` with all 6 required fields populated
- Existing `/ideal` on a populated repo correctly classifies as `existing` and skips redundant questions
- Cost of discovery phase ≤ 1.5× `PHASE_HINTS.gather * capUsd` (within P7 soft warning threshold)
- Resume from any question index produces identical final `project-context.md` as continuous run
