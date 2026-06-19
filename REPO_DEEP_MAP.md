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
| `bridge.ts` | PIL bridge — unified `/api/pil-context` call with circuit breaker. Also re-exports the WhoAmI provider (single sanctioned PIL→EE entry point per the `no-network-in-pil` arch guard) |
| `who-am-i.ts` | "Who Am I" v4.0 profile provider — reads the device-local `~/.experience/profile.yaml` (via EE's installed `loadProfile`/`getPrivacyLevel` through `createRequire`), privacy-gated by a positive per-dim allowlist (defense-in-depth), cached + fail-open. `getWhoAmIProfile()` + pure `selectWhoAmIDims`/`outputStyleFromProfile`. Consumed by the pipeline → L1 outputStyle baseline |

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
