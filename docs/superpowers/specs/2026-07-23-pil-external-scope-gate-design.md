# PIL External-Scope Gate — stop grounding out-of-repo analysis in the codebase

**Date:** 2026-07-23
**Branch:** `feat/pil-external-scope-gate`
**Status:** Design v2 (revised after adversarial review), pending implementation plan

## Problem

Evidence — session `b81172bd5b1c` (`~/.muonroi-cli/muonroi.db`). The user prompt was a **council debate about authoring paid coding challenges on shipd.ai** — a strategy question with **nothing to do with the muonroi-cli codebase**. cwd happened to be `D:\sources\Core\muonroi-cli`.

The pipeline classified it heavy → auto-council → the council's research phase spawned an `explore` sub-agent that read **613,079 input tokens** of the muonroi-cli codebase to "ground" an out-of-repo question.

### Decisive timeline (proves the leak is COUNCIL-internal, not the main loop)

`usage_events` + `interaction_logs`, ordered:

```
08:19:07 → 08:22:35  call_accounting/council   (council debate runs)
08:26:49 → 08:32:01  call_accounting/subagent x26   ← ONE explore child, callId 461862c7…
08:27:01 → 08:32:21  subagent_step/explore    x26   (same single callId)
08:32:21             usage_events source=task  in=613079   ← the leak (explore child onFinish)
08:32:21.389         council/stance_recall           (3ms later — council resumes)
08:32:47 → 08:44:38  call_accounting/council         (unbroken through synthesis)
08:44:54             stream_start / call_accounting/main   ← main agent loop FIRST runs here
08:45:07             agent_response (source=message seq=5)
```

The main agent loop did not stream until **08:44:54**, long after the explore (08:26–08:32). So the model's turn **could not** have called `task`/`delegate` — the 613K explore is the **council research child**, spawned via the bridge `runCouncilV2 → runIsolatedTask` (`orchestrator.ts:2194-2202`) → `runResearchIsolated` (`debate.ts:376`) → `runTaskRequest` → `StreamRunner` (billed `source:task` at `stream-runner.ts:816`).

### Root cause

No signal anywhere distinguishes "analysis ABOUT the current repo" from "a general analysis question typed while cwd happens to be a git repo." Every gate keys on `taskType`/`complexity`/`confidence`:

| Stage | File:line | Repo-scope input? |
|---|---|---|
| Classify result | `schema.ts:123-147`, `llm-classify.ts:89-106` | none (`ecosystemScope` = platform-docs vs local; `local` conflates in-repo + external) |
| Council research phase | `debate.ts:396` `researchWithFallback` → `debate.ts:376` isolated / `debate.ts:415` in-process `llm.research` / `debate.ts:2310` grounding-verify | none |
| Auto-council gate | `tool-engine.ts:748-761` | none |
| Discovery scan | `discovery.ts:73-104` + `layer15-context-scan.ts:117-164` | skips only `intentKind=chitchat` |
| Layer5 recent-files | `layer5-context.ts:100-161` | skips only chitchat/CI |
| Main-loop `task`/`delegate` | `registry.ts:841-886` (`agent:"explore"` → `runDelegationFn` at 868-871) | none *(unobserved in this session, but the same class of leak)* |

## Goal

Add one model-decided signal — whether the turn concerns the current repository — and use it to stop every codebase-reading behaviour **only when the model is confident the turn is external**. Council still convenes for heavy external analysis; it debates on the model's own knowledge instead of grounding in the repo (the user's framing: council has two forms — (1) grounded in the current repo, (2) about an external topic unrelated to the repo).

## Non-goals

- No change for `local`/`ecosystem`/unknown turns — they keep grounding exactly as today.
- Do NOT suppress the auto-council convene itself. Council loại-2 still runs for heavy external analysis.
- No keyword/regex table (Zero-Hardcode). The model decides scope.

## Design

