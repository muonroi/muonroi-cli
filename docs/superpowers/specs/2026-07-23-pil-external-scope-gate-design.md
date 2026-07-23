# PIL External-Scope Gate — stop grounding out-of-repo analysis in the codebase

**Date:** 2026-07-23
**Branch:** `feat/pil-external-scope-gate`
**Status:** Design approved, pending implementation plan

## Problem

Evidence — session `b81172bd5b1c` (`~/.muonroi-cli/muonroi.db`):

- `mode:agent, kind:conversation` (a normal chat turn, **not** `/ideal`/`/council`), cwd = `D:\sources\Core\muonroi-cli`.
- Classified `analyze` + heavy → auto-council convened (`council stance_recall`, seeded roles `implement/research/verify`).
- A `source:task` explore sub-agent consumed **613,079 input tokens** reading the codebase (`opencode/kimi-k2.7-code`), plus 26 `subagent_step explore` and council `toolResults` growing to ~85K chars.

The user asked an analysis question **not about this repository**, yet the pipeline searched/read the codebase. This is off-topic ("lạc đề") behaviour and a large token leak.

### Root cause (confirmed by code trace)

There is **no signal anywhere** distinguishing "analysis ABOUT the current repo" from "a general analysis question typed while cwd happens to be a git repo." Everything keys on `taskType`/`complexity`/`confidence`:

| Stage | File:line | Decision | Repo-scope input? |
|---|---|---|---|
| Classify result | `src/pil/schema.ts:123-147`, `src/pil/llm-classify.ts:89-106` | emits `taskType/intentKind/confidence/deliverableKind/depthTier/ecosystemScope` | **none** (`ecosystemScope` = platform-docs vs local, `local` conflates in-repo + external) |
| Auto-council gate | `src/orchestrator/tool-engine.ts:748-761` | fire on `taskType∈{plan,analyze}` + confidence + complexity | **none** |
| Council research child | `src/orchestrator/orchestrator.ts:2195` | spawns explore over repo | **none** |
| Model `task`/`delegate` tool | `src/tools/registry.ts:841-886` | model-invoked explore reads/greps repo | **none** |
| Discovery scan | `src/pil/discovery.ts:73-94` + `layer15-context-scan.ts:117-164` | shallow `src/` scan when cwd is a project | skips only `intentKind=chitchat` |
| Layer5 recent-files | `src/pil/layer5-context.ts:104,161` | mtime-sorted `src/**/*.ts` index | skips only chitchat/CI |

## Goal

Introduce one model-decided signal that classifies whether the turn concerns the current repository, and use it to gate every codebase-reading behaviour **only when the model is confident the turn is external**. Council still convenes for heavy external analysis — it debates on the model's own knowledge instead of grounding in the repo (the user's framing: council has two forms — (1) grounded in the current repo, (2) about an external topic unrelated to the repo).

## Non-goals

- Do NOT change behaviour for `local`/`ecosystem`/unknown turns — those keep grounding in the repo exactly as today.
- Do NOT suppress the auto-council convene itself. Council loại-2 still runs for heavy external analysis.
- Do NOT add any keyword/regex table (Zero-Hardcode). The model decides scope.

## Design

### 1. Field: widen classify `scope` from 2-way to 3-way

`scope ∈ { ecosystem | local | external }` (was `{ ecosystem | local }`). Chosen over adding a 9th contract word (parse fragility — models stop after the documented 8) or a separate `needsCodebase` bool (redundant with scope). `scope` already means *the subject of the turn*; `external` is the natural third value.

- `ecosystem` — Muonroi PLATFORM / docs (unchanged: grounds + docs nudge).
- `local` — the current repo's own code (unchanged: **grounds in repo**).
- `external` — the turn is **not about any codebase in this repository**: a conceptual/general question, an external-world analysis, a topic unrelated to the current project's code. → **council loại-2 (external)**.

Fail-open: the prompt keeps **"When unsure, choose local"** — null / parse-failure / `local` / `ecosystem` all ground as today. Only a confident `external` suppresses.

Contract stays **8 words**: `<taskType>,<style>,<intent>,<deliverable>,<depth>,<scope>,<lang>,<clarity>`.

### 2. Parse + flow (`src/pil/llm-classify.ts`)

- Add `"external"` to `KNOWN_CLASSIFY_WORDS` (line 319).
- Parse `scopeWord` position-independently across `{ecosystem, local, external}` (no collision with other enum sets).
- Keep `ecosystemScope: boolean | null` derived as `scopeWord === "ecosystem" ? true : scopeWord ? false : null` (existing consumer `layer4-gsd.ts:169` unchanged).
- Add new result field `scopeKind: "ecosystem" | "local" | "external" | null` to `LlmClassifyResult`.
- Update `SYSTEM_PROMPT` scope section (line 366-368) to define `external` and add 1-2 examples (e.g. `'giải thích CAP theorem' → analyze,concise,task,answer,standard,external,vietnamese,clear`). Update the `NONREASONING_MAX_OUTPUT_TOKENS` comment sample if needed (still ≤ 8 words).
- `CLASSIFY_REPAIR_INSTRUCTION` safe default stays `local`.

