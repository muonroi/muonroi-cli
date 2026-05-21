# MAINTAIN-MODE Design Doc — Mode C (Existing product → Surgical PR)

> Status: **Draft** · Last updated: 2026-05-21
>
> **Purpose**: lock the shape of `/ideal` Mode C (existing project — bug fix /
> small feature) before building P14/P15/P16. Mode C ≠ Mode A (greenfield):
> single-task, regression-safe, PR-output. Reusing Mode A sprint-runner
> wholesale would over-engineer 1-line bug fixes into multi-sprint debates.

---

## Recap: 3 modes of /ideal (from user 2026-05-21)

| Mode | Input | Output | Existing support |
|---|---|---|---|
| A — Raw idea → Project | 1-line prompt | Greenfield repo + first sprint | P1-P8 done |
| B — BA/design → Product | Spec docs / Figma | Production product | None (Phase 12+) |
| **C — Existing → Maintain** | **Bug/feature request + codebase** | **Single PR** | **THIS DOC** |

Each new project (Mode A + B) MUST lock into Muonroi ecosystem (Phase 10).

---

## Mode C invariants

1. **One task = one sprint = one PR**. No multi-sprint planning. No P7 sprint-planner involvement.
2. **Codebase reading dominates**. The agent must understand existing patterns BEFORE writing code. Mode A scaffolds; Mode C edits.
3. **Regression-safe**. Verify recipe MUST run the existing test suite. Failed test = blocked, not retry.
4. **Output = git diff + PR body**, not file dump. Optional `gh pr create`.
5. **No init-new path**. CB-3 halt path is wrong here — Mode C ASSUMES recipe exists; if not, fail early with a clear "not a configured project" error.
6. **Smaller LLM footprint**. No 4-role council debate for a CSS tweak. Solo "code agent" with a "review agent" check at the end.

---

## Trigger mechanism (locked)

- **Default**: `/ideal "fix login bug"` from a directory containing a verify recipe (detected via existing `detectVerifyRecipe`) → automatically enters Mode C.
- **Explicit override**: `/ideal --maintain "..."` forces Mode C even if cwd looks greenfield.
- **Reverse override**: `/ideal --new "..."` forces Mode A even if cwd has a recipe (rare — when user wants to scaffold INSIDE an existing repo, e.g. add a new microservice).
- **Auto-detection rule** (in `src/product-loop/index.ts` mode router):
  1. If `--maintain` flag → Mode C.
  2. If `--new` flag → Mode A.
  3. If cwd has `package.json` / `*.sln` / `pyproject.toml` / `Cargo.toml` AND `detectVerifyRecipe(cwd) !== null` → Mode C.
  4. Else → Mode A (current behavior).

This eliminates "user starts /ideal in existing project and accidentally gets scaffold" — the regression that wastes time.

---

## Data model

Mode C does NOT reuse `Backlog`/`Sprint`/`SprintPlan` from P6/P7. Use leaner types:

```ts
export type MaintenanceTaskKind = "bug" | "feature" | "refactor" | "chore" | "docs";

export interface MaintenanceTask {
  id: string;                              // ULID
  kind: MaintenanceTaskKind;
  title: string;                           // 1-line summary
  description: string;                     // user's verbatim prompt + parsed details
  reproSteps?: string;                     // for bugs — how to repro
  expectedBehavior?: string;
  observedBehavior?: string;
  acceptance_criteria: string[];           // 1-3 assertions
  candidateFiles: string[];                // from P14 codebase-intel
  impactRadius: string[];                  // files that import/reference candidateFiles
  regressionTestFiles: string[];           // existing test files in the impact area
  status: "queued" | "in_progress" | "blocked" | "done" | "abandoned";
  pr?: {
    branch: string;
    diff: string;                          // unified diff
    title: string;
    body: string;
    createdViaGh?: boolean;                // true when gh pr create was used
    url?: string;                          // when gh pr create returned a URL
  };
  createdAtUtc: string;
  updatedAtUtc: string;
}
```

Storage: `.planning/runs/<runId>/maintenance-task.json`. One run = one task (no array; Mode C is 1-task-per-run).