### 1. Field: widen classify `scope` from 2-way to 3-way

`scope ∈ { ecosystem | local | external }` (was `{ ecosystem | local }`). Chosen over a 9th contract word (parse fragility — models stop after the documented 8) or a separate `needsCodebase` bool (redundant with scope). `scope` already means *the subject of the turn*; `external` is the natural third value.

- `ecosystem` — Muonroi PLATFORM / docs (unchanged: grounds + docs nudge).
- `local` — the current repo's own code (unchanged: **grounds in repo**).
- `external` — the turn is **not about any codebase in this repository**: a conceptual/general question, an external-world analysis, a topic unrelated to the current project's code.

Fail-open: the prompt keeps **"When unsure, choose local"** — null / parse-failure / `local` / `ecosystem` all ground as today. Only a confident `external` suppresses. Contract stays **8 words**: `<taskType>,<style>,<intent>,<deliverable>,<depth>,<scope>,<lang>,<clarity>`.

### 2. Parse + flow (`src/pil/llm-classify.ts`)

- **Add `"external"` to `KNOWN_CLASSIFY_WORDS` (line 319) — LOAD-BEARING, not optional.** The language parser (`langWord`, line ~460) picks the first `/^[a-z][a-z-]+$/` token *not in* `KNOWN_CLASSIFY_WORDS`; without this, `external` is swallowed as `replyLanguage="External"` and the real language is lost. (Adversarial review confirmed this.)
- Parse `scopeWord` position-independently across `{ecosystem, local, external}` at line 449 (`parts.find(p => p === "ecosystem" || p === "local" || p === "external")`). No collision with other enum sets.
- Keep `ecosystemScope: boolean | null` derived: `scopeWord === "ecosystem" ? true : scopeWord ? false : null`. Behaviourally identical for existing inputs (`ecosystem→true`, `local→false`, absent→null; new `external→false`). Consumer `layer4-gsd.ts:169` (`=== true`) unchanged — external → no docs nudge.
- Add result field `scopeKind: "ecosystem" | "local" | "external" | null` to `LlmClassifyResult` (**required-nullable**, consistent with `ecosystemScope`/`replyLanguage`; requires updating ~9 existing test fixtures — see Testing).
- Update `SYSTEM_PROMPT` scope section (line 366-368) to define `external` + add ~2 examples, e.g.
  `'giải thích CAP theorem' → analyze,concise,task,answer,standard,external,vietnamese,clear`
  `'design a council debate about pricing strategy for a SaaS' → plan,balanced,task,report,heavy,external,english,clear`
  Keep the `local` default line. Token budget unaffected (`external` ≤ `ecosystem` length; 56-token ceiling has 2× headroom).

### 3. Wire to PIL context

- `layer1-intent.ts:720` — map `scopeKind: llmRes.scopeKind` alongside `ecosystemScope`.
- `types.ts` — add `scopeKind?: "ecosystem" | "local" | "external" | null` next to `ecosystemScope` (line 78).
- Pure helper `repoRelevant(ctx): boolean = ctx.scopeKind !== "external"` (fail-open — null/undefined ⇒ relevant).

### 4. Gates — fire only when `scopeKind === "external"`

Ordered by load-bearing weight, corrected after review:

**Gate A — Council research + grounding-verify phase (PRIMARY; this is the fix that stops the 613K leak).**
The naive "null out `runIsolatedTask`" is INSUFFICIENT — `researchWithFallback` (`debate.ts:396`) falls through to the in-process `llm.research` (`debate.ts:415` → `llm.ts:855` `createTools`), which runs a 15-step grep/read loop over the repo billed as `source:council`. There are three repo-reading sub-paths (isolated `debate.ts:376`, in-process fallback `debate.ts:415`, grounding-verify `debate.ts:2310`). Gate the **phase**, not the child spawn:
- Follow the existing `internetFirst` precedent (`CouncilConfig.internetFirst` at `types.ts:304`, decided at `index.ts:488` from `projectInfo.isEmpty`, alters research grounding). Add a sibling `CouncilConfig` flag (e.g. `externalTopic` / `skipRepoResearch`), decided from `pilCtx.scopeKind === "external"` at the council convene point (`runCouncilV2` / `index.ts`).
- When set: **skip the research phase entirely** (`debate.ts:665-686`) and **skip grounding-verify** (`debate.ts:1937`). Council debate + synthesis proceed on model knowledge. No sub-path reads the repo.

