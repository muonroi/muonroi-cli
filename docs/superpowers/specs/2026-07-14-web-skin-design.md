# Web Skin for muonroi-cli — Design Brief

> **Status:** approved (brainstorming, 2026-07-14). This is the *north-star* brief
> the supervisor holds while driving `/ideal` to build the skin. It is deliberately
> NOT handed to `/ideal` verbatim — `/ideal`'s own research/interview/council/plan
> stages must expand a short goal prompt into the concrete implementation, so we can
> measure the sharpness of each stage. This brief is what the supervisor answers
> interview questions FROM, so answers stay consistent across turns.

## Goal

A new **web (React-DOM + HTML/CSS)** presentation skin for muonroi-cli that reuses
the existing headless core, keeps **100% of current features** (including drive-TUI /
harness and view-ui/ux), and swaps only presentation. The current OpenTUI terminal
skin stays as a **co-equal, permanent** skin — not deprecated.

## Non-negotiable constraints (from the codebase)

- **Core stays headless.** `src/orchestrator`, `src/council`, `src/gsd`,
  `src/product-loop`, `src/state` must keep **zero** imports of `src/ui` /
  `@opentui/*`. The web skin lives beside the TUI skin, never inside core.
- **The contract is `StreamChunk`** (`src/types/index.ts:501`) — the 21-variant
  JSON-serializable discriminated union already emitted by `agent.processMessage`.
  It is the core→UI wire, NOT the harness `LiveFrame` (which is an accessibility
  tree with no color/layout and cannot render a GUI).
- **Zero-hardcode** of model/provider IDs (CLAUDE.md rule) carries into any new code.
- **No silent catch** — every catch logs module + op + message.

## Architecture (approved)

```
              ┌─ TUI renderer (OpenTUI)           [in-process, unchanged]
core (Agent) ─┤        ▲ same shared-view-model library
  StreamChunk └─ Web renderer (React-DOM + CSS)   [browser, over WS]
      │
      └──> SHARED VIEW-MODEL (headless, browser-safe): StreamChunk → UI-state
```

- **Client-side reduce (approved).** The Bun sidecar streams raw `StreamChunk` over
  a localhost WebSocket; the **browser** runs the shared view-model reducer to build
  UI state. Rationale: the reducer is a pure function (browser-safe) so TUI and web
  run the *identical* reducer; `StreamChunk` is already serializable (no new diff
  protocol); the server stays a thin pipe. Rejected: server-side reduce streaming
  state-diffs (extra stateful protocol, breaks reducer symmetry).
- **Shared view-model** is the extraction target: the `StreamChunk → UI-state`
  reducer + command dispatch currently entangled in the 7575-line
  `src/ui/use-app-logic.tsx` must move into a headless, browser-safe library both
  skins import. This is the hard, risky refactor and is deferred out of slice 1.
- **Transport-first, Electron later.** localhost-WS + Bun sidecar now; Electron
  packaging is a later sub-project.

## Feature parity (kept, GUI-native — not a 1:1 terminal port)

GUI-native multi-pane `[sessions/sidebar | chat stream | context-rail]`, mouse +
keyboard, rich diffs, a real council timeline, askcard as modal/panel. Same
features, richer UX.

## Decomposition (each its own spec → plan → build cycle)

1. **Bun sidecar + WS transport** (`muonroi serve`): run Agent, stream StreamChunk out / accept commands in.
2. **Extract shared view-model** from `use-app-logic` — hard refactor, touches live TUI.
3. **Web renderer (React-DOM + CSS)** — multi-pane shell, chat, context-rail, council timeline, askcard modals.
4. **Harness parity for web** (`@muonroi/agent-harness-react`) — "drive TUI" → "drive web".
5. **Electron packaging** — later.

## Slice 1 — walking skeleton (FIRST build task, this drive)

Thinnest vertical slice that touches sub-projects 1+2+3 minimally to de-risk the two
scary parts (transport + view-model extraction) with the smallest feature:

> Type a prompt in the browser → Bun sidecar streams `StreamChunk`
> (`content` / `tool` / `tool_result` / `done`) over localhost-WS → a **minimal**
> extracted view-model reducer builds message state → a bare React-DOM page renders
> the chat stream + a prompt box that sends the next prompt back.

**In scope:** one WS endpoint; a minimal reducer for those 4 chunk variants; a plain
(unstyled-OK) React-DOM chat page; prompt round-trip. **Out of scope for slice 1:**
council/ideal rendering, askcard modals, multi-pane layout, CSS polish, harness
parity, Electron. Those are later slices.

**Done = proven end-to-end:** `core → WS → reducer → DOM → command back` works for a
plain chat turn, with an automated check (not just a screenshot).

## Drive protocol (supervisor = Claude; builder = `/ideal`)

- Builder is muonroi-cli's own `/ideal`, driven via the MCP harness in the worktree
  `D:/sources/Core/muonroi-cli-web` (branch `feat/web-skin-slice1`, forked from the
  de-facto main `feat/convene-council-tool`).
- **Provider order:** xai → opencode → deepseek, falling through only on rate limit.
- Supervisor answers `/ideal` interview questions from THIS brief, records the run in
  `docs/dogfood/ideal-web-skin-drive-log.md`, and rates each pipeline stage
  (research / interview / council / plan / implement) for sharpness.
- **Per task:** when a task's output passes supervisor review → merge into the
  de-facto main → cut a new branch for the next task.
