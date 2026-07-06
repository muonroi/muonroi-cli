# Council Outcome-Criteria + Leader-Conductor — Implementation Plan

> Status: DRAFT (session 2026-07-06). Grounded against live source. Verify by
> driving the real agent-mode TUI via the MCP harness (user preference:
> harness-verify, NOT vitest). Each phase committed + live-verified.
>
> Owner: muonroi. Origin: dogfood feedback on council sessions `2217600e1f27`,
> `f92bafbfecd9` — (1) debate main console is empty during composing, (2)
> "criteria met" is meaningless because criteria are leader-improvised per round,
> not user-owned, (3) the leader is "mờ nhạt" — a passive per-round evaluator
> instead of the central conductor the role was created to be.

---

## Root causes (verified against source)

1. **Empty composing window.** Council uses `generateText` (atomic, non-stream)
   for every panelist/leader/eval call (`src/council/llm.ts:377,526,706`). During
   the 20–60s "composing…" window there are no intermediate tokens; the
   placeholder (`src/ui/components/council-placeholder-bubble.tsx:34`) shows only
   `⠋ {label} · composing… · {sec}`. The placeholder is **phase-level** (label =
   "Generating opening statements (N participants)"), built at
   `use-app-logic.tsx:3420` from `council_status` (`phase==="opening"|"exchange"`,
   `state==="start"`).
2. **Meaningless criteria.** `ClarifiedSpec.successCriteria` EXISTS and the
   clarify phase DOES interview the user (`clarifier.ts:440-459`) then shows a
   "Clarified Spec" card (`:508`). BUT (a) the user never confirms/pins them, and
   (b) `evaluateDebate` returns `criteriaStatus` the leader **improvises per round**
   (`debate.ts:1470-1472`), NOT graded against `spec.successCriteria`. So "N/M
   criteria met" refers to throwaway per-round criteria the user never sees.
3. **Faint leader.** The leader only surfaces at clarify (spec), plan_debate
   (budget), and per-round `evaluateDebate`. It never briefs the panel before a
   round, has no visible cross-round continuity, and its steering primitives
   (`extendRounds`, `nextRoundFocus`, `selectTaskAwarePanel`) fire silently.

## Existing primitives to build on (do NOT reinvent)

- `DebateStance {name, lens, focus?}` (`types.ts:138`) — per-speaker angle.
- `ClarifiedSpec.successCriteria: string[]` (clarifier) — the outcome, already
  interviewed but not pinned/graded.
- `evaluateDebate` → `{allCriteriaMet, criteriaStatus[], nextRoundFocus,
  extendRounds, reason}` (`debate.ts:1417`).
- `selectTaskAwarePanel` (`panel-select.ts`, U3, flag `MUONROI_TASK_AWARE_PANEL`).
- `council_meta` / `council_round` chunks + Context Rail (Topic/Progress rows).

---

## Workstreams

### A — Live debate preview (approved; ship first, zero-risk, pure enrich)

Engine emits the roster + per-speaker `lens` in the opening/exchange
`council_status` `detail` (`debate.ts:586,937` — currently just joined names).
Placeholder renders `detail` as muted sub-lines under the label:

```
⠋ Generating opening statements (2 participants) · composing… · 21s
  ↳ Design Intention Analyst — "does the design intent actually hold?"
  ↳ Source Code Auditor — "what does the code really implement?"
```

**Files:** `debate.ts` (detail formatting), `council-placeholder-bubble.tsx`
(render `detail` lines), `use-app-logic.tsx` (thread `detail` onto placeholder
map — 3 sites: 3427/4248/4509). **Acceptance:** during composing the main area
shows each speaker's lens (not a bare spinner); fallback to label-only when
`detail` empty. Verify: real `/council` via harness → `visual_quality` main area
content > spinner-only.

### B — Outcome-criteria + leader-conductor (semantics change)

| # | Change | Files |
|---|---|---|
| **B1** | After clarify, an **askcard confirms/edits `successCriteria`** → user owns the outcome; pin it on the spec. | `clarifier.ts`, `index.ts` |
| **B2** | Rail pins **Outcome / Criteria** rows beside Topic, each with live **met / pending** state. | `council_meta` patch, rail render |
| **B3** | `evaluateDebate` grades against the **pinned `spec.successCriteria`** (inject as a fixed rubric; model returns met/not PER pinned criterion) — no more improvised criteria. | `debate.ts`, `prompts.ts` |
| **B4** | **Done = all pinned criteria met.** When a criterion is unmet, the **leader chooses a remedy** targeting that criterion: re-team (`selectTaskAwarePanel`), inject context (research/codebase/EE), steer (`nextRoundFocus` + `extendRounds`). Ceiling is a leader-managed budget, not a give-up. Escalate to the user (askcard) only when the SAME criterion makes no progress for N rounds. | `debate.ts` |
| **B5** | **Leader conductor loop.** The leader holds context across the whole debate: **before** each round it emits a visible directive (round goal targeting unmet criteria + team/context decision); **after** each round it emits a visible verdict (per-criterion progress + remedy). UI renders both so the leader stops being "mờ nhạt". | `debate.ts`, `prompts.ts`, rail/round UI |

**Acceptance B:** real `/council` → (1) criteria-confirm card appears; (2) rail
shows exactly those criteria live; (3) each round card shows met/pending against
the **user-pinned** criteria; (4) a visible leader directive precedes each round
and a leader verdict follows it; (5) debate ends only when all criteria met OR
the leader escalates a stuck criterion to the user.

**Stop-condition (locked with user):** never a silent "stop at ceiling". Leader
actively remedies; user is pulled in only on genuine stuck-criterion.

### Incidental
- Fix the silent catch at `debate.ts:1488` (No-Silent-Catch rule) when editing.

## Flags / rollout
Reuse the council flag idiom (`MUONROI_*`, default ON after bake). New:
`MUONROI_COUNCIL_PINNED_CRITERIA`, `MUONROI_LEADER_CONDUCTOR` (default OFF until
live-verified; fallback = current behavior so headless/legacy keep working).

## Build order
A (independent, ship + verify) → B1+B2 (pin + show) → B3 (grade against pinned) →
B5 (conductor loop visibility) → B4 (remedy/escalate). B3 must land before B4
(remedy needs real per-criterion status). Verify each stage on a live `/council`
via the harness before the next.