**Gate B — Discovery scan (token optimization).**
`runDiscovery` receives `L1Result` (`discovery.ts:43-51`), which today carries only `{taskType, confidence, complexity, domain, outputStyle, intentKind}` — **no scope**. Two options: (i) thread `scopeKind` into `L1Result` + the builder at `pipeline.ts:174-181`, then gate inside `runDiscovery`; or (ii) **preferred** — gate at the call site `pipeline.ts:170` where `ctx.scopeKind` is already in scope (`isDiscoveryEnabled() && ctx.intentKind !== "chitchat" && repoRelevant(ctx)`). Ordering is safe: `layer1-intent` (pipeline.ts:109) runs before discovery (pipeline.ts:170).

**Gate C — Layer5 recent-files (token optimization).**
`layer5Context(ctx)` (`layer5-context.ts:100`, runs at `pipeline.ts:233`) already receives full `ctx`. Add `&& repoRelevant(ctx)` to the `fetchRecentFiles` guard (line 161); leave flow-state (143-149) intact.

**Gate D — Main-loop delegation (defense-in-depth for the unobserved non-council path).**
For a plain conversational external turn (no council), the model could still call `task`/`delegate` with `agent:"explore"` (`registry.ts:868` → `runDelegationFn`). A **soft** steering directive is theatre — the model is known to ignore front-loaded directives (cf. the batching rule at `prompts.ts:351`). Instead apply a **hard** gate at the delegation/tool dispatch when `scopeKind === "external"` AND the call carries no explicit repo path arg (escape hatch: if the user/model names a concrete file/path, allow it), returning a denial message that states why. Exact dispatch point (`registry.ts` task/delegate `execute` vs `tool-engine.ts` `toolNeedsApproval` at `3059`) to be pinned in the plan.

**Gate E — Observability (NEW; closes the silent-corruption gap).**
A false `external` silently strips grounding → a confident, plausible, wrong answer with no error and no tool call to inspect. Emit a decision-log marker on every suppression, mirroring the existing auto-council log (`tool-engine.ts:784-799` `appendDecisionLog`): `appendDecisionLog({ kind: "scope-gate", scopeKind, repoRelevant, suppressed: ["research"|"discovery"|"layer5"|"delegate"...] })`. This makes over-firing auditable in `usage`/cost forensics (the same tooling that diagnosed the original incident).

Auto-council gate (`tool-engine.ts:748-761`) is unchanged.

### 5. Zero-hardcode compliance

`scopeKind` is entirely model-decided from the classify call. No provider/model IDs, no keyword tables. Gates read a boolean derived from the model's word.

## Data flow

```
user prompt
 → llm-classify (8-word contract; scope∈{ecosystem,local,external}; "external"∈KNOWN_CLASSIFY_WORDS)
   → parseResponse → LlmClassifyResult.scopeKind
     → layer1-intent maps scopeKind into PIL ctx  (pipeline.ts:109, before discovery/layer5)
       → repoRelevant = scopeKind !== "external"
         ├─ Gate B  discovery (pipeline.ts:170)      : scan repo only if repoRelevant
         ├─ Gate C  layer5 recent-files (:161)        : index repo only if repoRelevant
         ├─ Gate A  council convene → CouncilConfig   : external ⇒ skip research + grounding-verify phases
         ├─ Gate D  task/delegate explore dispatch     : external + no path arg ⇒ hard-deny (with reason)
         └─ Gate E  appendDecisionLog(scope-gate…)     : every suppression logged for forensics
```

