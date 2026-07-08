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

## B5 directive durability + live render verification (2026-07-06, third pass)

The earlier live runs could confirm the **verdict** render but never the
pre-round **directive** bubble: the whole 2-round debate finished during the
async monitor's sleep window, and by the time a render fired the live debate had
collapsed into the conclusion card — which cleared the ephemeral directive
`council_message`. Root cause (not a flake): the verdict lives on
`CouncilRoundRecord` (so it survives into the collapsed card), but the directive
was emitted **only** as a standalone live bubble. A user who looked away during
the rounds therefore never saw the leader's opening steer — barely less "mờ
nhạt" than pre-B5.

Fix (57070f37): capture the directive text on `CouncilRoundRecord.directive` at
round start and carry it into every `roundRec("done")` exit (eval /
circuit-break / eval-unavailable). `CouncilRoundGroup` renders it at the top of
the collapsed round summary — accent colour + ▶ marker — so the leader visibly
opens each round in the durable conclusion card, not only the live stream. Also
exposed as `props.directive` on the `council-round-{n}` semantic node for harness
assertions.

Live-verified (deepseek-only, fresh-source greenfield session c676f04c0f7f, a
2-round in-memory-LRU-cache council). The **persisted** directive renders after
`debate_complete` — no timing fragility:
- Round 1 card: `▶ Establish concrete evidence for every outcome criterion.` +
  `Unmet (4/4): Cache correctly evicts…; When the cache reaches…; All cache
  operations…; Unit tests demonstrate…` → `✗ Outcome: 0/4 · Decision: continue ·
  Next focus: LRU strictness and concurrency model`.
- Round 2 card: `▶ Focus: LRU strictness and concurrency model` + `Unmet (4/4):
  …` → `✓ Outcome: 4/4 · Decision: sufficient — stop`.
- Rail `Outcome: 4/4` all ✓; Progress `Round 2/3 · 4/4 met · converged — stopped
  early`. No cross-council stale bleed.

So B5 is now fully live-verified (directive + verdict), both durable. Leader
per-round logic remains textbook (R1 0/4 → continue, R2 4/4 → stop). tsc clean;
300 council + UI tests green.

**Harness lesson:** the council DB (`interaction_logs`) logs only
`debate_complete` + `synthesis` at debate end — NO per-round rows — so a DB
monitor cannot wake on round transitions. Any live-render verification of an
intra-debate UI element must either persist that element onto a durable record
(preferred) or poll renders on a short time cadence before the debate collapses.

## B4 — leader auto-remedy toward unmet criteria (2026-07-07)

Shipped: **B4** (fc5cc8b3), promoting B4-lite (post-hoc flag only) into an active
remedy. "Done = all pinned criteria met" now drives the round budget.

- **Auto-remedy extend:** at the last planned round with ceiling headroom, if
  pinned criteria are still unmet AND progress is being made (a new criterion met
  within the last 2 rounds), the leader auto-extends by 1 — even without an
  explicit `extendRounds` — and steers the extra round at the open criteria
  (`nextTopic = "Close the unmet criteria: …"`). Both the absolute ceiling and the
  kind cap still bind: an `implementation_plan` cap of 3 with an initial budget of
  3 has no headroom, so its remedy is the diagnostic verdict, not an extension
  (auto-extend helps kinds whose ceiling exceeds the initial plan, and
  implementation plans where the leader initially proposed < cap).
- **Stuck guard:** a high-water mark of pinned-criteria-met + a
  `roundsSinceProgress` counter; no new criterion for 2 rounds fails the trigger
  so the ceiling isn't burned on a criterion that isn't moving.
- **Diagnostic closing verdict:** when the debate still ends with unmet criteria,
  the leader's closing message distinguishes stuck (needs evidence / rescope, not
  more debate) from a genuine ceiling hit (raise the budget) from an ordinary
  early stop — an actionable next move, not a generic shrug.

Pure decisions (`autoRemedyWantsExtend`, `diagnoseUnmetRemedy`,
`leaderAutoRemedyEnabled`) extracted + unit-tested (13 new; 236 council green).
Flag `MUONROI_COUNCIL_AUTO_REMEDY` (default ON under the conductor; `=0` restores
leader-requested-only extensions).

**Verification note:** B4's observable behavior only fires when a debate *ends
with unmet criteria*; every deepseek council this session converged to 4/4 in 2
rounds, so reliably forcing an unmet-ending debate to snapshot the auto-extend
line / diagnostic verdict live is non-deterministic. The pure decisions are
unit-verified and the integration reuses the already-live-verified extend path
(the "Leader extending…" content line) + the B5 verdict-message render path.

## B4 — interactive user-escalation askcard (2026-07-07)

Shipped: closes the last deferred B4 piece. When a debate is about to **stop with
pinned criteria unmet** and the leader can no longer self-remedy, the decision is
handed to the user instead of silently synthesizing a partial outcome.

- **Channel threaded:** `CouncilConfig.respondToQuestion?` (the same responder
  the clarifier + post-debate askcards use) now flows into `runDebate`;
  `runCouncil` passes its existing `respondToQuestion` through. Optional →
  headless/direct callers omit it and the debate falls through to the diagnostic
  closing verdict unchanged.
- **Two fire points, one applier (`escalateStop`):**
  - *Site 1 — leader-stop-with-unmet:* the leader declares the debate done while
    pinned criteria are still open (the "3/N → stop, synthesize as if done" gap).
    Gated on `!evaluation.allCriteriaMet` so a leader that genuinely met everything
    is never second-guessed by the fuzzy per-criterion alignment.
  - *Site 2 — exhaustion:* the leader wanted to continue but we're at the last
    round and auto-remedy couldn't extend (stuck ≥2 rounds, or at the ceiling).
