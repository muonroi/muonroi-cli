# REPO_DEEP_MAP — muonroi-cli

> Last updated: 2026-05-20 after `src/ui/app.tsx` split (Tasks 1-14).

---

## Top-level structure

| Path | Purpose |
|------|---------|
| `src/index.ts` | Entry point — CLI bootstrap, mode dispatch |
| `src/orchestrator/` | Agent class, compaction, delegations, council |
| `src/providers/` | Multi-provider factory, keychain, vision proxy |
| `src/router/` | Per-turn model routing with role-based resolution |
| `src/pil/` | Prompt Intelligence Layer (6-layer pipeline) |
| `src/ui/` | React TUI, status bar, slash commands (see detail below) |
| `src/storage/` | SQLite session/message persistence |
| `src/tools/` | Builtin tools (bash, file ops, grep, LSP) |
| `src/mcp/` | Model Context Protocol server integration |
| `src/models/` | Model catalog and pricing registry |
| `src/ee/` | Experience Engine client and hooks |
| `src/scaffold/` | Project scaffold / init-new flow |
| `src/product-loop/` | Product loop orchestrator and loop driver |
| `src/flow/` | Scaffold checkpoint and flow state |
| `src/agent-harness/` | Agent harness protocol, driver, semantic wrappers |
| `packages/` | Independently publishable harness adapter packages |
| `tests/harness/` | E2E harness specs |

---

## src/ui/ — detail (post-split)

`src/ui/app.tsx` is the root TUI component (~6200 lines as of 2026-05-20, reduced from 9368).
All extracted modules below are imported by `app.tsx`.

### Foundation

| File | Purpose |
|------|---------|
| `src/ui/app.tsx` | Root TUI component — wires all sub-modules together |
| `src/ui/types.ts` | Shared TypeScript interfaces and type aliases for the TUI |
| `src/ui/constants.ts` | Named constants (key codes, limits, default strings, palette) |
| `src/ui/theme.ts` | OpenTUI theme tokens |
| `src/ui/markdown.tsx` | Markdown renderer (inline + block) |
| `src/ui/syntax-highlight.ts` | Syntax highlighting helper |
| `src/ui/terminal-selection-text.ts` | Terminal text-selection utilities |

### Utils (`src/ui/utils/`)

| File | Purpose |
|------|---------|
| `color.ts` | ANSI color helpers, dim/bold wrappers |
| `text.ts` | String truncation, wrapping, display-width utilities |
| `tools.ts` | Tool-name formatting, icon mapping |
| `modal.ts` | Modal sizing / positioning helpers |
| `format.ts` | Number/duration/token formatting for display |

### Components (`src/ui/components/`)

| File | Purpose |
|------|---------|
| `hero-logo.tsx` | ASCII hero logo splash component |
| `diff-view.tsx` | Unified/split diff renderer |
| `lsp-views.tsx` | LSP diagnostic and hover views |
| `tool-result-views.tsx` | Tool result rendering (bash, file, grep, etc.) |
| `media-views.tsx` | Image/binary media display stubs |
| `structured-response-view.tsx` | Structured JSON response renderer |
| `message-view.tsx` | Single chat message bubble (user + assistant) |
| `session-header.tsx` | Session info header bar |
| `slash-inline-menu.tsx` | Inline slash-command autocomplete popup |
| `copy-flash-banner.tsx` | Transient "Copied!" flash notification |
| `prompt-box.tsx` | Multiline prompt input box with pair-quote buffer |
| `init-new-form-card.tsx` | `/init-new` scaffold form card |
| `council-info-card.tsx` | Council configuration info card |
| `council-leader-bubble.tsx` | Council leader speech bubble |
| `council-message-bubble.tsx` | Council member speech bubble |
| `council-phase-timeline.tsx` | Council phase progress timeline |
| `council-placeholder-bubble.tsx` | Placeholder while council speaker is thinking |
| `council-question-card.tsx` | Askcard — council question prompt for the user |
| `council-status-list.tsx` | Live council speaker status list |
| `council-synthesis-banner.tsx` | Council synthesis phase banner |
| `halt-recovery-card.tsx` | Circuit-breaker halt recovery card |
| `point-to-existing-form-card.tsx` | `/point-to-existing` form card |
| `btw-overlay.tsx` | "By the way" contextual overlay |
| `SuggestionOverlay.tsx` | Typeahead suggestion overlay |
| `Toast.tsx` | Toast notification component |
| `bubble-layout.ts` | Bubble layout geometry helpers |
| `code-block-truncate.ts` | Code block truncation logic |
| `role-palette.ts` | Role color palette for council bubbles |
| `use-pair-quote-buffer.ts` | Hook: auto-paired quote/bracket insertion |

### Modals (`src/ui/modals/`)

| File | Purpose |
|------|---------|
| `api-key-modal.tsx` | API key entry/management modal |
| `update-modal.tsx` | CLI update available modal |
| `connect-modal.tsx` | Provider connection wizard modal |
| `model-picker-modal.tsx` | Model selection modal (with search) |
| `sandbox-picker-modal.tsx` | Sandbox environment picker modal |
| `wallet-picker-modal.tsx` | Wallet/billing account picker modal |

Other modals still in root `src/ui/`:

| File | Purpose |
|------|---------|
| `src/ui/agents-modal.tsx` | Agents configuration modal |
| `src/ui/mcp-modal.tsx` | MCP server management modal |
| `src/ui/mcp-modal-types.ts` | Type definitions for MCP modal |
| `src/ui/schedule-modal.tsx` | Schedule/cron job modal |
| `src/ui/plan.tsx` | Plan view component |

### Hooks (`src/ui/hooks/`)

| File | Purpose |
|------|---------|
| `use-model-picker.ts` | Hook: model picker state and keyboard navigation |
| `use-mcp-editor.ts` | Hook: MCP server editor state |
| `use-agent-editor.ts` | Hook: agent editor state |
| `useTypeahead.ts` | Hook: typeahead/autocomplete logic |

### Status Bar (`src/ui/status-bar/`)

| File | Purpose |
|------|---------|
| `index.tsx` | StatusBar root component |
| `store.ts` | Zustand store for status bar state |
| `tier-badge.tsx` | Tier/plan badge component |
| `usd-meter.tsx` | USD cost meter component |

### Slash Commands (`src/ui/slash/`)

| File | Purpose |
|------|---------|
| `registry.ts` | Slash command registry and router |
| `route.ts` | Route dispatch logic |
| `menu-items.ts` | Slash menu item definitions |
| `clear.ts` | `/clear` command |
| `compact.ts` | `/compact` command |
| `cost.ts` | `/cost` command |
| `council.ts` | `/council` command |
| `council-inspect.ts` | `/council-inspect` command |
| `debug.ts` | `/debug` command |
| `discuss.ts` | `/discuss` command |
| `ee.ts` | `/ee` command |
| `execute.ts` | `/execute` command |
| `expand.ts` | `/expand` command |
| `export.ts` | `/export` command |
| `ideal.ts` | `/ideal` command |
| `optimize.ts` | `/optimize` command |
| `pin.ts` | `/pin` command |
| `plan.ts` | `/plan` command |

### Cards (`src/ui/cards/`)

| File | Purpose |
|------|---------|
| `product-status-card.tsx` | Product loop status/progress card |

---

## src/scaffold/

| File | Purpose |
|------|---------|
| `init-new.ts` | `/init-new` scaffold orchestrator, BB target detection |
| `bb-ecosystem-apply.ts` | BB senior-bar code-gen (Program.cs, sample rule + test) |
| `bb-quality-gate.ts` | Post-scaffold quality gate (dotnet build, modular boundaries) |
| `resume-from-gate-failures.ts` | `/ideal --resume` re-entry from gate failures |

---

## src/flow/

| File | Purpose |
|------|---------|
| `scaffold-checkpoint.ts` | Checkpoint state machine for multi-step scaffold flows |

---

## src/product-loop/

| File | Purpose |
|------|---------|
| `loop-driver.ts` | Product loop orchestrator — CB gate, council injection, EE context |

---

## src/ee/