## Error handling / fail-open

- Classify null / unparseable / self-repair-failed → `scopeKind = null` → `repoRelevant = true` → all grounding behaves exactly as today. No regression on the common path.
- A false `external` is the only new failure mode; mitigated by (a) the "when unsure, choose local" prompt rule, (b) Gate D's path-arg escape hatch, (c) Gate E telemetry so over-firing is detectable.

## Testing

Per project rules (`muonroi-cli/CLAUDE.md` + memory `feedback_harness_verify_no_unittest`): unit-test where units already have coverage, add a harness E2E for the user-visible behaviour, keep the full suite green.

1. **Unit — parse** (`llm-classify.test.ts`): `external` word → `scopeKind==="external"`, `ecosystemScope===false`, and `replyLanguage` still parsed (guards the `KNOWN_CLASSIFY_WORDS` regression); `local`/omitted → `scopeKind` `local`/`null`, `ecosystemScope` unchanged. Add an explicit `local → ecosystemScope===false` assertion so the now-overloaded `false` bucket is covered.
2. **Fixtures** — update the ~9 existing mocks that build `LlmClassifyResult`/`ecosystemScope: null` literals (`pipeline.test.ts:87,257,286,319,343,363,382,399`; `layer1-intent.test.ts:257,286`) to include `scopeKind`.
3. **Unit — layer1 map** (`layer1-intent.test.ts`): `scopeKind` propagates into ctx; null on classify failure.
4. **Unit — gate B/C conditions**: discovery (pipeline call-site) and layer5 skip their repo scan when `scopeKind==="external"`, run when `local`/`null`.
5. **Unit — council Gate A**: with the external flag set, `researchWithFallback` / the research phase and grounding-verify are skipped (no `runIsolatedTask`, no `llm.research`); council still convenes + synthesizes. Assert none of the three sub-paths run.
6. **Unit — Gate E**: a `scope-gate` decision-log entry is written on suppression.
7. **Harness E2E** (`tests/harness/`): drive an external analysis prompt through a fixture returning `scope=external`; assert no `source:task` explore-over-repo sub-agent and no discovery scan fired; council debate still surfaces.
8. **Pre-push gate**: full `bunx vitest run` green + `bunx vitest -c vitest.harness.config.ts run tests/harness/` for touched surfaces.

## Risks

- **Gate A council plumbing** is the widest blast radius. Mitigated by copying the proven `internetFirst` flag pattern and by skipping the whole phase (a strict superset of "no repo read") rather than surgically editing three sub-paths.
- **False-positive `external`** silently strips grounding. This is the highest-severity new failure mode — Gate E telemetry is mandatory, not optional, precisely because the user cannot see this regression otherwise.
- **Classify prompt drift** from a new scope value + examples. Mitigated by the fixed 8-word contract, the `local` default, and the parse/fixture unit tests.

## Review provenance

Design v2 incorporates three adversarial review agents (2026-07-23):
- **Source verification**: proved the 613K explore is the council research child, not a main-loop `task` call → Gate A is primary, original gate #4 (soft steering) is irrelevant to this incident and downgraded to Gate D (defense-in-depth). Also caught that nulling the child spawn leaves the in-process `llm.research` fallback still reading the repo → gate the phase.
- **Correctness**: pipeline ordering is safe; `KNOWN_CLASSIFY_WORDS += "external"` is load-bearing for language parsing; Gate B's original `discovery.ts:73-94` + `repoRelevant(ctx)` wiring was impossible (`runDiscovery` has no `ctx`/scope) → moved to `pipeline.ts:170`.
- **Design**: soft-steering is theatre → hardened to Gate D; missing observability → added Gate E; ~9 test fixtures must be updated for a required `scopeKind`.