- **Choices:** *Extend +2 rounds* (pushes past `effectiveCeiling`, still bounded
  by `ABSOLUTE_MAX_ROUNDS=8`; degrades to accept at the hard ceiling) / *Accept
  as-is* / *Narrow the scope*. Extend cancels the stop and re-enters the loop
  (overrides a same-round convergence break); accept/rescope confirm the stop.
- **Fires at most once per debate** (`escalated` guard). The closing diagnostic
  verdict is now choice-aware: `accept` → "you accepted these as open", `rescope`
  → "you asked to narrow the scope", else the original stuck/ceiling diagnosis.
- **No-Silent-Catch:** a throwing responder is logged with context and treated as
  accept — never a hang or crash.

Pure decisions (`leaderEscalationEnabled`, `escalationWanted`,
`buildEscalationOptions`) + the `runEscalationPrompt` generator are unit-tested,
and three **real-`runDebate` integration tests** prove the loop wiring: ask-once +
extra round runs on extend, stop-at-plan + choice-aware verdict on accept, and no
askcard on the headless (no-responder) path. `MUONROI_COUNCIL_ESCALATE` (default
ON under the conductor; `=0` disables). 273 council tests green, tsc clean.

**Verification note:** as with the rest of B4, the *live* trigger is
non-deterministic (deepseek councils converge to all-met in 2 rounds), so the gate
is unit + integration coverage over the real `runDebate` loop rather than a fresh
live snapshot.

## F2 + F3 — honest handling when the leader eval fails (2026-07-07)

Found by **driving the real TUI** (session 6ce154b6c864, `/council` on
optimistic-vs-pessimistic locking): a genuinely divided debate ran all 3 rounds
at 0/4 criteria met, then the **round-3 leader eval parse-failed** →
`Decision: evaluation unavailable`. Because the B4 escalation lived inside the
`if (evaluation)` branch, the debate ended 0/4 with **no user escalation** and a
confident-looking synthesis — the exact gap escalation was meant to close, hit
through the eval-failure back door.

- **F3a (No-Silent-Catch):** `evaluateDebate`'s `catch {}` (and the no-JSON-found
  path) now log with context — round, model, message, a raw snippet — so
  eval-unavailable is diagnosable instead of a black box. The debate still
  continues on failure; only the silence is removed.
- **F3b (robust extraction):** new `extractEvalJson` replaces the greedy
  `/\{[\s\S]*\}/` match — strips code fences and brace-scans for the LAST balanced
  `{…}` object (the schema is emitted after any chain-of-thought prose), so prose,
  multiple objects, or a trailing partial no longer corrupt the parse. Deterministic,
  no extra LLM call; complements the existing cross-provider eval-fallback loop.
- **F2 (escalate on final-round eval-unavailable):** in the eval-unavailable
  branch, if this is the last round with an interactive channel and pinned
  criteria are still open (falling back to `lastCriteriaMet`; empty history →
  all unmet), consult the user via the same `escalateStop` (stuck=true — a broken
  eval gives no progress signal). Extend re-enters the loop; accept/rescope end.
  Headless (no responder) is unchanged: the closing diagnostic verdict still names
  the open criteria.

`extractEvalJson` is unit-tested (plain / fenced / prose+braces / multi-object /
nested / garbage) and two real-`runDebate` integration tests cover the
eval-never-parses path (askcard fires + extra round on extend; no askcard +
closing verdict when headless). 281 council tests green, tsc clean. Flags
unchanged (`MUONROI_COUNCIL_ESCALATE`).

## F1 — honest post-debate card when pinned criteria are unmet (2026-07-07)

Live evidence: the divided locking debate ended 0/4 criteria met + `⚠ Low
confidence` yet the post-debate card recommended "Hand back the decision" as
settled. Root cause: the card's confidence badge reflects only **evidence
density**, never whether the **pinned success criteria** were actually met — so a
0/N debate with some citations reads as done.

- **Criteria exposed:** `DebateState.finalCriteriaMet` (the last successful
  round's alignment) is returned from `runDebate`; the card derives met/unmet from
  it via the pure `summarizeCriteriaOutcome`.
- **Recommendation is criteria-first:** `pickPostDebateRecommendation` takes
  `criteriaUnmet`; when > 0 on a successful synthesis it returns `ask_followup`
  ("press the council to close them before treating this as settled"), dominating
  the evidence-density / output-kind / plan heuristics — you never get a
  commit/save default while the user's own success bar is unmet.
- **Card reframed when inconclusive** (`!synthesisFailed && unmet > 0`): heading
  → "Debate Synthesis — Inconclusive (met/total criteria met)"; an explicit
  "⚠ Outcome: met/total met. Unmet: … — provisional, not a settled decision"
  line; a criteria-aware "Keep working the N unmet criteria" option pinned at
  index 0 as the default (reuses `ask_followup` routing, deduped) across BOTH the
  model-actions and fallback option paths.

`summarizeCriteriaOutcome` + the `criteriaUnmet` branch are unit-tested (met/unmet
alignment, missing-flags → all-unmet, singular/plural, synthesis-failure still
wins, no-criteria never inconclusive); `runDebate` exposing `finalCriteriaMet` is
covered by the existing integration test. 327 council/headless tests green, tsc
clean. Met-in-full and synthesis-failed paths unchanged.

**Still deferred (separate increment):** re-team via `selectTaskAwarePanel` on a
stuck criterion (rescope currently stops honestly with a marker rather than
re-running); the composing placeholder lingering after turn-end; localization leak
in the clarify askcard (VI option descriptions in an English card); `/council
<args>` "No commands match"; the two pre-debate gates (clarify → pre-flight
rubber-stamp). Not yet **live-verified** — the F1 card only renders when a debate
ends unmet (non-deterministic); logic is unit + full-suite covered.