Reuse path: Mode A's `interaction_logs`, `council_phase` events (TUI live status from P4), reporter (P8) all work unchanged — they consume any phase-event stream.

---

## Phase boundaries

### P14 — Codebase intel layer

**Goal**: before any LLM call, locate the relevant code.

**Files**:
- `src/maintain/codebase-intel.ts` — new. Pure function: `(cwd, task) → CodebaseIntel`.
- `src/maintain/repo-map.ts` — new. Reads `REPO_DEEP_MAP.md` if exists, else generates a fresh map via tree-walk + heuristic (skip node_modules, dist, .git, etc.).

```ts
export interface CodebaseIntel {
  repoMap: string;                       // truncated to ~2KB
  candidateFiles: Array<{ path: string; reason: string; matchScore: number }>;
  impactRadius: string[];
  regressionTests: string[];
  detectedFrameworks: string[];          // ["dotnet", "next", "react"] etc
}

export async function gatherCodebaseIntel(cwd: string, task: MaintenanceTask): Promise<CodebaseIntel>
```

Algorithm:
1. Read `REPO_DEEP_MAP.md` if exists (already done by `council/context.ts` for debate — reuse pattern).
2. Extract noun/verb keywords from task description (lowercase, strip stopwords).
3. Grep workspace for keywords → rank files by hit count + filename match. Take top 5 as candidates.
4. For each candidate, find which OTHER files `import` or `require` it (regex-based for JS/TS, `using` for C#, `import` for Python). Those become impact radius.
5. For each candidate, look in standard test locations (`__tests__/`, `*.test.*`, `tests/`) for files referencing the candidate's exports. Those become `regressionTests`.
6. Detect frameworks by presence of `package.json` / `*.csproj` / `requirements.txt` / etc.

NO LLM call in P14 — keep it deterministic + fast (sub-second).

### P15 — Single-task sprint

**Goal**: bypass P7 sprint-planner. Run one tight cycle: design → edit → verify → judge → output.

**Files**:
- `src/maintain/task-runner.ts` — new. Mirror of `src/product-loop/sprint-runner.ts` but stripped.
- `src/maintain/index.ts` — new. Top-level entry: `runMaintenanceTask(ctx, task)`.

Stages:
1. **Design** (LLM): given the task + CodebaseIntel, write a 5-10 line plan. Single LLM call via `pickCouncilTaskModel("maintain_design", leaderModelId, costAware)` — NEW task tag. NO council debate. Tier: balanced.
2. **Edit** (LLM): orchestrator's `processMessageFn` with the design plan as prompt. Same tool loop as Mode A implementation.
3. **Verify**: `runVerifyOrchestration` — same as Mode A. The recipe (existing project's test cmd) decides what counts as "green".
4. **Judge** (LLM): given task acceptance_criteria + verify output, judge pass/fail. Reuse `evaluateDoneGate` with `criteria` = `task.acceptance_criteria` mapped to Criterion shape.

Emit `council_phase` chunks per stage (use `kind: "sprint_stage"` from P4 — reuse the live-elapsed tick). Labels: `"Design"`, `"Edit"`, `"Verify"`, `"Judge"`.

No CB-1/CB-2/CB-3 needed (single-task; no oscillation possible; CB-3 fail-closes if recipe missing, but Mode C trigger already requires recipe).

### P16 — PR mode output

**Goal**: instead of leaving edits as "files committed to disk", produce a PR-ready artifact.

**Files**:
- `src/maintain/pr-builder.ts` — new. After verify passes, compute git diff from cwd + format PR.
- `src/maintain/gh-create-pr.ts` — new. Optional `gh pr create` wrapper.

Algorithm:
1. After P15 verify+judge pass, run `git status --porcelain` to capture changed files.
2. If anything modified outside expected impact radius, FLAG (not block) — surface in PR description as "files changed beyond declared radius".
3. `git diff` (committed + unstaged) → store in `task.pr.diff`.
4. Generate `task.pr.title` from task title.
5. Generate `task.pr.body` via single LLM call: `pickCouncilTaskModel("pr_body", leaderModelId, costAware=true)` — NEW task tag, tier `"fast"`. Template:
   ```
   ## Summary
   <auto from task.description>

   ## What changed
   <bulleted from diff hunks>

   ## Test plan
   <auto from task.acceptance_criteria + regression tests run>

   ## Related
   <impact radius files>
   ```
6. Branch name: `claude/<kind>-<task-id-short>` (e.g. `claude/bug-7f3a2c`). Check it doesn't exist; if yes, append `-2`.
7. If user passes `--gh-pr` flag AND `gh` CLI installed AND `gh auth status` is logged in → run `gh pr create --title "..." --body-file "..."` and capture URL.
8. Else: print PR title + body to stdout + write to `.planning/runs/<runId>/pr.md` for user to copy.

---

## Decisions locked (2026-05-21)

D1. **Verify recipe = Strict full test suite**. Mode C prioritizes safety over
   speed. The full existing test suite runs at verify stage; partial pass is
   blocked. Long-running suites are accepted as the cost of regression safety.

D2. **PR auto-create = OFF (opt-in `--gh-pr` flag)**. Default behavior: print
   diff + PR body to stdout, write to `.planning/runs/<runId>/pr.md`. User
   reviews before creating PR. With `--gh-pr` flag AND `gh auth status` OK,
   run `gh pr create` and capture URL.

D3. **Commit strategy = 1 squash commit per task**. At end of task (after
   verify passes), squash all agent edits to a single commit with message =
   PR title. Clean history; PR review easy. Implementation: `task-runner.ts`
   stashes a marker before edit stage, then `git reset --soft <marker> && git commit -m "<title>"`
   at the end.

D4. **Repo map = Generate only when REPO_DEEP_MAP.md missing**. If file exists,
   read it (current `council/context.ts` pattern). If missing, generate via
   tree-walk + heuristic ONCE and write to the repo (so subsequent runs reuse
   it; user can edit/commit if desired).

D5. **Council debate = Light review agent after edit**. Solo design + edit
   (no multi-role debate — that's Mode A). After edit completes, run ONE
   review-agent LLM call via `pickCouncilTaskModel("maintain_review", leaderModelId, costAware=true)`
   — tier `"fast"`. Review prompt: "Given the task + diff, identify any
   regression risks, missed edge cases, or pattern violations. Output JSON
   `{ ok: bool, concerns: string[] }`." If `ok=false`, surface concerns in PR
   body as `## Review Concerns` section; user decides whether to address.
   No auto-block — just visible.

---

## Out of scope for P14-P16

- Multi-task batch (`/ideal "fix bug A and add feature B"` → 2 PRs). Wait for user demand.
- Branch protection / required reviewer routing.
- Conflict resolution if branch diverges (user re-runs / `git pull --rebase` manually).
- Integration with project management (Jira/Linear ticket linking).
- Automated regression test generation when none exist (defer to P17+).

---

## Reuse map (what we're NOT building new)

| Mode A piece | Reused in Mode C? | How |
|---|---|---|
| P4 `sprint_stage` council_phase + heartbeat | ✅ Yes | task-runner emits 4 phases (Design/Edit/Verify/Judge) with same kind |
| P5 ClarifiedSpec ready-gate | ⚠️ Optional | Mode C may need 1-2 clarify Qs (e.g. "which file?") — reuse `judgeReadiness` with bug-focused prompt |
| P6 Backlog | ❌ No | Mode C task is a single MaintenanceTask, not a Backlog |
| P7 sprint-planner / progress-snapshot | ⚠️ Adapter | P7 snapshot can be reused if MaintenanceTask is wrapped as 1-item Backlog for the renderer — but cleaner to write a small MaintenanceProgressSnapshot |
| P8 reporter | ✅ Yes | Reporter doesn't care about Backlog vs Task — it reads interaction_logs + ProgressSnapshot via `renderSnapshotMarkdown`. Need a `renderMaintenanceTaskMarkdown` helper for the snapshot variant |
| `detectVerifyRecipe` | ✅ Yes | Same recipe detector |
| `processMessageFn` orchestrator tool loop | ✅ Yes | Edit stage uses it |
| RC#1 reasoning strip in council/llm.ts | ✅ Yes | Inherited via shared LLM helpers |