### 3. Wire to PIL context

- `src/pil/layer1-intent.ts:720` — map `scopeKind: llmRes.scopeKind` alongside `ecosystemScope`.
- `src/pil/types.ts` — add `scopeKind?: "ecosystem" | "local" | "external" | null` next to `ecosystemScope` (line 78).
- Derived helper `repoRelevant(ctx) = ctx.scopeKind !== "external"` (a tiny pure function; fail-open — treats null/undefined as relevant).

### 4. Gates — fire only when `scopeKind === "external"`

1. **Discovery scan** — `src/pil/discovery.ts:73-94`: add `repoRelevant` to the trigger condition so `scanProjectContext` is skipped for external turns.
2. **Layer5 recent-files** — `src/pil/layer5-context.ts`: skip `fetchRecentFiles(cwd)` (line 161) when external; keep the rest of layer5 (flow state) intact.
3. **Council research grounding** — thread `repoRelevant` into `runCouncilV2` (`orchestrator.ts:2100`) so the research/explore child at `orchestrator.ts:2195` is skipped when external. Council still convenes and debates; it just does not spawn the repo-reading explore child. The synthesis proceeds on the debate content alone.
4. **Model-invoked explore steering** — when external, inject a short directive into the turn's system/steering (the same channel that already front-loads batching/GSD directives): *"This question is not about the current repository. Do NOT search, grep, or read the codebase (no explore/task/delegate over repo files) unless the user references a specific file or path."* Soft, model-first — no tool is hard-removed, matching the fail-open ethos.

Auto-council gate (`tool-engine.ts:748-761`) is unchanged.

### 5. Zero-hardcode compliance

`scopeKind` is entirely model-decided from the classify call. No provider/model IDs, no keyword tables. Gates read a boolean derived from the model's word.

## Data flow

```
user prompt
  → llm-classify (8-word contract, scope∈{ecosystem,local,external})
    → parseResponse → LlmClassifyResult.scopeKind
      → layer1-intent maps scopeKind into PIL ctx
        → repoRelevant = scopeKind !== "external"
          ├─ discovery.ts        : scan repo only if repoRelevant
          ├─ layer5-context.ts   : recent-files only if repoRelevant
          ├─ runCouncilV2        : research/explore child only if repoRelevant
          └─ turn steering       : if !repoRelevant, inject "don't read codebase" directive
```

## Error handling / fail-open

- Classify null / unparseable / self-repair-failed → `scopeKind = null` → `repoRelevant = true` → **all grounding behaves exactly as today**. No regression risk on the common path.
- A false `external` (model wrongly tags an in-repo question) is the only new failure mode; mitigated by the "when unsure, choose local" prompt rule and by keeping council + tools available (soft steering, not hard removal) so the model can still read a file if the user names one.

## Testing

Per project rules (`muonroi-cli/CLAUDE.md` + memory `feedback_harness_verify_no_unittest`): unit-test where units already have coverage, and add a harness E2E for the user-visible behaviour.

1. **Unit — parse** (`src/pil/__tests__/llm-classify.test.ts`): `external` word → `scopeKind === "external"`, `ecosystemScope === false`; `local`/omitted → `scopeKind` `local`/`null`, `ecosystemScope` unchanged.
2. **Unit — layer1 map** (`layer1-intent.test.ts`): `scopeKind` propagates into ctx; null on classify failure.
3. **Unit — gate conditions**: `discovery.ts` and `layer5-context.ts` skip their repo scan when `scopeKind === "external"`, run when `local`/`null`.
4. **Unit — council**: `runCouncilV2` skips the research/explore child when `repoRelevant === false`; still convenes + synthesizes.
5. **Harness E2E** (`tests/harness/`): drive an external analysis prompt through a fixture that returns `scope=external`; assert no `source:task` explore-over-repo sub-agent and no discovery scan fired; council debate still surfaces.
6. **Pre-push gate**: full `bunx vitest run` green + `bunx vitest -c vitest.harness.config.ts run tests/harness/` for touched surfaces.

## Risks

- **Council research plumbing** (gate #3) has the widest blast radius — `runCouncilV2` is large. The change is additive (an extra guard before spawning the research child) and defaults to today's behaviour when the flag is absent.
- **Classify prompt drift** — adding a scope value + examples could nudge the model's other field choices. Mitigated by keeping the 8-word contract, the examples format, and the `local` default. Covered by existing classify unit tests.