| File | Purpose |
|------|---------|
| `bb-retrieval.ts` | `fetchBBContext()` — queries EE collections for BB context |
| `bridge.ts` | PIL bridge — unified `/api/pil-context` call with circuit breaker. Also re-exports the WhoAmI provider (single sanctioned PIL→EE entry point per the `no-network-in-pil` arch guard). Hosts `warmWhoAmIFromBrain()` — the fire-and-forget thin-client boot warm (wired at `index.ts` after `detectEEClientMode`) that primes the WhoAmI cache from the brain when the device-local profile is absent |
| `who-am-i.ts` | "Who Am I" v4.0 profile provider — reads the device-local `~/.experience/profile.yaml` (via EE's installed `loadProfile`/`getPrivacyLevel` through `createRequire`), privacy-gated by a positive per-dim allowlist (defense-in-depth), cached + fail-open. `getWhoAmIProfile()` + pure `selectWhoAmIDims`/`outputStyleFromProfile` + `primeWhoAmICache()` (external prime, device-local always wins). Consumed by the pipeline → L1 outputStyle baseline (`brevity`/`decision_speed`), by L5 (`work_patterns.session_length` → resume-digest stale window, see `pil/layer5-context.ts`), by L4 (`work_patterns.delegation_style="autonomous"` → drops a resolved `discuss` phase, see `pil/layer4-gsd.ts`), and by L6 (`communication.feedback_style="precise-correction"` → auditable-diff rule on code tasks, see `pil/layer6-output.ts`) |
| `who-am-i-brain.ts` | Thin-client WhoAmI fallback. The device-local `profile.yaml` pipeline is full-brain-only (EE interceptor bails on remote mode; no `/api/profile`; no local signal-extraction), so on a thin-client `getWhoAmIProfile()` is structurally null. `deriveWhoAmIFromBrain()` searches the reachable `experience-behavioral` brain for the user's style rules, lets the brain LLM classify them into dims (agent-first, no keyword regex), and re-gates via `selectWhoAmIDims`. `DIM_VOCAB` is locked to the EE `profile-render.js` value enum so populated dims match the literals the PIL layers compare against. Flag `MUONROI_WHOAMI_BRAIN` (default ON). Fail-open null throughout |

---

## src/agent-harness/

| File | Purpose |
|------|---------|
| `protocol.ts` | `LiveFrame` / `LiveEvent` / `UINode` / `DesignSpec` types |
| `selector.ts` | `parseSelector`, `matchSelector` CSS-like grammar |
| `predicate.ts` | Zod-typed predicate evaluator |
| `driver.ts` | In-process `Driver` API |
| `test-spawn.ts` | Cross-platform spawn helper (fd 3/4 POSIX, named pipes Windows) |
| `semantic.tsx` | `<Semantic>` React wrapper for harness instrumentation |
| `reconciler-hook.ts` | `SemanticRegistry`, snapshot to `LiveFrame` |
| `mock-llm.ts` | Fixture-based LLM provider for deterministic tests |
| `mock-model.ts` | `MockLanguageModelV3` install helpers for unit cost-leak tests |
| `sidechannel.ts` | Line splitter for fd3/fd4 sidechannel stream |

---

## packages/ (harness adapters)

| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/agent-harness-core` | `@muonroi/agent-harness-core` | Protocol types, selector/predicate, Driver, WebSocket transport |
| `packages/agent-harness-opentui` | `@muonroi/agent-harness-opentui` | OpenTUI adapter — SemanticRegistry, reconciler-hook, input-bridge |
| `packages/agent-harness-react` | `@muonroi/agent-harness-react` | React DOM adapter — `<Semantic>`, `<SemanticProvider>`, `installReactHarness()` |
| `packages/agent-harness-angular` | `@muonroi/agent-harness-angular` | Angular 16+ adapter — `[muonroiSemantic]` directive, services |

---

# Core turn/enrichment subsystems (detail) — added 2026-07-05

> Deep-mapped ahead of the PIL Prompt Gate work (spec: `docs/superpowers/specs/2026-07-05-pil-prompt-gate-design.md`). Covers the four subsystems that feature touches: pil, gsd, orchestrator, council. Line numbers are point-in-time on branch feat/core-ui-separation-and-semantic-primitives — verify before editing.

## src/pil/ — Prompt Intelligence Layer (detail)

One-line purpose: `runPipeline(raw, options)` (`src/pil/pipeline.ts:312`) turns a raw user prompt into an enriched `PipelineContext` (`ctx.enriched`) by running a fixed sequence of "layers" that classify intent, optionally interview the user (discovery), inject EE/GSD/context data, and append output-format instructions — all fail-open under a race-based timeout.

### Entry point + layer ordering + timeout model

- `runPipeline` (`pipeline.ts:312-359`): bumps session turn (`bumpSessionTurn`, `session-state.ts:60`), builds a pristine `fallback: PipelineContext` FIRST (comment: "CRITICAL … Pitfall 4"), then either:
  - runs `runLayers()` directly (no race) when `hasInteractiveDiscovery` (an `interactionHandler` is supplied AND `isDiscoveryEnabled()`), because discovery is a human-paced interview and must not be killed by a fixed timeout (`pipeline.ts:335-337`).
  - otherwise races `runLayers()` against `resolveAfter(pipelineTimeoutMs(), {...fallback, fallbackReason:"pipeline-timeout"})` (`pipeline.ts:338-341`, `timeout.ts`).
  - Result is validated against `PipelineContextSchema.safeParse` (`schema.ts:43`); on failure returns fallback with `fallbackReason: schema-reject:<path>`. Any thrown exception → fallback with `fallbackReason: exception:<Name>`. Both success and failure paths call `setPilLastResult` (`store.ts:15`) so `getPilLastResult()` always has the latest ctx (used for diagnostics/self-verify).
- Timeout budget — `pipelineTimeoutMs()` (`pipeline.ts:48-71`): `MUONROI_TEST_PIPELINE_TIMEOUT_MS` env override first; else `PIPELINE_TIMEOUT_BRAIN_MS=3500` when `getCachedEEClientMode()` is `thin`/`thin-degraded`/`fat`, OR when `getCachedServerBaseUrl()` is set (boot-race fallback — EE mode probe may not have resolved yet); else `PIPELINE_TIMEOUT_FAST_MS=1500` (regex-only, EE unreachable/disabled).
- Layer ordering inside `runLayers()` (`pipeline.ts:81-282`, each step wrapped in `timed(name, fn)` which records `charsBefore/charsAfter/durationMs`):
  1. `layer1Intent` (always) — classification.
  2. Layer 1.5 `scoreComplexitySize` inline (deterministic, no `timed()` wrapper — direct call at `pipeline.ts:114`).
  3. Direct-answer mode flag (`ctx.directAnswer`) computed inline (`pipeline.ts:139-141`).
  4. Discovery block (`pipeline.ts:144-193`) — gated by `isDiscoveryEnabled() && ctx.intentKind !== "chitchat"`; dynamic-imports `discovery.ts` (`await import("./discovery.js")`) so discovery code isn't loaded on the hot chitchat path.
  5. If `ctx.taskType !== null`: `layer2Personality` → `layer2_5Ponytail` → `layer3EeInjection` → `layer4Gsd` → `layer5Context` → (conditionally) `surfaceCompactionArtifacts` when `isMetaAnalysisPrompt(ctx.raw)` (`layer6-output.ts:37`). If `ctx.taskType === null`, all 5 of these are recorded as `applied:false, delta:"skipped:null-taskType"` (`SKIPPED_LAYERS`, `pipeline.ts:73-79`) — **no discovery-prefix, no EE injection, no GSD directive** on null-taskType turns.
  6. `injectSessionExperience` — runs unconditionally when `isSelfExperiencePrompt(ctx.raw)` is true, regardless of taskType (added because "are you blind?" style prompts often classify taskType=null) (`pipeline.ts:238-240`).
  7. `layer6Output` (always) — output-format suffix + response-tool-set selection.
  8. Metrics + fire-and-forget `appendPilLog` (never awaited on hot path).

### Layer/file table

| File | Purpose | LLM call? | Key exports (signature) | Reads from ctx | Writes to ctx |
|---|---|---|---|---|---|
| `layer1-intent.ts` | Task/intent/style/depth/scope/language classification — MODEL-FIRST ONLY (regex Pass 0-4 cascade deleted 2026-07-07) | YES (`opts.llmFallback` = the chat model, sole classifier + self-repair; no classifier wired → UNKNOWN degradation, NO regex) | `layer1Intent(ctx, opts: Layer1Options): Promise<PipelineContext>`; `scoreComplexity`/`scoreSufficiency`/`hasActionableToolIntent`/`isSocialPleasantry`/`isContinuationPhrase`/`isStatusCheckQuestion`/`isGreenfieldBuildTask` (retained ONLY for external importers — playbook/discovery/orchestrator; no longer on this layer's classify path) | `ctx.raw`, `ctx.gsdPhase` | `taskType`, `domain`, `confidence`, `outputStyle`, `intentKind`, `deliverableKind`, `modelDepthTier`, `ecosystemScope`, `replyLanguage`, `_brainData`, `_intentTrace`, `gsdPhase`, `layers[]` |
| `llm-classify.ts` | Model-first classifier factory + result types; sub-session router (model-only, no regex) | YES (`createLlmClassifier` streams a real chat completion, self-repairs on unparseable reply) | `createLlmClassifier(factory, modelId): LlmClassifyFn`; `LlmClassifyFn = (prompt, opts?) => Promise<LlmClassifyResult\|null>`; `LlmClassifyResult` (fields: taskType, outputStyle, confidence, intentKind, deliverableKind, depthTier, needsClarification, ecosystemScope, replyLanguage); `classifySubSessionAction(factory, modelId, prompt, ctx?, signal?)` (model-only — regex heuristic removed 2026-07-07) | n/a (pure function, called by layer1) | n/a — returns `LlmClassifyResult` consumed by layer1 |
| `layer1_5-complexity-size.ts` | Deterministic small/medium/large size bucketing | No — pure heuristic | `scoreComplexitySize(input: ComplexitySizeInput): ComplexitySizeResult` (`:99`) | `ctx.raw`, `ctx.taskType` (via pipeline call, not ctx directly) | `ctx.complexitySize`, mirrors into `_intentTrace.complexitySize/-Score` |
| `layer2-personality.ts` | Personality/tone adaptation | Unclear from exports alone — no external call spotted; treat as deterministic/config-driven | `layer2Personality(ctx): Promise<PipelineContext>` (`:26`) | `ctx.taskType`, `ctx.outputStyle` | `layers[]` entry `personality-adaptation` |
| `layer2_5-ponytail.ts` | "Ponytail mode" (gated by `isPonytailModeEnabled`, `config.ts:66`) | Deterministic | `layer2_5Ponytail(ctx): Promise<PipelineContext>` (`:15`) | `ctx.taskType` | `layers[]` entry `ponytail-mode` |
| `layer3-ee-injection.ts` | EE recall injection (T0 principles / T1 rules / T2 patterns) into `ctx.enriched`, plus meta-artifact surfacing | YES (network call to EE search/brain endpoints, not a chat-completion LLM call — embedding/vector search) | `layer3EeInjection(ctx): Promise<PipelineContext>` (`:237`); `surfaceCompactionArtifacts(ctx): Promise<PipelineContext>` (`:652`); `RECALL_FEEDBACK_NUDGE` const (`:75`) | `ctx._brainData`, `ctx.raw`, `ctx.taskType`, `ctx.sessionId` | `ctx.enriched` (appends context block), `ctx.t1Rules`, `layers[]` entry `ee-experience-injection` |
| `layer4-gsd.ts` | GSD directive injection (quick/standard/heavy tiers, mutation-gate wording, gray-area questions, docs-first nudge, language re-anchor) | Deterministic (reads `ctx.modelDepthTier` etc., no own LLM call) | `layer4Gsd(ctx): Promise<PipelineContext>` (`:66`) | `ctx.modelDepthTier`, `ctx.ecosystemScope`, `ctx.replyLanguage`, `ctx.gsdPhase`, `ctx.complexitySize` | `ctx.enriched`, `ctx.complexityTier`, `ctx.gsdGateBlocking`, `ctx.grayAreas`, `layers[]` entry `gsd-workflow-structuring` |
| `layer5-context.ts` | Context enrichment (recent files / flow-state / staleness) | Likely EE/network-backed (has `staleThresholdMsForSessionLength`) — not a chat-completion LLM call | `layer5Context(ctx): Promise<PipelineContext>` (`:96`); `staleThresholdMsForSessionLength(value): number` (`:20`) | `ctx.sessionId`, `ctx.intentKind` | `ctx.enriched`, `ctx.digestAgeMs`, `layers[]` entry `context-enrichment` |
| `layer6-output.ts` | Output-format suffix (`applyPilSuffix`) + response tool-set selection; meta-analysis/question detection | Deterministic (regex-based classifiers) | `isMetaAnalysisPrompt(raw): boolean` (`:37`); `applyPilSuffix(systemPrompt, ctx, responseToolsActive=false): string` (`:197`); `isImplementationIntent(raw): boolean` (`:324`); `isQuestionLike(raw): boolean` (`:373`); `prefersStructuredReport(raw): boolean` (`:377`); `getResponseToolSet(ctx, providerId?): ToolSet` (`:387`); `layer6Output(ctx): Promise<PipelineContext>` (`:428`) | `ctx.deliverableKind`, `ctx.taskType`, `ctx.raw` | `ctx.enriched` (suffix), `layers[]` entry `output-optimization` |
| `layer15-context-scan.ts` | Static project scan used ONLY by discovery (not part of the 6-layer pipeline) | No | `detectLanguage/detectFramework/detectPackageManager(cwd, exists?, deps?): string\|null`; `scanBoundedContexts(cwd): BoundedContext[]` (`:60`); `findRelevantModules(raw, boundedContexts): RelevantModule[]` (`:92`); `scanProjectContext(raw, cwd): Promise<ProjectContext>` (`:117`, has a 500ms internal EE-pattern fetch + `execSync("git status --porcelain")`) | n/a (takes `raw`/`cwd`) | returns `ProjectContext`, cached via `discovery-cache.ts` |
| `layer16-clarity.ts` | Converts model-authored `ModelCard` into a UI `CouncilQuestionData`; headless gap resolution | Deterministic | `modelCardToQuestion(card, questionId): CouncilQuestionData` (`:20`); `resolveGapsNonInteractive(cards, projectContext, raw)` (`:45`); `getDefaultOutcome(taskType, raw?): string` (`:78`) | n/a | n/a (discovery-only, not ctx) |
| `layer17-feasibility.ts` | Checks whether the clarified scope paths exist on disk; adjusts scope to nearest bounded context | No (fs.existsSync only) | `checkFeasibility(intent, projectContext, exists?): Promise<FeasibilityResult>` (`:7`) | n/a | n/a (discovery-only) |
| `layer18-acceptance.ts` | Builds the final acceptance card shown to the user after discovery | Deterministic | `buildAcceptanceCard(...)` (`:15`) | n/a | n/a (discovery-only) |
| `clarity-gate.ts` | Detects "don't ask me anything" / already-scoped signals to skip discovery | Deterministic regex | `hasOperationalScope(raw): boolean` (`:24`); `detectNoClarifySignal(raw): boolean` (`:38`) | n/a | n/a — consumed by `discovery.ts:82` |
| `complexity-size` (= `layer1_5-complexity-size.ts`) | see above | | | | |
| `config.ts` | All PIL feature flags (env-var gated) | n/a | `isUnifiedPilEnabled()` (`:7`); `getUnifiedPilBudgetMs()` (`:22`, clamp [1000,8000], default 3500); `isLlmFirstClassifyEnabled()` (`:36`, default ON, `MUONROI_LLM_FIRST_CLASSIFY=0` reverts to regex cascade); `isLlmFirstBrainEnabled()` (`:48`, default ON); `isDiscoveryEnabled()` (`:52`, `MUONROI_PIL_DISCOVERY=0` disables); `getMaxInterviewQuestions()` (`:61`, default 3, range 1-5); `isPonytailModeEnabled()` (`:66`, OFF under vitest/NODE_ENV=test) | | |
| `schema.ts` | Zod schemas for runtime validation of `PipelineContext` and the unified brain response | n/a | `TaskTypeSchema`, `OutputStyleSchema`, `LayerResultSchema`, `LayerTimingSchema`, `PipelineMetricsSchema`, `PipelineContextSchema` (`:43`, used by `pipeline.ts:342`), `PilContextResponseSchema` (`:123`), `PilContextResponse` type (`:149`) | | |
| `types.ts` | `PipelineContext`, `IntentDetectionTrace`, `BrainData`, `TaskType`, `OutputStyle` type defs | n/a | see full field docstrings in file; canonical source of truth for every ctx field | | |
| `budget.ts` | Token-budget truncation helper | n/a | `DEFAULT_TOKEN_BUDGET = 500` (`:8`); `truncateToBudget(text, budgetTokens): string` (`:12`) | | |
| `budget-log.ts` | Fire-and-forget PIL interaction logger (per-layer char deltas) | n/a (writes log file/DB) | `appendPilLog(entry)` (used at `pipeline.ts:263`, never awaited) | | |
| `session-state.ts` | Per-session turn counter + discovery-accepted flag + follow-up heuristic | n/a | `getSessionState(sessionId)` (`:49`); `bumpSessionTurn(sessionId): number` (`:60`, called BEFORE pipeline work, `pipeline.ts:316`); `markDiscoveryAccepted(sessionId, at?)` (`:72`, called at end of `runDiscovery`, `discovery.ts:226`); `isLikelyFollowUp(raw): boolean` (`:141`); `_resetForTests()` (`:83`) | | |
| `store.ts` | Last-pipeline-result + last-output-mode module-level cache | n/a | `setPilLastResult(ctx)` / `getPilLastResult(): PipelineContext\|null` (`:15,19`); `setLastOutputMode` / `getLastOutputMode` (`:23,27`); `OutputMode = "structured"\|"text-fallback"\|"conversational"` (`:10`) | | |
| `discovery.ts` | Orchestrates the interactive/headless clarification interview (L1.5–L1.8) | YES (`clarificationProposer` calls the real task model to design `ModelCard[]`) | `runDiscovery(raw, l1: L1Result, cwd, handler, sessionId?, clarificationProposer?, recentTurnsSummary?): Promise<DiscoveryResult>` (`:44`); `createModelClarificationProposer(providerFactory, modelId): ModelClarificationProposer` (`:295`) | n/a (params, not ctx) | returns `DiscoveryResult`, folded into `ctx._discoveryResult` + `ctx.enriched` prefix by `pipeline.ts:143-193` |
| `discovery-cache.ts` | Per-cwd cache of `ProjectContext` so repeated turns skip the fs/EE scan | n/a | `getCachedProjectContext(cwd): ProjectContext\|null` (`:7`); `setCachedProjectContext(ctx)` (`:14`); `clearDiscoveryCache()` (`:18`) | | |
| `discovery-types.ts` | Shared discovery types | n/a | `ProjectContext`, `BoundedContext`, `RelevantModule`, `ModelCard`, `ModelCardOption`, `ClarifiedIntent`, `ModelClarificationProposer`, `FeasibilityResult`, `DiscoveryResult`, `AcceptanceCardData`, `DiscoveryInteractionHandler` | | |
| `index.ts` | Public re-export surface for the whole `src/pil/` subsystem | n/a | re-exports `runPipeline`/`PipelineOptions` (`pipeline.js`), `applyPilSuffix`/`getResponseToolSet` (`layer6-output.js`), `DEFAULT_TOKEN_BUDGET`/`truncateToBudget`, `isDiscoveryEnabled`, `getPilLastResult`/`setPilLastResult`, and core types | | |
| `session-experience-injection.ts` | Injects live session-experience snapshot for first-person "did you struggle?" prompts | Likely reads in-process session telemetry, no chat-completion call | `injectSessionExperience(ctx)`, `isSelfExperiencePrompt(raw)` (referenced at `pipeline.ts:33,238`) | `ctx.raw`, `ctx.sessionId` | `ctx.enriched`, `layers[]` entry `session-experience` |
| `agent-operating-contract.ts` | Separate contract text injected for agent-mode operating rules (not part of the 6-layer sequence — check call sites before assuming it runs every turn) | n/a | not enumerated above — grep `agent-operating-contract.test.ts` for usage if touching this | | |
| `cheap-model-workbooks.ts` / `cheap-model-playbook.ts` / `native-capabilities-workbook.ts` / `task-tier-map.ts` / `response-tools.ts` / `ollama-classify.ts` | Supporting tables/heuristics consumed by layer4/layer6/llm-classify for tier-specific playbooks and response tool sets — NOT separate pipeline layers; treat as library modules imported by the layer files above | mixed | out of scope for this pass — re-grep if the PIL Gate feature touches tool-set selection or per-tier playbooks | | |

### Data flow: raw → `ctx.enriched`

1. `ctx.enriched` starts equal to `ctx.raw` (`pipeline.ts:320`, the `fallback` object).
2. Layer1 (model-first path, `layer1-intent.ts:674-812`) does NOT touch `enriched` — it only sets classification fields. The model-first branch is gated by `isLlmFirstClassifyEnabled() && opts.llmFallback` (`:687`); when the model returns a result, layer1 returns early with `taskType`, `domain`, `confidence`, `outputStyle`, `intentKind`, `deliverableKind` (`llmRes.deliverableKind`, `:788`), `modelDepthTier` (`llmRes.depthTier`, `:792`), `ecosystemScope` (`:796`), `replyLanguage` (`:797`), and `_brainData` populated from a same-call unified `pilContext()` fetch (`:756-774`, gated by `isLlmFirstBrainEnabled() && intentKind !== "chitchat"`). If `opts.llmFallback` is absent or throws, layer1 falls through to the legacy regex cascade (Pass 1 keyword regex → Pass 2 → Pass 2.5 chitchat shortcut → Pass 3 unified/legacy EE brain call → Pass 4 `LlmClassifyFn` fallback) starting further down in the same function (`layer1-intent.ts:813+`, confidence/intentKind reassigned through `:1134-1483`).
3. Discovery (if enabled and not chitchat) prepends a `[Discovery] Intent/Outcome/Scope/Warnings` block + raw Q&A transcript to `ctx.enriched` (`pipeline.ts:166-184`) ONLY when `discovery.interviewed && discovery.accepted`. If the user cancels (`!discovery.accepted`), the pipeline short-circuits and returns `{...ctx, enriched: ctx.raw, fallbackReason: "discovery-cancelled"}` (`:187`) — i.e. downstream layers 2-6 never run on a cancelled turn.
4. Layer2/2.5/3/4/5 append their own blocks to `ctx.enriched` (each layer function does `ctx.enriched = ctx.enriched + "\n..."`-style concatenation internally — verify exact concat point per file before editing).
5. Layer6 (`layer6Output`, always last) appends the final output-format suffix via `applyPilSuffix` logic and finalizes `ctx.metrics`.

Confidence / modelDepthTier / deliverableKind / intentKind provenance:
- **Model-first path (default)**: all four come directly from the single `LlmClassifyResult` (`llm-classify.ts:49-91`) returned by `opts.llmFallback(ctx.raw)`, called at `layer1-intent.ts:691`, unpacked at `layer1-intent.ts:777-812`.
- **Legacy fallback path**: `confidence` starts as `result.confidence` (`:1134`) and gets overwritten by keyword-match confidence (`:1167`), chitchat defaults (`:1191,1215`), or Pass 4 LLM confidence (`:1294`); `intentKind` is inferred through several branches (`:1137-1483`) with a final safety net "actionable tool intent never chitchat" (`:1482-1483` and `:700` on the model-first path); `modelDepthTier`/`deliverableKind`/`ecosystemScope`/`replyLanguage` are simply `undefined`/not set on the legacy path (they are model-first-only fields) — layer4/layer6 must treat them as absent and fall back to their own regex predicates (documented in `types.ts:58-114`).

### Discovery interview flow (`discovery.ts`)

- Gate order in `runLayers()` before `runDiscovery` is even called: `isDiscoveryEnabled()` (`config.ts:52`, env `MUONROI_PIL_DISCOVERY`) AND `ctx.intentKind !== "chitchat"` (`pipeline.ts:144`).
- Inside `runDiscovery` (`discovery.ts:44`), additional early-return gates (each returns `baseResult()` — a no-op `DiscoveryResult` with `interviewed:false, accepted:true, projectContext: emptyProjectContext(cwd)`):
  - `!isDiscoveryEnabled()` (redundant re-check, `:74`)
  - `l1.intentKind === "chitchat" || l1.taskType === null` (`:78`)
  - `detectNoClarifySignal(raw)` (`clarity-gate.ts:38` — regex signal that the user already gave full scope / said "just do it")
  - `!clarificationProposer` (`:87` — no model-driven proposer wired; explicitly "no regex fallback by design", logs an error if `handler` was provided)
- **`ProjectContext` scan is DIRECTORY-LEVEL at the top, FILE-LEVEL only for specific known entry filenames**: `scanBoundedContexts(cwd)` (`layer15-context-scan.ts:60`) lists `src/*` subdirectories (max 20, must be non-empty dirs), and for each directory only reads a FIXED list of possible entry filenames (`index.ts`, `index.tsx`, `index.js`, `mod.rs`, `__init__.py`, `layer15-context-scan.ts:71`) — it does NOT walk every file in the directory. `extractExports` (`:78`) then regex-scans only those entry files for `export function/const/class/type/interface/enum` symbols (max 20 per dir). So the scan is directory-granular for discovery + shallow file-granular only for the directory's designated entry point.
- `scanProjectContext` (`layer15-context-scan.ts:117`) also does: `detectLanguage`/`detectFramework`/`detectPackageManager` (fs.existsSync checks for lockfiles/config files), an EE `searchByText(raw, ["experience-behavioral"], 5, signal)` call bounded by a 500ms `AbortController` timeout (`:129-131`, swallows failure silently → `eePatterns=[]`), and `execSync("git status --porcelain")` for `recentModifiedFiles` (swallows failure silently if not a git repo, `:148-150`).
- `runDiscovery` caches the scan per-cwd via `discovery-cache.ts` (`getCachedProjectContext`/`setCachedProjectContext`) and additionally races the scan itself against a 500ms timeout fallback to `emptyProjectContext(cwd)` (`discovery.ts:104-107`) — i.e. TWO independent 500ms budgets can apply (one inside `scanProjectContext` for the EE call, one wrapping the whole scan in `discovery.ts`).
- L1.6: `proposeModelCards(clarificationProposer, raw, l1, projectContext, recentTurnsSummary)` (`discovery.ts:256`) calls the model to design up to 3 `ModelCard[]` (sliced with `.slice(0,3)`, `:286`) — the model has FULL control over question text, options, option kinds (choice/freetext), and cancel/adjust markers. Empty array → proceed without interview (`:127`).
- Interactive mode (`handler` present): asks up to `getMaxInterviewQuestions()` (default 3) questions via `handler.askQuestion(question)`; a chosen option with `isCancel` aborts the whole discovery and marks `accepted:false` (propagates to `pipeline.ts:186-188` which resets `ctx.enriched = ctx.raw` and sets `fallbackReason:"discovery-cancelled"`); a chosen option with `isAdjust` triggers ONE re-interview round with fresh cards (`:153-188`).
- Headless mode (`handler` is null): `resolveGapsNonInteractive(cards, projectContext, raw)` (`layer16-clarity.ts:45`) picks each card's `options[defaultIndex ?? 0]` automatically — no user interaction, used for CI/agentic self-verify runs.
- L1.7 feasibility: `checkFeasibility(clarifiedIntent, projectContext)` (`layer17-feasibility.ts:7`) is PURE FILESYSTEM CHECK (`fs.existsSync` via injectable `exists` fn) — no LLM, no EE call. It never sets `viable:false`; it only accumulates `warnings` and adjusts `scope` to the nearest matching `boundedContexts` entry when a claimed path doesn't exist.
- L1.8 acceptance: no separate acceptance ceremony — the function comment states "use the model's own cards; no separate acceptance ceremony" (`discovery.ts:224-225`). `markDiscoveryAccepted(sessionId)` (`session-state.ts:72`) is called unconditionally right before building the final `DiscoveryResult`.
- Final `DiscoveryResult.accepted` is ALWAYS `true` on the non-early-return path (only the `isCancel` branches inside the interview loop set `accepted:false`).

### Key gotchas

1. **Fail-open is the load-bearing design invariant.** Every layer function is expected to catch its own errors internally and every EE/network call has its own bounded timeout; the outer `Promise.race` in `runPipeline` is a last-resort backstop. If you add an LLM-calling "PIL Gate" layer, it MUST NOT let an unhandled rejection escape `runLayers()` — a naked throw there is caught by the outer `try/catch` in `runPipeline` (`pipeline.ts:353-358`) and produces a **pristine fallback context with `fallbackReason: exception:<Name>`**, silently discarding ALL upstream layer work (intent classification, discovery, EE injection) for that turn.
2. **Timeout only applies on the non-interactive path.** `hasInteractiveDiscovery` (interactionHandler set AND discovery enabled) skips the race entirely (`pipeline.ts:335-337`) — a hung interview or a hung new "PIL Gate" prompt-for-confirmation step will block the turn indefinitely if it reuses that flag. Anything added to the interactive path needs its own internal timeout.
3. **`pipelineTimeoutMs()` depends on EE mode being resolved.** Because EE mode detection is fire-and-forget at boot (`src/index.ts`), a prompt submitted very early can race the `/health` probe; the code optimistically treats a configured `serverBaseUrl` as "thin mode incoming" to avoid truncating the brain call (`pipeline.ts:60-69`) — a similar boot-race consideration applies to any new Gate that depends on EE/config state resolved asynchronously at startup.
4. **Chitchat/continuation-phrase misclassification is an ACTIVE, documented risk** — `layer1-intent.ts` comment at `:1201-1207` references a real incident (session `40c726a31a37`) where `intentKind` returned `null` and wasted 15-20K tokens of tool schema. The safety net "`hasActionableToolIntent` upgrades chitchat→task, never the reverse" (`:700`, `:1482-1483`) exists specifically because a false "chitchat" strips bash/read tools and **breaks the turn**, while a false "task" only wastes tokens — this asymmetry is deliberate; do not "fix" it by making the net bidirectional.
5. **`isContinuationPhrase`, `isStatusCheckQuestion`, `isSocialPleasantry`** (`layer1-intent.ts:323,359,654`) are all still-live regex heuristics used by the LEGACY cascade (Pass 1/2) — they do not run when the model-first path succeeds, but they DO run whenever `opts.llmFallback` is absent/throws, so any environment without a wired model-first classifier is exposed to their known brittleness.
6. **Empty `ProjectContext` on early return.** Every `baseResult()` short-circuit in `discovery.ts` (chitchat, taskType null, no-clarify signal, no proposer, cards.length===0) returns `emptyProjectContext(cwd)` (`discovery.ts:30-42`) — i.e. `language/framework/packageManager` are all `null` and `boundedContexts/eePatterns/relevantModules` are all `[]`. A downstream "PIL Gate" that expects real project context must check `discovery.interviewed` before trusting `projectContext` fields, since the vast majority of turns (chitchat, low-signal, discovery-disabled) never populate them.
7. **`ctx._discoveryResult` is populated even when discovery is skipped/cancelled** (`pipeline.ts:165`, set right after the `runDiscovery` call in the `try` block) — but if `runDiscovery` itself throws, the `catch` at `:189-191` logs and continues WITHOUT setting `_discoveryResult`, so it stays `undefined`. Always guard on `ctx._discoveryResult?.interviewed` rather than assuming presence.
8. **`modelDepthTier`/`deliverableKind`/`ecosystemScope`/`replyLanguage` are model-first-only fields** — they are `undefined` (not `null`) whenever the legacy cascade ran, per the field docstrings in `types.ts:58-114` ("null when the model omitted it OR the legacy cascade ran"). Any new Gate reading these fields must treat `undefined` and the documented `null` sentinel identically as "fall back to legacy regex", and must NOT assume model-first always ran.
9. **`layer4Gsd`'s mutation-gate blocking (`gsdGateBlocking`) is keyed on the model-first classify depth, not the later leader-tier assessor's upgrade** — per `CLAUDE.md`'s native-GSD-pipeline section, the assessor's override reaches the gate via `.planning/STATE.md`/`readState(cwd).depth`, NOT via this `ctx.modelDepthTier` field directly. A PIL Gate feature that wants to reflect assessor upgrades must read state the same way `mutation-gate.ts` does, not just `ctx.modelDepthTier`.
10. **Fire-and-forget budget log (`appendPilLog`) must never be awaited** (`pipeline.ts:263-279`, explicit comment "never await on the hot path") — any new instrumentation added alongside it should follow the same non-blocking `.catch()` pattern, using `logEeFailure`/`classifyEeError` for error classification (No-Silent-Catch rule compliance).


## src/gsd/ — Native GSD depth pipeline (detail)

One-line purpose: `src/gsd/` is the muonroi-native overlay on top of the GSD SDK (gsd-core, dispatched via `gsd-dispatch.ts`/`gsd-runtime.ts`, not in scope here) — it owns depth-tiered plan/verify councils, the STATE.md-keyed mutation gate, and the `gsd_*` agent tools, while gsd-core owns capability registry, hook resolution, and `.planning/` templates.

### The 5-stage native depth pipeline

1. **Complexity assessor** — `src/gsd/complexity-assessor.ts:80 assessComplexity()`. Called from `src/orchestrator/message-processor.ts:675` (inside `isComplexityAssessorEnabled()` guard, line 673) with `priorDepth = pilCtx.modelDepthTier ?? pilCtx.complexityTier ?? "standard"` (message-processor.ts:665). A leader-tier single-shot call enriches/overrides that depth. Note: message-processor.ts:667 has a stray `\` in place of `//` on the comment line above the call — cosmetic, harmless (not executed as code, just a malformed comment), but worth fixing if touching that block.
2. **Council context** — `src/gsd/council-context.ts:138 buildCouncilContextBundle()` folds `ASSESSMENT.md` (assessor's rationale) + `CONTEXT.md` + `RESEARCH.md` + prior `PLAN-REVIEW.md` concerns + `PLAN.md` acceptance criteria into one bundle consumed by BOTH plan-council (`plan-council.ts:209`) and verify-council (via `verify-context.ts:buildVerifyContextBundle`, which wraps this same bundle — see `verify-council.ts:74`).
3. **Directive** (layer4, NOT in `src/gsd/` — lives in `src/pil/layer4-gsd.ts`, out of scope for this map but referenced for completeness): emitted during PIL prep, keyed on the **layer1 classify depth**, not the assessor-adjusted depth. heavy → mandatory gate language; standard → advisory; quick → none.
4. **Mutation gate** — `src/gsd/mutation-gate.ts:26 evaluateMutationGate()`. Wired at `src/orchestrator/tool-engine.ts:1092` inside the tool-engine's write-mutex wrapper, guarding every non-read-only, non-`respond_` tool (tool-engine.ts:1087-1089). Reads depth via `readState(cwd).depth` (mutation-gate.ts:33) — **never** from a caller-passed value — so STATE.md is the single source of truth. Only **explicit `"heavy"`** depth arms the gate (`quick`/`standard`/`null` all pass — mutation-gate.ts:42).
5. **Verify layer** — `gsd_verify` tool body in `src/gsd/workflow-tools.ts:198-278`. Deterministic floor (`passed`/`evidence` from caller) gates first; if it passed AND depth !== "quick", `runVerifyCouncil` (`src/gsd/verify-council.ts:68`) adjudicates goal-achievement and its verdict **overrides** `effectivePassed` (workflow-tools.ts:222-245). Parse failure inside `runVerifyCouncil`'s debate path forces `"revise"`, never silent approve (`verify-council.ts:85-97`).

### Depth flow — single source of truth

`readState(cwd).depth` (`workflow-engine.ts:147-159`, reading the `| Depth | ... |` row of `.planning/STATE.md`'s task-level extension table) is what every downstream consumer (mutation gate, `canExecute`, `gsd_status`, plan-council perspective selection) reads. It is written by `syncWorkflowContext(cwd, sessionModelId, depth)` (`workflow-engine.ts:245-249`), called once per turn from `message-processor.ts:702`, AFTER the assessor has had a chance to override `depth` (step 1 above). `setStateField` (`workflow-engine.ts:161-197`) is the only writer; it also calls `invalidateGsdCache(cwd)` (line 195) so the gsd-dispatch subprocess cache (keyed on STATE.md mtime) doesn't serve stale data.

### File-by-file table

| File | Purpose | Key exports (signatures) | Reads / Writes | LLM vs deterministic |
|---|---|---|---|---|
| `complexity-assessor.ts` | Leader-tier depth override + auto-council decision | `shouldAssess(priorDepth: string, confidence: number): boolean` (L29); `assessComplexity(input: AssessInput): Promise<AssessResult>` (L80) | Writes `.planning/ASSESSMENT.md` via `writeAssessment()` (L50-73, only on success) | LLM (via `input.runAssessor`), never-throws wrapper |
| `assessment-schema.ts` | Parses the assessor's `complexity-verdict` JSON | `ComplexityVerdictSchema` (zod, L20-24); `extractComplexityVerdict(raw: string): ComplexityVerdict \| null` (L38); `ASSESSMENT_OUTPUT_CONTRACT` (L99, prompt suffix) | none (pure parse) | deterministic parse of LLM output |
| `mutation-gate.ts` | Blocks mutation tools at heavy depth until plan-review passes | `evaluateMutationGate(cwd: string, opts: {toolName, hardGateEnabled, directAnswer?}): MutationGateDecision` (L26) | Reads `readState(cwd).depth`; delegates to `canExecute` (workflow-engine.ts) which reads `PLAN-VERIFY.md` | deterministic |
| `plan-council.ts` | Plan review — TWO execution paths (debate vs perspective) | `runPlanCouncil(opts: PlanCouncilOpts): Promise<PlanCouncilResult>` (L187); `taskToPerspectiveRunner(...)` (L331) | Reads `PLAN.md`; writes `PLAN-REVIEW.md` + `PLAN-VERIFY.md`; calls `setStateField`/`advancePhase` via `applyVerdict` (L175-185) | LLM (debate or perspective) + heuristic fallback |
| `plan-council-prompts.ts` | Perspective roster + prompt builders for plan-council | `PLAN_PERSPECTIVES` (L13, 5 roles); `perspectivesForDepth(depth): PlanPerspective[]` (L41); `buildPerspectivePrompt(...)` (L49); `buildDebateTopic(planBody, bundle): string` (L77) | none (pure string building) | n/a |
| `verify-council.ts` | Post-implementation goal-achievement adjudication — TWO paths (debate vs perspective) | `runVerifyCouncil(opts: VerifyCouncilOpts): Promise<VerifyCouncilResult>` (L68) | Reads via `buildVerifyContextBundle`; writes `VERIFY-COUNCIL.md` (`writeArtifact`, L41-61) | LLM (debate or perspective) |
| `verify-council-prompts.ts` | Perspective roster + prompts for verify-council | `VERIFY_PERSPECTIVES` (L13, 4 roles); `verifyPerspectivesForDepth(depth): VerifyPerspective[]` (L40); `buildVerifyPerspectivePrompt`, `buildVerifyDebateTopic` (L62, L76) | none | n/a |
| `verdict-schema.ts` | Model-first verdict parser shared by plan-council (perspective path) and both councils' output contract | `PlanCouncilVerdictSchema` (zod, L22-27); `extractStructuredVerdict(raw: string): PlanCouncilVerdict \| null` (L107); `VERDICT_OUTPUT_CONTRACT` (L137) | none | deterministic parse |
| `council-context.ts` | Builds the shared "prior GSD state" bundle fed to both councils | `buildCouncilContextBundle(cwd, opts: {depth, revisionCycle?}): CouncilContextBundle` (L138); `renderCouncilContextBlock(bundle, opts?): string` (L90); `extractAcceptanceCriteria`, `extractPriorConcerns` (L45, L64) | Reads `CONTEXT.md`, `RESEARCH.md`, `PLAN.md`, `PLAN-REVIEW.md`, `ASSESSMENT.md`, `readState`, `readWorkflowKind` | deterministic |
| `workflow-engine.ts` | STATE.md read/write, phase + gate logic | `readState(cwd): WorkflowState` (L147); `setStateField(cwd, field, value): WorkflowState` (L161); `canExecute(cwd, depth)` (L227); `canShip(cwd, depth)` (L88); `syncWorkflowContext(cwd, sessionModelId, depth)` (L245); `buildGsdStatusPayload` (L120); `readPlanVerifyVerdict` (L219) | Reads/writes `.planning/STATE.md` (task-level extension table: Phase/Depth/Plan Verified/Workflow Kind); reads `PLAN-VERIFY.md`, `VERIFY.md` | deterministic |
| `workflow-tools.ts` | Registers the 7 `gsd_*` agent-facing tools | `GSD_WORKFLOW_TOOL_NAMES` (L21, 7 names); `registerGsdWorkflowTools(tools, opts: GsdWorkflowToolOpts): ToolSet` (L77); `shouldRegisterGsdTools(depth?)` (L69) | Each tool writes its own artifact (`CONTEXT.md`, `PLAN.md`, `VERIFY.md`) and drives `GsdLoopHost` | Mixed — `gsd_verify` triggers `runVerifyCouncil` (LLM); others deterministic |
| `model-tier.ts` | Resolves which model tier runs council stages | `resolveGsdPremiumModel(sessionModelId): string` (L14, always picks highest tier on the session's provider); `resolveGsdPerspectiveAgent(id): BuiltinSubagentId` (L31, `"research"` → `"explore"`, else `"verify"`); `buildGsdPerspectiveTaskRequest(...)` (L35); `tierOfModel(modelId)` (L50) | none | n/a |
| `loop-host.ts` | Fires gsd-core loop-render-hooks then muonroi overlay handlers per lifecycle point | `class GsdLoopHost` (L56) with `firePoint`, `onDiscussComplete`, `onPlanWritten`, `onPlanReviewComplete`, `onExecuteStart/Complete`, `onVerifyComplete`, `onShipComplete`; `getGsdLoopHost(): GsdLoopHost` (singleton, L284); `loopHostContext(...)` (L299) | Delegates writes to overlay handlers (`registerDefaultOverlays`, L162-270) which call `setStateField`/`advancePhase`/`runPlanCouncil`/`runTaskShip` | orchestrates both LLM (plan:post → council) and deterministic phase-advance |
| `flags.ts` | Env-flag gates for the whole native pipeline | `isGsdNativeEnabled()` (L6); `isComplexityAssessorEnabled()` (L16); `isGsdHardGateEnabled()` (L26) | reads `process.env` only | deterministic |
| `config-bridge.ts` | Bootstraps `.planning/` + resolves per-role models | `ensurePlanningWorkspace(cwd, sessionModelId): string` (L92); `buildPlanningConfig(sessionModelId): PlanningConfig` (L51); `readPlanningConfig(cwd)` (L109) | Writes `.planning/config.json` + default `.planning/STATE.md` (`DEFAULT_STATE_MD`, L64-90) if absent | deterministic |
| `paths.ts` | Path helpers for `.planning/` | `planningRoot`, `planningArtifact`, `planningPhasesRoot`, `listPhaseDirs`, `latestPhaseDir`, `phaseDirPath` | reads `.planning/phases/` dir listing | deterministic |
| `index.ts` | Barrel re-export for the whole `src/gsd/` package | re-exports from every file above; notably `getGsdLoopHost` is re-exported from `./host-adapter.js` (L20), NOT directly from `loop-host.js` | n/a | n/a |
| `host-adapter.ts` (referenced, not in original list but load-bearing) | `@deprecated` thin backwards-compat facade (`class GsdHostAdapter`, L7) wrapping `GsdLoopHost.firePoint`; re-exports `GsdLoopHost`/`getGsdLoopHost` from `loop-host.js` (L36) | `dispatch(point, ctx): Promise<boolean>`; `registeredPoints()`; `contractPoints()` | none directly | n/a |
| `types.ts` (referenced) | `GsdPhase` union + keyword-based phase detection | `GSD_PHASES` (L1); `detectGsdPhase(text): GsdPhase \| null` (L41, priority-ranked keyword scan; `debug` outranks `execute`/`verify`, L32-39) | none | deterministic |

### complexity-assessor.ts in detail

- `AssessInput` (L7-16): `{ cwd, raw, priorDepth: "quick"|"standard"|"heavy", confidence: number, conversationDigest?, eeContext?, sessionModelId, runAssessor?: (prompt) => Promise<string> }`.
- `AssessResult` (L17-24): `{ depth, autoCouncil: boolean, rationale: string, assessed: boolean, source: "assessor"|"prefilter-skip"|"parse-failed-fallback", assessmentPath? }`.
- `shouldAssess(priorDepth, confidence)` (L29-32): returns `true` unconditionally when `priorDepth === "standard" || "heavy"`; for `"quick"` it only assesses when `confidence < CONFIDENCE_FLOOR` (`0.7`, L26). This is the prefilter — trivial high-confidence quick turns skip the leader call entirely (no LLM cost).
- `buildAssessorPrompt(input)` (L34-48): concatenates a fixed router-persona preamble, the fast classifier's `priorDepth`+`confidence`, optional `conversationDigest`, optional `eeContext`, the raw task text, then appends `ASSESSMENT_OUTPUT_CONTRACT` (from assessment-schema.ts) demanding a fenced ` ```complexity-verdict ` JSON block.
- **Never-throws / fail-open contract**: every failure mode degrades to `{ depth: input.priorDepth, autoCouncil: false, rationale: "", assessed: false, source: "parse-failed-fallback" }` (or `"prefilter-skip"` when skipped) — see the three `catch` blocks at L91-100 (runner threw), L102-111 (no structured verdict extracted), L123-131 (finalize/leader-resolution failed). It NEVER fabricates a depth different from `priorDepth` on failure.
- `source` values: `"assessor"` (successful override, verdict parsed + `ASSESSMENT.md` written), `"prefilter-skip"` (shouldAssess returned false, or no `runAssessor` supplied — e.g. offline/test path), `"parse-failed-fallback"` (assessor ran but something downstream failed).
- On success, `writeAssessment()` (L50-73) calls `ensurePlanningWorkspace` then writes `.planning/ASSESSMENT.md` with `depth`, `autoCouncil`, `leader` model id, and `rationale`.

### mutation-gate.ts in detail

- `evaluateMutationGate(cwd: string, opts: { toolName: string; hardGateEnabled: boolean; directAnswer?: boolean }): MutationGateDecision` where `MutationGateDecision = { blocked: boolean; reason: string }` (L1-6, L26-49).
- Early-outs to `allow` (not blocked) when: `!opts.hardGateEnabled`, `opts.directAnswer` is true, or `isNeverGated(opts.toolName)` (L31).
- `NEVER_GATED` set (L9): `read_file`, `grep`, `glob`, `bash_output_get`, `gsd_status`. `NEVER_GATED_PREFIXES` (L8): `"gsd_"`, `"respond_"` — so ALL `gsd_*` tools (including `gsd_plan`, `gsd_execute` etc.) and all `respond_*` tools are always exempt from the gate, regardless of depth.
- **HEAVY-only arming**: reads `readState(cwd).depth` (L33) and returns `allow` unless `depth === "heavy"` exactly (L42: `if (!depth || depth === "quick" || depth === "standard") return allow;`). `null`/missing STATE, `"quick"`, and `"standard"` all fail OPEN by design — the code comment explicitly calls out that hard-blocking every default-tier (standard) mutation would over-reach.
- When depth is `"heavy"`, delegates to `canExecute(cwd, depth)` from `workflow-engine.ts:227` (L43) — this is the SDK's own gate (no reimplementation): it requires `readPlanVerifyVerdict(cwd) === "pass"` and, at non-quick depth, that `STATE.md` phase is `"execute"`.
- Wrapped in try/catch (L32-48): any exception (e.g. corrupt `.planning/`) fails OPEN with a logged error — a broken planning dir must never brick the turn.
- `GATE_DIRECTIVE` (L14-17) is the `reason` string returned to the agent when blocked, instructing it to call `gsd_status` → `gsd_discuss` → `gsd_plan` → `gsd_plan_review`, or `gsd_execute({force:true})` to override.
- Called from `src/orchestrator/tool-engine.ts:1092` inside a wrapped `tool.execute` for every tool that is NOT in `READ_ONLY_TOOLS` and does NOT start with `respond_` (tool-engine.ts:1087-1089); `hardGateEnabled` comes from `isGsdHardGateEnabled()` (flags.ts).

### plan-council.ts + verify-council.ts — the two paths

Both modules implement the SAME two-path pattern:

- **Debate path** (`opts.runDebate` present) — a single call to a council-debate synthesis function (external `runCouncilV2`-style debate, not in `src/gsd/`), whose final text is parsed once via `extractStructuredVerdict` (verdict-schema.ts). **This is the production wiring** — `plan-council.ts:207` comment states "production wiring: runCouncilV2 synthesis"; `workflow-tools.ts` passes `opts.runDebate` straight through from `GsdWorkflowToolOpts.runDebate` into both `runPlanCouncil` (via `loopHostContext`) and `runVerifyCouncil` (workflow-tools.ts:234). Parse failure on this path forces `verdict = "revise"` (plan-council.ts:220-228; verify-council.ts:85-97) — never silently approves.
- **Perspective path** (`opts.runPerspectiveFn` present, no `runDebate`) — `Promise.all` over N independent perspective sub-agent calls (plan-council.ts:300; verify-council.ts:117-140), each producing its own verdict, merged by `mergeVerdict` (worst-wins: any `"block"` → block, else any `"revise"` → revise, else `"pass"`/`"approve"`→pass; plan-council.ts:136-140, verify-council.ts:35-39). This path is exercised by tests (heuristic fallback available when no runner supplied at all — `heuristicReview`, plan-council.ts:67-92 — regex/length heuristics over `PLAN.md` text, used only when there's no LLM runner).
- `perspectivesForDepth(depth)` (plan-council-prompts.ts:41-47): `quick` → `[]` (council skipped entirely); `standard` → `research` + `skeptic` only; `heavy` → all 5 (`architect`, `skeptic`, `research`, `security`, `implementer`, defined at plan-council-prompts.ts:13-39).
- `verifyPerspectivesForDepth(depth)` (verify-council-prompts.ts:40-44): `quick` → `[]`; `standard` → `acceptance` + `correctness`; `heavy` → all 4 (`acceptance`, `correctness`, `regression`, `security`, defined at verify-council-prompts.ts:13-37).
- `extractStructuredVerdict(raw)` (verdict-schema.ts:107-134): tries, in order, the last-valid ` ```council-verdict ` fence → last-valid ` ```json ` fence → last-valid unlabeled fence → last-valid brace-balanced bare `{...}` substring (string/escape-aware scan via `findBareObjects`, verdict-schema.ts:57-90). Returns `null` on total failure — callers MUST treat `null` as parse-failed, never as approve.

### assessment-schema.ts detail (the DRY duplication note)

- `extractComplexityVerdict(raw)` (assessment-schema.ts:38-61) mirrors `verdict-schema.ts`'s `extractStructuredVerdict` algorithm exactly (same fence-priority-bucket + brace-scan strategy) but is a **separate, self-contained copy** — the module docstring (assessment-schema.ts:6-9) explicitly states: *"verdict-schema.ts does not export its fence/brace helpers, so this module stays self-contained with the same algorithm under the complexity-verdict label"*. Confirmed: `verdict-schema.ts` exports only `PlanCouncilVerdictSchema`, `extractStructuredVerdict`, `VERDICT_OUTPUT_CONTRACT` — its `findFencedBlocks`/`findBareObjects`/`tryJson` are module-private (verdict-schema.ts:46, 57, 92), not exported. This is a known, deliberate duplication (2 near-identical brace-scanners) — a future DRY refactor would need to export the scanner or extract a shared `fence-scan.ts`.
- `findBareObjects` in assessment-schema.ts (L64-97) is string/escape-aware: tracks `inStr`/`esc` state so braces inside a quoted `"rationale"` string value don't corrupt the depth count (assessment-schema.ts:78-84) — same logic as verdict-schema.ts:66-90 (byte-for-byte algorithm parity, different file).

### Env flags (flags.ts)

| Flag | Function | Default | Effect when set to `0`/`false` |
|---|---|---|---|
| `MUONROI_GSD_NATIVE` | `isGsdNativeEnabled()` (L6-10) | ON | Disables native GSD entirely — no `gsd_*` tools registered (`registerGsdWorkflowTools` early-returns, workflow-tools.ts:78), legacy playbook rubric used instead |
| `MUONROI_GSD_ASSESSOR` | `isComplexityAssessorEnabled()` (L16-19) | ON (only if native also ON) | Skips the leader-tier `assessComplexity` call; depth comes only from layer1 classify (message-processor.ts:673 guard) |
| `MUONROI_GSD_HARD_GATE` | `isGsdHardGateEnabled()` (L26-29) | ON (only if native also ON) | `evaluateMutationGate` always returns `allow` (tool-engine.ts passes `hardGateEnabled: false`); layer4 directives become advisory-only |

All three check truthiness via exact string `"0"` or case-insensitive `"false"` (only `MUONROI_GSD_NATIVE` does the `"false"` check explicitly at L8; the other two just check `!== "0"`).

### Gotchas for a future implementer (PIL Gate expansion / new critic module)

1. **Depth source of truth is STATE.md, not pilCtx.** Any new "PIL Gate" stage must read `readState(cwd).depth` (workflow-engine.ts:147) if it needs to act mid-turn after the assessor has run — do NOT thread a separate depth value through pilCtx, or you'll reintroduce the exact staleness bug the mutation-gate design doc (mutation-gate.ts:19-25) explicitly calls out.
2. **`gsd_*` and `respond_*` tools are permanently gate-exempt** (mutation-gate.ts:8-12). A new critic module that needs to intercept `gsd_plan`/`gsd_execute` etc. cannot rely on the mutation gate — it must hook `workflow-tools.ts` directly (e.g. inside `registerGsdWorkflowTools`, workflow-tools.ts:77) or a new `GsdLoopHost` overlay point (loop-host.ts:162, `registerDefaultOverlays`).
3. **Hard gate is heavy-only by design decision, not oversight** — extending it to standard would be a deliberate policy change requiring updating the comment block at mutation-gate.ts:34-41 and likely a new env flag rather than silently tightening `evaluateMutationGate`.
4. **Two structurally-identical but separately-maintained verdict parsers** exist (`verdict-schema.ts` for plan/verify councils, `assessment-schema.ts` for the complexity assessor). A new critic that emits a third verdict shape should decide explicitly whether to reuse one of these (requires exporting the brace-scanner) or add a third copy — check with the DRY note before choosing.
5. **`getGsdLoopHost` re-export ambiguity**: `index.ts:20` re-exports `getGsdLoopHost`/`GsdLoopHost` from `./host-adapter.js`, but `host-adapter.ts:36` itself just re-exports from `./loop-host.js` — there is exactly one singleton instance (`loop-host.ts:282-287`, module-level `_defaultHost`). `GsdHostAdapter` (host-adapter.ts:7) is a `@deprecated` thin facade some legacy caller may still use — don't add new logic there, extend `GsdLoopHost` directly.
6. **Perspective vs debate path selection is caller-driven, not depth-driven** — `runPlanCouncil`/`runVerifyCouncil` pick the path based on which of `opts.runDebate` / `opts.runPerspectiveFn` is passed in, not on `depth` itself. Production (`workflow-tools.ts:161-163, 233-235`) always passes `opts.runDebate` when available, so the perspective/`Promise.all` path is effectively test-only/fallback today — a new critic module that assumes perspectives always run in parallel in prod would be wrong.
7. **Never-silently-approve is a hard invariant** across both councils and the assessor: `null`/parse-failure always degrades to the SAFER outcome (`revise` for councils, `priorDepth` unchanged for the assessor) — repo-wide "No Silent Catch" rule (CLAUDE.md) applies doubly here since a silent approve would let unreviewed code ship.
8. **`ASSESSMENT.md` is consumed downstream by `council-context.ts:145`** (capped to 600 chars in the rendered block, council-context.ts:112-114) — if a new PIL Gate stage changes the assessor's output shape, the council context renderer must be updated too or context will silently truncate/misrender.
9. **`CONFIDENCE_FLOOR = 0.7`** (complexity-assessor.ts:26) is the single knob controlling how often the assessor fires on `"quick"`-classified turns — tuning this trades LLM cost against catching low-confidence misclassifications; it does not affect `"standard"`/`"heavy"` turns (those always assess, complexity-assessor.ts:30).


## src/orchestrator/ — turn orchestration (detail)

One-line purpose: `src/orchestrator/` owns the per-turn lifecycle — PIL enrichment → GSD depth sync → per-turn model routing → tool-set assembly (with the mutation gate) → `streamText` — for both the interactive TUI (`MessageProcessor.run`) and non-interactive batch runs (`batch-turn-runner.ts`).

### Turn lifecycle (top-level flow)

1. `MessageProcessor.run()` (`message-processor.ts:488`, a generator method) is the entry point per user message.
2. It calls `prepareTurnContext(deps, userMessage, _budgetOverride)` (`preprocessor.ts:17`, itself an async generator) at `message-processor.ts:649`. This wraps `runPipeline()` (`../pil/pipeline.js`) which does the actual PIL layer classification/enrichment, plus discovery Q&A round-trips (yielded as `council_question` StreamChunks) and the Phase-4 step-ceiling resolution.
3. `message-processor.ts` drains `prepGen` in a `while(true)` loop (lines 651-658), re-yielding any StreamChunks (e.g. discovery questions) up to the outer caller (TUI/CLI), until `res.done` gives the final `PreprocessorResult`.
4. `pilCtx` is destructured out of that result (line 659) and drives everything downstream: the GSD native gate block (661-706), chitchat/tool-skip decisions (716, 861ff in tool-engine.ts), per-turn router `decide()` call (832-906), and — finally — the actual model message text (assembled at line 984).
5. Tool-set assembly + the mutation gate wrapping happens in `tool-engine.ts` (`executeToolEngine`, called later in `message-processor.ts`'s `run()`), which builds `createBuiltinTools(...)`, merges MCP tools, applies the top-level tool-budget cap, wraps non-read-only tools with the write-mutex + `evaluateMutationGate`, and finally calls `streamText` (in `stream-runner.ts`, invoked from tool-engine).

### message-processor.ts — region ~640-1000 (CRITICAL for the PIL Gate feature)

Exact ordering, with line numbers as of this session (2026-07-05, branch `feat/core-ui-separation-and-semantic-primitives`):

- **L649-658**: `prepGen` drain loop. `prepResult` is only assigned once `res.done` is true; every earlier yielded value is a `StreamChunk` re-yielded upward (discovery `council_question` chunks).
- **L659**: `const { pilCtx, _stepCeiling, _pilStart, _naturalCeiling, _ceilingTaskType, _ceilingSize } = prepResult!;` — **this is the single point where `pilCtx` first exists in scope.** `pilCtx` is a mutable object reference (type `Awaited<ReturnType<typeof runPipeline>>`, exported as `PreprocessorResult["pilCtx"]` in `preprocessor.ts:9`) — later mutation (line 692) is visible everywhere else that closes over the same `pilCtx` reference in this `run()` call.
- **L661-706**: the **GSD native gate block** — see full breakdown below. This runs **before** `pilCtx.enriched` is read (L717) and before the model message is built (L984). It only mutates `pilCtx.modelDepthTier` (L692) and `pilCtx.gsdAutoCouncil` (L693); it does not touch `pilCtx.enriched`/`pilCtx.raw`.
- **L716**: `const isChitchat = pilCtx.intentKind === "chitchat";` — first read of `pilCtx.intentKind` for downstream tool-skip logic (also read again inside `tool-engine.ts`).
- **L717**: `let enrichedMessage = pilCtx.enriched;` — **first consumption of `pilCtx.enriched`**, i.e. the PIL-enriched prompt text. This happens strictly AFTER the gate block (L661-706) has already run and (if applicable) overwritten `pilCtx.modelDepthTier`.
- **L718-723**: if `pilCtx.fallbackReason` is set, `enrichedMessage` gets a `[PIL fallback: ...]` prefix so the model knows PIL degraded (200ms timeout / discovery timeout / classifier throw).
- **L724-729**: `deps.setPilActive(...)`, `deps.setPilEnrichmentDelta(...)` — status-bar / telemetry side effects, read `pilCtx.taskType` and `pilCtx.metrics`.
- **L736-765**: phase-boundary tracking (`phaseTracker.setPhase(pilCtx.gsdPhase ?? null)`) — fires `fireAndForgetPhaseOutcome` when a phase just ended; wrapped in its own try/catch (L763, "fail-open: phase-outcome must never block a turn").
- **L779-818**: interaction logging (`logInteraction(..., "pil", ...)` and `"user_message"`) — reads many `pilCtx.*` fields for telemetry; wrapped in its own try/catch (L816, "fail-open").
- **L820-906**: `ROUTE-11` per-turn model routing — calls `decide()` from `../router/decide.js` (dynamic import at L832), passing `pil: { domain: pilCtx.domain, taskType: pilCtx.taskType, confidence: pilCtx.confidence, gsdPhase: pilCtx.gsdPhase ?? null, activeRunId: pilCtx.activeRunId ?? null, recentTurnsSummary: deps.buildRecentTurnsSummary(), ... }`. Wrapped in try/catch (L900) that falls back to `routeModel()` EE fallback on router failure.
- **L977-984**: **model message assembly.** `cwdNote` (E4 one-shot cwd-change note) is prepended to both `messageForDb` (raw `userMessage`) and `messageForModel`. `rawSuffix` (L983) appends `pilCtx.raw` verbatim if it differs from `enrichedMessage`, so the model can see PIL's original raw input alongside the enrichment. **L984 is the exact line where the final model-bound text (`messageForModel`) is composed** — this is downstream of both the gate block and the enrichment consumption; any PIL Gate feature that needs to inject content into the outgoing model message must land before this line (or mutate `pilCtx.enriched` before L717).
- **L986-1004**: wraps `messageForDb`/`messageForModel` into `ModelMessage` objects (`userModelMessage` for history, `userEnrichedMessage` for the actual `streamText` call), handling the image-parts case.

**Implication for a "PIL Gate" feature**: if the gate needs to block/alter the turn based on GSD depth or plan-review state, it must do so inside or immediately after the L661-706 block (before L717 consumes `enriched`) — mutating `pilCtx` there is the only way for the change to reach both the model message (L984) and the tool-engine's mutation gate (`tool-engine.ts:863`, which independently reads `pilCtx.modelDepthTier`).

### Inner vs outer try/catch structure around the gate block (fail-open boundaries)

There is no enclosing try/catch around the whole L640-1000 region from an outer caller in `message-processor.ts` — `run()` is a single flat generator method (no top-level try wrapping the body); each concern manages its own fail-open boundary:

1. **Outer catch of the gate block** — `message-processor.ts:661-706`:
   ```
   if (isGsdNativeEnabled() && pilCtx.intentKind !== "chitchat") {
     try {                                   // L662
       ...
       if (isComplexityAssessorEnabled()) {
         try { ... }                          // L674 — INNER catch
         catch (assessErr) { ... }             // L694-698
       }
       getGsdLoopHost().ensureHost(cwd, sessionModel);   // L701
       syncWorkflowContext(cwd, sessionModel, depth);    // L702
     } catch (err) {                           // L703-705 — OUTER catch
       console.error(`[gsd-loop-host] turn sync failed: ...`);
     }
   }
   ```
   - **Inner catch (L674-698)** guards only the `assessComplexity()` call. Per the comment at L667-672, `assessComplexity` itself is documented to never throw (all internal steps caught, degrading to `priorDepth`) — this inner catch is defensive belt-and-suspenders. On catch, `depth` simply keeps its fast-classifier value (from `pilCtx.modelDepthTier ?? pilCtx.complexityTier ?? "standard"`, L665) and the assessor's mutation of `pilCtx.modelDepthTier` (L692) never happens.
   - **Outer catch (L703-705)** guards `getGsdLoopHost().ensureHost(...)` (L701) and `syncWorkflowContext(...)` (L702) — i.e. the STATE.md write. If this throws, `pilCtx.modelDepthTier` may have already been overwritten by the assessor (L692) even though the STATE.md sync failed — meaning `pilCtx.modelDepthTree` and `readState(cwd).depth` (read later by `evaluateMutationGate`) can diverge in this specific failure mode. This is a documented fail-open: `console.error` only, no rethrow, no turn abort.
2. Every other side-effect block in this region (phase tracking L736-765, interaction logging L779-818, router L831-906, `_ar?.emitEvent` in `preprocessor.ts:150-158`) has its OWN independent try/catch — none of them share scope with the gate block or with each other. A failure in phase tracking, for instance, cannot affect the gate block or model-message assembly.

### preprocessor.ts

- `prepareTurnContext(deps: MessageProcessorDeps, userMessage: string, _budgetOverride: any): AsyncGenerator<StreamChunk, PreprocessorResult, unknown>` (`preprocessor.ts:17`).
- Returns `PreprocessorResult` (`preprocessor.ts:8-15`): `{ pilCtx, _stepCeiling, _pilStart, _naturalCeiling, _ceilingTaskType, _ceilingSize }`.
- `llmFallback` (L49-55) and `clarificationProposer` (L60-66) are built via dynamic imports from `deps.requireProvider()` + `deps.modelId` — PIL itself stays provider-agnostic; these are passed into `runPipeline(...)` (L68-76) as `llmFallback` / `clarificationProposer` callbacks. Both wiring attempts are individually try/caught (`logger.error("pil", ...)`) so a provider-construction failure degrades PIL to non-LLM layers rather than aborting the turn.
- `recentTurnsSummary: deps.buildRecentTurnsSummary()` (L75) is also passed into `runPipeline` — same function later reused by the router `decide()` call in `message-processor.ts:852`.
- The whole `runPipeline` call is wrapped in an outer try/catch (L45-96) inside the `pilTask` IIFE; on catch, `pilCtxResolved` is set to a fully-degraded stub object (L78-92: `taskType: null, domain: null, confidence: 0, intentKind: null, fallbackReason: "orchestrator-catch:<ErrorName>"`).
- **Continuation-phrase → chitchat classification note (L118-134)**: PIL Layer 1 Pass 0 classifies continuation phrases ("tiếp tục" / "continue") as `general/chitchat`. Resolving the step-ceiling directly from that label would collapse the budget to `general × small = 5` — wrong, since the user actually wants to RESUME the prior (larger) task. Fix: when `_pilTaskType === "general" && pilCtx.intentKind === "chitchat"` and the session has a recorded non-chitchat last-task row (`getSessionLastTask`, from `scope-ceiling.ts`), the ceiling resolution (`_ceilingTaskType`/`_ceilingSize`) borrows that row instead — but `pilCtx.intentKind` itself is left as `"chitchat"` so downstream code (style selection, the chitchat tool-skip, "BUG-A guard" in tool-engine.ts) still sees the correct intent. Only the ceiling-row selection is borrowed, nothing else.
- Session task memory: `recordSessionLastTask(_sessionIdForLastTask, _pilTaskType, _pilSize)` (L143) only fires on real (non-chitchat) `intentKind === "task"` turns, so a continuation itself never overwrites the remembered task.

### orchestrator.ts

- `_buildRecentTurnsSummary()` (`orchestrator.ts:3298-3329`, private method): guards `this.messages.length < 2` → returns `null` (line 3299). Otherwise takes `this.messages.slice(-6)` (last 6 messages, any role among user/assistant/tool), extracts text per role (tool results are stringified/joined), truncates each to 300 chars (`text.length > 300 ? text.slice(0,297)+"..." : text`, line 3325), and joins as `"[role]: snippet | [role]: snippet | ..."`. Wired to deps at `orchestrator.ts:3237`: `buildRecentTurnsSummary: () => self._buildRecentTurnsSummary()`. Consumed in `preprocessor.ts:75` (passed into `runPipeline`) and `message-processor.ts:852` (passed into router `decide()`'s `pil.recentTurnsSummary`).
- `createCouncilLLM` wiring: imported dynamically in 3 places — `orchestrator.ts:1945` + `:2103` (both `const { createCouncilLLM } = await import("../council/llm.js")`, used to build council/product-loop LLM instances via `createCouncilLLM(this.bash, this.mode, this.session?.id, stats)`), and `message-processor.ts:419` inside `buildLeaderAssessorRunner` (below). Definition: `src/council/llm.ts:341`.
- `depthTier` reaching `createBuiltinTools` in `tool-engine.ts`: NOT set in `orchestrator.ts` — the resolution happens entirely inside `tool-engine.ts` (see below). `orchestrator.ts` has no `depthTier`/`modelDepthTier` references at all; it only supplies `pilCtx` through the deps chain to `tool-engine.ts`.

### buildLeaderAssessorRunner (message-processor.ts:414-427)

```ts
function buildLeaderAssessorRunner(deps: MessageProcessorDeps, sessionModel: string): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const { createCouncilLLM } = await import("../council/llm.js");
    const { resolvePlanCouncilLeader } = await import("../council/leader.js");
    const leader = await resolvePlanCouncilLeader(sessionModel);
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM(deps.bash, deps.mode, deps.session?.id, stats);
    return llm.generate(leader.modelId, "You are a task complexity assessor.", prompt, 512); // 512-token budget
  };
}
```
This is the `runAssessor` callback passed into `assessComplexity({...})` at `message-processor.ts:682` — a single-shot leader-tier LLM call (billed `source=council`, per CLAUDE.md, "no cost leak"), NOT a full council debate.

### tool-engine.ts — depthTier resolution + write-mutex + mutation gate

- **L863-870**: `depthTier` resolution precedence — `pilCtx.modelDepthTier ?? pilCtx.complexityTier ?? "standard"`. This is the SAME precedence expression used as the fast-classifier fallback default at `message-processor.ts:665` (`let depth = pilCtx.modelDepthTier ?? pilCtx.complexityTier ?? "standard"`), so if the L661-706 gate block ran and mutated `pilCtx.modelDepthTier` (L692), `tool-engine.ts:863` picks up the SAME assessed value — this is exactly the invariant the L685-691 comment describes ("Keep the native depth slot authoritative ... so every downstream consumer ... sees the SAME value").
- **L871-892**: `createBuiltinTools(deps.bash, deps.mode, { ..., modelId: turnModelId, depthTier, sessionId: deps.session?.id, includeVisionTools, ... })` — `depthTier` is passed straight through as a builtin-tools construction option (used to gate/tier gsd_* tool registration downstream, per CLAUDE.md's GSD pipeline doc).
- **L1053-1054**: `const writeMutex = new SimpleMutex();` — turn-scoped mutex (class defined at `tool-engine.ts:458`) to serialize non-read-only tool execution and prevent race conditions during parallel tool calls within one turn.
- **L1055-1073**: `READ_ONLY_TOOLS` allowlist (read_file, grep, bash_output_get, process_list, delegation_read/list, ee_query, ee_health, usage_forensics, lsp_query, setup_guide, selfverify_*, list_vision_cache, ee_feedback, ee_write) — these tools are NEVER wrapped by the mutex or the mutation gate.
- **L1079-1080**: `gsdHardGateEnabled = isGsdHardGateEnabled()` (from `../gsd/flags.js:26`) and `gsdDirectAnswer = pilCtx.directAnswer` are read ONCE per turn (not per tool call) — comment at L1075-1078 explains: these two flags don't change mid-turn, but `evaluateMutationGate` itself re-reads STATE.md per call so it "stays live if the model advances phase/verdict mid-turn via gsd_* tools."
- **L1082-1103**: the write-mutex + mutation-gate wrapper loop — for every tool name in the assembled `tools` set that (a) has an `execute` function, (b) is NOT in `READ_ONLY_TOOLS`, and (c) does not start with `"respond_"`, `tool.execute` is monkey-patched: it first calls `evaluateMutationGate(deps.bash.getCwd(), { toolName: name, hardGateEnabled: gsdHardGateEnabled, directAnswer: gsdDirectAnswer })` (`../gsd/mutation-gate.js:26`); if `gate.blocked`, it short-circuits to `{ success: false, output: gate.reason, error: gate.reason }` WITHOUT ever running the original tool or acquiring the mutex; otherwise it runs `writeMutex.run(() => originalExecute(input, context))`.
- **`evaluateMutationGate` internals** (`src/gsd/mutation-gate.ts:26-49`): fast-allows if `!hardGateEnabled || directAnswer || isNeverGated(toolName)` (never-gated = `gsd_*`/`respond_*` prefixes + `read_file`/`grep`/`glob`/`bash_output_get`/`gsd_status`, L8-12). Otherwise it reads depth via `readState(cwd).depth` (from `./workflow-engine.js`) — **NOT from the `pilCtx` object passed in `opts`** — the gate is explicitly decoupled from pilCtx propagation and trusts only STATE.md as source of truth (per its own doc comment, L19-25). Fail-open on missing/`quick`/`standard` depth (L42); only `depth === "heavy"` invokes `canExecute(cwd, depth)` (L43) which can actually block. Any thrown error inside is caught (L45-48) and fails open with `console.error`.

### Gotchas

1. **`pilCtx` is read at L716-717 for `isChitchat`/`enrichedMessage` — after — the gate block (L661-706) mutates `pilCtx.modelDepthTier`, but the gate block itself is SKIPPED ENTIRELY when `pilCtx.intentKind === "chitchat"` (L661 condition). So on a classified-chitchat turn, `pilCtx.modelDepthTier` retains whatever `runPipeline()` set it to (or `undefined`), and `tool-engine.ts:863-870`'s fallback chain (`?? pilCtx.complexityTier ?? "standard"`) is what actually resolves depth for that turn — not the assessor.
2. **Divergence window**: if `assessComplexity()` succeeds (mutates `pilCtx.modelDepthTier` at L692) but the immediately-following `syncWorkflowContext()` call (L702) throws (caught at the OUTER L703 catch), `pilCtx.modelDepthTier` is now out of sync with `readState(cwd).depth` in STATE.md. `tool-engine.ts:863` will use the (now-stale-relative-to-disk) assessed value, while `evaluateMutationGate` reads the (unsynced) on-disk value — two different depths for the same turn. This is a known accepted fail-open gap per the code comments, not a bug to "fix" without understanding the intentional fail-open design.
3. **Gate reads STATE.md, not `pilCtx`** — a "PIL Gate" feature that wants to change gating behavior must either (a) go through `syncWorkflowContext` → STATE.md (the only channel `evaluateMutationGate` trusts), or (b) add a new decoupled check; directly mutating `pilCtx.modelDepthTier` alone will NOT affect `evaluateMutationGate`'s decision, only `tool-engine.ts:863`'s `depthTier` passed to `createBuiltinTools`.
4. **`isGsdNativeEnabled()` gates the WHOLE block including `ensureHost`/`syncWorkflowContext`** — if native GSD is off (`MUONROI_GSD_NATIVE=0`), STATE.md is never synced this turn, so `evaluateMutationGate`'s `readState(cwd).depth` will reflect whatever was written on a PRIOR turn (stale) or `null` if never initialized — and `null` fails open per L42 of `mutation-gate.ts`.
5. **Ordering within the outer try (L662-702)**: `getGsdLoopHost().ensureHost(cwd, sessionModel)` (L701) runs BEFORE `syncWorkflowContext` (L702) — both share the same outer catch, so a host-init failure also blocks the STATE.md sync for that turn (no partial application).
6. **`_stepCeiling`/`_naturalCeiling` from `preprocessor.ts` are independent of the GSD depth gate** — they govern the Phase-4 tool-round budget matrix (task×size), a completely separate mechanism from the GSD mutation gate; don't conflate "step ceiling exceeded" with "mutation gate blocked."


## src/council/ — council LLM infrastructure (detail)

### Purpose + billing (one-line)
`src/council/` implements the multi-model council/debate subsystem (clarify → preflight → debate-plan → dynamic debate rounds → synthesis → post-debate askcard). It exposes a reusable `CouncilLLM` (`createCouncilLLM`, `src/council/llm.ts:341`) that ANY subsystem can construct to get billed, timeout-guarded, mock-aware LLM calls with zero extra wiring.

**Billing**: every `generate`/`debate`/`research` call inside the returned `CouncilLLM` calls `recordCouncilUsage(sessionId, modelId, usage)` (`src/council/llm.ts:260-302`) which writes a `usage_events` row with `source="council"` via `recordUsageEvent` (`llm.ts:267`), AND mirrors the five cumulative billing counters (`in_tokens`, `out_tokens`, `cache_read_tokens`, `session_usd`) into the live `statusBarStore` (`llm.ts:279-294`) — explicitly NOT touching `ctx_tokens`/`ctx_pct`/`model`/`provider` (those describe the main-conversation call). This is the SINGLE source of truth for council usage accounting (doc comment `llm.ts:244-259`); before it existed only `loop-driver`'s `runDebate` wrapper recorded usage, so `/council`, auto-council, and every non-debate `/ideal` phase leaked cost invisibly (see project memory `Council Usage Accounting Leak`, session `f24c28b6dcb3`). **Any new caller of `createCouncilLLM` gets this billing for free with NO extra code** — this is the core reuse guarantee for a PIL Gate.

`appendCostLog` (`llm.ts:213-242`, `logCouncilCost`) is a SEPARATE best-effort JSONL cost-log append (`phase: "council"`) — swallow-on-failure, purely for `usage forensics`/cost-log tooling, not the billing source of truth.

---

### `llm.ts` — CRITICAL for reuse

**Signature** (`llm.ts:341-346`):
```ts
export function createCouncilLLM(
  bash: BashTool,
  mode: AgentMode,
  sessionId: string | undefined,
  stats: CouncilStats,
): CouncilLLM
```
Returns a `CouncilLLM` object (`src/council/types.ts:334-366`) with three async methods:

```ts
llm.generate(modelId, system, prompt, maxTokens = 4096, onUsage?, signal?): Promise<string>
llm.debate(modelId, system, prompt, signal?, persistTrace?, options?: {enableVerificationTools?}, onUsage?): Promise<{text, toolCalls}>
llm.research(modelId, topic, conversationContext, signal?, persistTrace?, options?: {internetFirst?}, onUsage?): Promise<string>
```

`generate` is the shape a PIL Gate would use: `.generate(modelId, system, prompt, maxTokens, onUsage, signal)`. See the real-world reuse example already in the codebase — `buildLeaderAssessorRunner` in `src/orchestrator/message-processor.ts:414-427`, which builds a fresh `CouncilLLM` per call with a throwaway local `stats` object and calls `llm.generate(leader.modelId, "You are a task complexity assessor.", prompt, 512)`. Doc comment there (`message-processor.ts:405-413`) states explicitly: *"Mirrors the orchestrator's own council LLM construction ... so the assessor call auto-records usage as source=council (no cost-leak) instead of a bespoke unaccounted call."* — this is the PATTERN a new PIL Gate call site should copy verbatim.

**`bash` / `mode` params**: `bash: BashTool` and `mode: AgentMode` are only consumed by `debate()` (verification tools: `grep`/`read_file` via `createTools(bash, mode)`, `llm.ts:480`) and `research()` (full builtin toolset, `llm.ts:647`). `generate()` never touches them — so a caller that only needs `.generate()` (like a turn-start gate) can pass real `bash`/`mode` if available, or dummies if `generate`-only (test suites do `{} as any, "agent" as any` — `round-tools.test.ts:48` etc.).

**Mock bypass** (`llm.ts:304-319, 356-361, 459-464, 637-642`): checks `globalThis.__muonroiMockLlm` (declared as ambient global `llm.ts:311-313`). When `--mock-llm <fixture>` is set at startup, `getMockLlm()` returns `{ complete(req: {prompt}): Promise<{text}> }`. Each of `generate`/`debate`/`research` checks `getMockLlm()` FIRST and short-circuits: `stats.calls++; const result = await mock.complete({ prompt }); return result.text` (or `{text, toolCalls: []}` for debate). This mirrors the streaming-path hook in `src/providers/adapter.ts`. **A PIL Gate reusing createCouncilLLM automatically gets mock routing for free** — no extra test plumbing needed, as long as tests set `globalThis.__muonroiMockLlm` before calling `.generate()`.

**Timeout / deadline race** (`llm.ts:321-335`):
```ts
const COUNCIL_LLM_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 60_000 && raw <= 1_800_000) return raw;
  return 300_000;
})();
```
Default **300_000 ms (5 min)**, env-overridable in range [60_000, 1_800_000]. Every call wraps the AI-SDK `generateText` in `withTimeoutSignal(signal, COUNCIL_LLM_TIMEOUT_MS)` (from `src/utils/llm-deadline.js`, combines the caller's abort signal with a per-call wall-clock deadline) AND a `withDeadlineRace(fn, COUNCIL_LLM_TIMEOUT_MS + 5_000, label, signal)` outer race (`llm.ts:370-395` for generate, similar for debate/research). Research gets **2x** the timeout, capped at 1.8M ms (`llm.ts:687`: `Math.min(COUNCIL_LLM_TIMEOUT_MS * 2, 1_800_000)`). **A PIL Gate call inherits this same 5-min ceiling** unless it sets `MUONROI_COUNCIL_LLM_TIMEOUT_MS` — a turn-start gate wanting a MUCH tighter budget (e.g. 10s) cannot override this per-call; it is a process-wide env var, not a `createCouncilLLM` parameter. This is a real gotcha: **there is no per-call timeout param** — only the global env override.

**`CouncilStats` threading**: `stats: CouncilStats = { calls: number; startMs: number; phases: Array<{name, durationMs}> }` (`types.ts:311-315`) is passed in by the CALLER (not created internally) and mutated in place — `stats.calls++` fires on every successful (and mock) call across all three methods. `runCouncil` (`index.ts:154`) does `options?.councilStats ?? { calls: 0, startMs: Date.now(), phases: [] }` so the orchestrator can share ONE stats object across multiple `createCouncilLLM` constructions in the same turn (Phase 14 CQ-01, comment at `index.ts:80`). A PIL Gate should create its own throwaway `{ calls: 0, startMs: Date.now(), phases: [] }` per invocation (exactly like `buildLeaderAssessorRunner` does at `message-processor.ts:422`) unless it wants combined stats with an enclosing council run.

**`onUsage` callback**: optional 5th positional param on `generate`, trailing param on `debate`/`research` — fired with `{inputTokens, outputTokens, cachedInputTokens}` right before `recordCouncilUsage`. Used by e.g. sprint-runner to commit real token counts instead of chars/4 estimates. Independent of billing — `recordCouncilUsage` always fires regardless of whether `onUsage` is supplied.

**Debug logging**: `MUONROI_COUNCIL_DEBUG_LOG=<path>` env var makes every call append a JSONL `DebugCallRecord` (`llm.ts:60-95`) with model/provider/char-counts/duration/finishReason/usage/error — off by default, useful for forensics on a new gate too.

**`tracedGenerate` / `tracedAsync`** (`llm.ts:835-1038`): async generators that wrap `llm.generate()` (or arbitrary async work) with `council_status` stream chunks (`start`/`tick`/`done`/`error`) so the TUI can show a live spinner row. Not required for a non-streaming gate but the idiomatic way debate.ts/planner.ts call `llm.generate`.

---

### `leader.ts` — model resolution (Zero-Hardcode compliant)

**`resolvePlanCouncilLeader(sessionModelId: string): Promise<LeaderResolution>`** (`leader.ts:141-164`) — "always premium-tier within session provider (telemetry: plan-council)". This is the function GSD (`complexity-assessor.ts:113`, `plan-council.ts:208,296`, `verify-council.ts:75`) and the message-processor's leader-assessor runner (`message-processor.ts:420-421`) already use — **the canonical entry point for "give me the best model on the user's current provider."**

Returns `LeaderResolution` (`leader.ts:97-103`):
```ts
export interface LeaderResolution {
  modelId: string;
  promotedFrom?: { modelId: string; tier?: string };  // set when auto-promoted
  defaulted?: boolean;                                 // set when no configured leader existed
}
```

Resolution order inside `resolvePlanCouncilLeader`:
1. `sessionProviderId = detectProviderForModel(sessionModelId)` (`leader.ts:142`) — Zero-Hardcode: provider derived from the model id via registry lookup, never a literal.
2. Reachability gate: `isProviderDisabled(...)` (settings) AND `isProviderReachable(...)` (`leader.ts:130-138`, which is `getConfiguredProviders()` — covers BOTH API keys and stored OAuth tokens, not just `loadKeyForProvider`). If unreachable → falls back to `getRoleModel("leader") ?? sessionModelId` (no promotion attempted).
3. If reachable: look for a catalog model on that provider tagged `roles: ["leader"]` via `getModelsForProvider(sessionProviderId).find(m => m.roles?.includes("leader"))` (`leader.ts:149-151`) — catalog-driven, zero hardcode.
4. Else: `resolveGsdPremiumModel(sessionModelId)` from `src/gsd/model-tier.ts` — promotes within the SAME provider only if strictly higher tier (never crosses providers — hard rule stated in the doc comment at `leader.ts:56-60` and mirrored at `leader.ts:105-121`).
5. Falls through to `{ modelId: sessionModelId, defaulted: true }` if nothing better found.

**Hard rule (provider isolation)**: never switch providers when resolving a leader — different billing surface, surprise cost/401s. This applies identically to `resolveLeaderModelDetailed` (the fuller version used by `/council` itself, `leader.ts:166-233`) — `resolvePlanCouncilLeader` is effectively a simplified variant for GSD/plan-council callers that skips the "configured `roleModels.leader`" override logic.

**Failure handling**: `resolvePlanCouncilLeader` never throws under normal conditions (`isProviderReachable`/`getConfiguredProviders` are async DB/keychain reads that can theoretically reject) — callers in the test suite mock a rejection (`complexity-assessor.test.ts:94`: `mockRejectedValueOnce(new Error("uncataloged model id"))`) to verify the caller's OWN fail-open wrapping, meaning **`resolvePlanCouncilLeader` itself provides no built-in try/catch** — a new PIL Gate call site MUST wrap it in its own try/catch (mirroring `pilCtx = await runPipeline(...).catch()` patterns used elsewhere in `index.ts:224-228`).

Also in `leader.ts`: `pickCouncilTaskModel(task, leaderModelId, costAware)` (`leader.ts:69-95`) — downshifts a leader-tier model to a cheaper tier for mechanical sub-tasks (see `SUB_TASK_TIER` table `leader.ts:40-53`) while staying on the SAME provider; `resolveParticipants` / `resolveLeaderModelDetailed` / `hasMultiProviderConfig` / `getEffectiveCouncilRoleCount` are debate-roster-specific and less relevant to a single-model gate.

---

### Debate/round orchestration (`debate.ts`, `debate-planner.ts`)

**`runDebate(spec, config: CouncilConfig, llm): AsyncGenerator<StreamChunk, DebateState>`** (`debate.ts:449-1283`) is the round loop. Key structure:
- Phase 0: optional research (`researchWithFallback`, cross-provider fallback on failure marker `[Research failed:`).
- **Phase 1 — opening statements run in PARALLEL**: `const openingPromises = participants.map(...)` then `yield* tracedAsync(() => Promise.all(openingPromises), ...)` (`debate.ts:562-587`) — confirmed parallel via `Promise.all`, each wrapped in `openingWithRetry` (3 attempts, linear backoff, `debate.ts:251-274`).
- **Phase 2 — discussion rounds**: pairs of participants (`pairs.map(...)`) also run **in PARALLEL per round** via `Promise.all` inside `tracedAsync` (`debate.ts:725-899`) — every pair's `debateWithRetry` call (empty-retry + cross-provider fallback, `debate.ts:359-447`) executes concurrently; rounds themselves are SEQUENTIAL (for loop `for (let round = 1; round <= maxRounds; round++)`, `debate.ts:682`).
- Round budget: `resolveDebateRoundBudget(planKind, plannedRounds)` (`debate.ts:88-99`) — per-kind caps (`KIND_MAX_ROUNDS`, `debate.ts:76-82`: `implementation_plan`/`decision`/`evaluation`/`investigation` = 3, `exploration` = 5), absolute ceiling `ABSOLUTE_MAX_ROUNDS = 8` (`debate.ts:62`). Leader can request `extendRounds` (capped to +3 per eval, never past the kind ceiling).
- Convergence: leader evaluation (`evaluateDebate`, `debate.ts:1317-1376`, itself a `pickCouncilTaskModel("evaluate_round", ...)` call) PLUS a code-side lock-phrase heuristic (`looksLocked`/`convergenceRatio`, `debate.ts:164-221`) that can end debate early regardless of leader judgment (≥80% pair-turns show convergence phrases).
- Circuit breakers: per-model tool-disable after 2 consecutive empty completions (`ToolBudget`, `debate.ts:52-59`); per-pair drop after 2 consecutive failed rounds; whole-debate abort after 2 consecutive rounds with ≥50% pair failure (`debate.ts:1025-1042`).

**`planDebate`** lives in `debate-planner.ts` (not fully read in this pass, but referenced at `index.ts:15,367-382`) — leader proposes `DebatePlan { intentSummary, stances[], outputShape, plannedRounds? }` (`types.ts:186-199`) BEFORE the debate runs; `index.ts` assigns `stances` to `active[]` participants positionally.

**Orchestration entry point**: `runCouncil` (`index.ts:143-1087`) is the top-level async generator wiring clarify → preflight → research-need-check → `planDebate` → `runDebate` → `runPlanning` (synthesis, in `planner.ts`) → post-debate askcard → persistence (`[Council Decision]`, `[Council Outcome]`, `[Council Memory]` system messages + `decisions.lock.md` via `decisions-lock.ts`) → optional `runExecution` (executor.ts) if a plan was approved.

---

### Call-site inventory (grep `createCouncilLLM` / `resolvePlanCouncilLeader` / `resolveLeaderModelDetailed` across `src/`)

| Call site | file:line | Pattern |
|---|---|---|
| GSD complexity assessor | `src/gsd/complexity-assessor.ts:113` | `resolvePlanCouncilLeader(input.sessionModelId)` — leader-tier single-shot classify call, billed `source=council` |
| GSD plan-council | `src/gsd/plan-council.ts:208,296` | `resolvePlanCouncilLeader(sessionModelId)` |
| GSD verify-council | `src/gsd/verify-council.ts:75` | `resolvePlanCouncilLeader(opts.sessionModelId)` |
| Product-loop driver | `src/product-loop/loop-driver.ts:150` (+ doc comment `:25` referencing `createCouncilLLM` as the single source of truth for usage) | `resolveLeaderModelDetailed(ctx.sessionModelId)` |
| Product-loop gather | `src/product-loop/gather.ts:240` | `resolveLeaderModelDetailed(sessionModelId)` |
| CLI reporter command | `src/cli/reporter-cmd.ts:104-113` | dynamic `import("../council/leader.js")` + `import("../council/llm.js")`, constructs `createCouncilLLM(...)` directly for Discord-reporter Q&A |
| **Message-processor leader-assessor** (canonical reuse template) | `src/orchestrator/message-processor.ts:414-427` | `buildLeaderAssessorRunner` — dynamic imports of `createCouncilLLM` + `resolvePlanCouncilLeader`, throwaway local `stats`, single `llm.generate(...)` call. **This is the closest existing precedent for a PIL Gate.** |
| Orchestrator (2 sites) | `src/orchestrator/orchestrator.ts:1945-1947, 2103-2111` | `createCouncilLLM(this.bash, this.mode, this.session?.id, councilStats/productStats)` — the `/council` and product-loop entry points |
| council/index.ts itself | `src/council/index.ts:171` | `resolveLeaderModelDetailed(sessionModelId)` inside `runCouncil` |

---

### Gotchas for a PIL Gate reusing `createCouncilLLM`

1. **No per-call timeout override.** `COUNCIL_LLM_TIMEOUT_MS` is read ONCE from `process.env.MUONROI_COUNCIL_LLM_TIMEOUT_MS` at module load (`llm.ts:331-335`) and applies to every `generate`/`debate` call process-wide (research gets 2x, capped 1.8M). A turn-start gate wanting a tight budget (e.g. "don't block the user more than a few seconds") gets the SAME 5-minute default as a full synthesis call unless the whole process sets the env var — there is no way to pass a shorter deadline through the `CouncilLLM.generate()` signature itself (only an `AbortSignal`, which the caller must time out on its own with e.g. `AbortSignal.timeout(ms)`).

2. **Billing fires unconditionally when `sessionId` is set.** `recordCouncilUsage` returns early (no-op) only when `sessionId` is `undefined` (`llm.ts:265`). If a PIL Gate is invoked mid-turn with the real session id, EVERY gate call becomes a billed `source=council` usage_event AND mutates the live StatusBar cumulative counters (`in_tokens`/`out_tokens`/`cache_read_tokens`/`session_usd`) — this is desired (no cost leak) but means a high-frequency gate (e.g. fired on every keystroke or every tool call) would inflate `usage_events` volume and StatusBar cost fast. Rate-limit/gate the CALL FREQUENCY, not the billing.

3. **Mock routing is global, not scoped.** `globalThis.__muonroiMockLlm` is a single ambient slot — if a PIL Gate test and an enclosing council/debate test both run in the same process without resetting the global, they'll cross-contaminate. Existing council tests always set/clear this per-test (see `abort-threading.test.ts`, `round-tools.test.ts` patterns of `createCouncilLLM({} as any, "agent" as any, undefined, stats)` after mocking provider modules).

4. **Leader resolution has no fail-open wrapper of its own.** `resolvePlanCouncilLeader` can reject (async keychain/DB reads); every existing caller wraps it in try/catch (or relies on an outer fail-open, e.g. `runCouncil`'s `pilCtx` pattern at `index.ts:224-228`). A PIL Gate MUST add its own try/catch around `resolvePlanCouncilLeader(...)` and fall back to `sessionModelId` on failure — do not assume it's already fail-open.

5. **`bash`/`mode` params are still required positionally** even for a `generate`-only gate — pass the real `deps.bash`/`deps.mode` when available (as `message-processor.ts:423` does) since a future refactor could start using them in `generate()` too; passing dummies (`{} as any`) only works because current `generate()` code never reads them, which is an implementation detail, not a documented contract.

6. **Provider-crossing is deliberately blocked in leader resolution** — a PIL Gate must NOT try to force a "better" model on a different provider than the session's; `resolvePlanCouncilLeader`/`resolveLeaderModelDetailed` both hard-refuse to cross providers (billing surface + key availability reasons, `leader.ts:56-60,105-121`). If the gate needs a specific gate-only model, it must resolve one via the catalog/registry (Zero-Hardcode) scoped to the SAME provider, not hardcode an id.

7. **`generate()` uses `temperature: 0.7` and `maxRetries: 0` fixed** (`llm.ts:381,386`) — no per-call override exists; a deterministic-JSON gate wanting `temperature: 0` cannot get it through `createCouncilLLM.generate()` today. `maxRetries: 0` means all retry/backoff is via `withVisibleRetry` (visible "[retry] rate-limited..." UX), not silent SDK retry — a gate firing silently in the background would still surface visible retry text if wired into a stream; if the gate is non-streaming this text is simply dropped since nothing consumes yielded `StreamChunk`s (createCouncilLLM.generate itself is NOT a generator — only `tracedGenerate` wraps it as one).

