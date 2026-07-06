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

## Verification log (2026-07-06, deepseek-only, session c1e4ee4ff34f)

Shipped + live-verified: **A** (f3bc8093), **B2+B3** (93de3fd9), plus a
stale-criteriaMet reset fix surfaced during testing (c0da1805).

**A — live debate preview:** during round 2 of the extreme-vague council the
main console showed `Discussion round 2 · composing…` with both speaker lenses
(`↳ Terminal UX Designer — …`, `↳ Performance-Conscious Terminal Engineer — …`).
The "chán"/empty-console problem is gone.

**B2 — pin criteria:** rail rendered the exact `successCriteria` per council
(3 for crash-proofing, 4 for UI/UX) under an `Outcome: N/M criteria met` header.

**B3 — grade against pinned:** rail flipped `○→✓` from per-round eval, index-
aligned. Confirmed 0/4 → 4/4 progression on the UI/UX council.

**Graduated vague-topic interview test (simple → extreme):**

| Topic | Vagueness | Interview | Criteria derived | Round grading |
|---|---|---|---|---|
| "improve error handling" | simple | 1 Q → 4 aspects | 3 (crash-proofing) | R1 3/3 → stop ✅ |
| "make it better" | extreme | 1 Q → 4 project domains; resolved bare "it"→muonroi-cli | 4 (incl. measurable "80% pilot users rate clarity") | R1 0/4 → **continue**, R2 4/4 → stop ✅✅ |

Interview findings: the leader asks **one** question regardless of vagueness —
it widens the question's *scope* (sub-aspects → whole-project domains), not its
count. Even maximal vagueness produced concrete, sometimes-measurable criteria.

**Leader per-round finding (refines B4/B5):** the leader's criteria-driven stop
logic already works well — it **continues** when criteria are unmet (R1 0/4 →
continue) and **stops** only when all are met (R2 4/4 → stop). The real gap is
the **round-budget-exhaustion boundary**: the earlier harness-review council hit
`R3 3/5 → stop` because round budget (3/3) ran out with 2 criteria still unmet,
then synthesized *as if done* — no unmet-flag, no round-extension/re-team, no
escalation. **B4/B5 should fire specifically here**, not on the normal
all-met-early stop. Also: there is zero visible pre-round leader directive
(the "mờ nhạt" complaint) — B5's conductor visibility remains unbuilt.

**Bugs found:**
- *(fixed c0da1805)* stale `criteriaMet` leaked across same-session councils
  after an Esc-interrupt (upsert-merge kept the prior array → wrong "3/4" with
  stale ✓ at the approve card). Fixed via count-matched all-false reset in
  `index.ts` + length-guard in the rail render.
- *(open)* the rail **Progress** row (`Round 3/3 · 3/5 met · converged`) is a
  separate stale-leak — it never updated for councils #1/#3 (showed the first
  council's value throughout). Same root as the criteriaMet leak (no reset on
  Esc-interrupt) but a different `councilMeta` field; fix by resetting all
  council `councilMeta`/round state at council *start*, not only turn-*end*.
- *(minor)* the A composing placeholder ("Planning next moves") lingers after
  turn-end instead of clearing when idle.

## B5 + follow-up fixes (2026-07-06, second pass)

Shipped: **B5 leader conductor** (f49d5eb5) + **B4-lite** budget-exhaustion flag
(same commit) + **Progress-row stale fix** (56be385c).

- B5: pre-round ▶ DIRECTIVE (round goal + still-unmet criteria) and post-round
  VERDICT (per-criterion ✓/○ + next focus) as `kind:leader` messages tagged with
  a new `CouncilMessage.phase` ("directive"|"verdict"); directive renders in the
  accent colour so the leader visibly leads each round. Flag
  `MUONROI_LEADER_CONDUCTOR` (default ON, `=0` = pre-B5 behaviour). Gated on
  pinned criteria.
- B4-lite: on debate end (leader stop / convergence / budget exhaustion) with
  criteria unmet, the leader emits a closing verdict naming the open criteria
  instead of letting synthesis proceed as if done. Full remedy (auto-extend /
  re-team / user escalation) still TODO.
- Progress fix: `applyCouncilMetaPatch` detects a new council by topic change
  (ref-tracked) and flushes `councilRounds` + replaces `councilMeta`, so a prior
  council's round-3 record no longer survives as the Progress row's `last`.

Verification: tsc clean; 15 new unit tests (helpers + header phase) + 308
council/UI suite green. Live (fresh-source greenfield deepseek session
23cfe41c50a3): criteria pinned **0/5 then 0/4 all ○** across two councils — the
stale-criteriaMet + Progress reset confirmed with NO cross-council bleed; Esc
cancel cleared the rail. The in-round ▶ directive/verdict RENDER could NOT be
live-confirmed: deepseek-v4-pro (leader tier) stalled at the opening/debate-plan
phase on both attempts ("Not enough successful openings"), so rounds never ran —
a provider-degradation flake unrelated to B5. Directive/verdict remain
unit-verified; re-run a live council when the leader provider is healthy.

Still open: full B4 remedy loop (auto-extend / re-team / escalate); placeholder
lingering after turn-end; the `debate.ts` silent catch.
