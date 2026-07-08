# Council Detail Readability (Feature A)

**Date:** 2026-07-08
**Status:** Approved design → implementation
**Scope:** Council mode detail views only. Council display-language selection is a
separate spec (Feature B), deferred.

## Problem

When viewing a council debate the detail is hard to read. Concretely, from user
feedback + code inspection:

1. **Todo panel crowds the debate.** `TaskListPanel`
   (`src/ui/components/task-list-panel.tsx`) renders as a fixed bottom band
   (`app.tsx:1228`, `flexShrink={0}`, comment *"TodoCard — fixed bottom so agent
   text cannot push it up"*). It shows up to `MAX_VISIBLE = 8` items + header +
   footer + border ≈ **11 rows**. During a council debate the debate renders in
   the `<scrollbox>` above; on a normal terminal the todo band eats most of the
   remaining height, so *"khung nhìn để xem nội dung debate cực kì nhỏ"*.
2. **Debate stream** — hard to tell who said what across rounds.
3. **Conclusion card** — sections present but spacing/scannability weak.
4. **Context rail** — round navigation works but the keybinding is undiscoverable.

## Non-goals (YAGNI)

- No council display-language translation (Feature B, separate spec).
- No full-screen "council focus" mode (rejected approach — too large).
- No change to todo-panel behaviour **outside** council (avoid regressing normal UX).

## Design

Targeted, incremental. Each item ships independently; **A1 is the priority**.

### A1 — Todo panel auto-collapses during council

`TaskListPanel` gains a `collapsed?: boolean` prop.

- **Collapsed render:** a single line —
  `▸ Todos · 4 done · 2 queued · 1 in progress (ctrl+e)` — reusing the existing
  `footer` string builder. No border box, `flexShrink={0}`, one row tall.
- **Expanded render:** unchanged (current full panel).
- **When collapsed:** `app.tsx` passes `collapsed={councilActive}` where
  `councilActive` = a council/loop debate is live (derive from non-empty
  `councilStatuses`, or an existing council-live flag in `use-app-logic`). `ctrl+e`
  toggles collapsed↔expanded (the panel already reserves `ctrl+e` for expand).
- **Outside council:** `collapsed` is `false` → identical to today.

Reclaims ~10 rows for the debate scrollbox — the primary fix.

**Files:** `src/ui/components/task-list-panel.tsx` (add prop + collapsed branch),
`src/ui/app.tsx` (pass `collapsed`, wire `ctrl+e` toggle state),
`src/ui/components/__tests__/` (collapsed render + toggle unit test), harness spec
for the council-active collapse.

### A2 — Debate stream: clearer speaker/round structure

The per-round debate positions render as bubbles in the scrollbox;
`CouncilStatusList` (`council-status-list.tsx`) shows phase spinners. Improve the
transcript structure:

- A visible round divider between rounds.
- Each position gets a role-colored header (`role` + stance name) so the reader can
  scan "who said what". Reuse existing theme role colors; no new tokens unless a
  color is missing.

**Files:** the debate-bubble component(s) under `src/ui/components/council-*` (exact
component confirmed during planning), theme role colors.

### A3 — Conclusion card polish

`council-conclusion-card.tsx` already parses the synthesis JSON into sections
(summary / strengths / weaknesses / recommendation / coverage). Polish only:

- Consistent blank line between sections.
- Recommendation visually emphasized (accent/bold header).
- Clean wrapping; no raw-JSON leakage (the salvage path already guards this).

**Files:** `src/ui/components/council-conclusion-card.tsx` (render section only).

### A4 — Rail round-nav discoverability

`CouncilRailRounds` already highlights the selected row (accent + `›` + bold). Add
a one-line hint of the keybinding (`Ctrl+←/→` when composer empty) under the
"Rounds" header so users discover round scoping.

**Files:** `src/ui/components/council-rail-rounds.tsx`.

## Testing

- **Unit:** `TaskListPanel` collapsed render + counts line; conclusion-card section
  spacing; rail hint present.
- **Harness E2E:** todo panel collapses to one row while a council debate is active
  and expands on `ctrl+e`; captured via `tui_render_visual` before/after (the
  harness was verified working this session).
- **Self-verify** on the watched UI surfaces (`src/ui/**`).
- Full unit suite + `bunx tsc --noEmit` green before push (pre-push gate).

## Rollout

One PR into `develop`, commits sequenced A1 → A2 → A3 → A4 so A1 (the high-value
fix) is bisectable and independently revertable.
