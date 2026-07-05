# Debate/Council Two-Pane UX Redesign — Implementation Plan (v2)

> Status: DRAFT v2 — rewritten after a 4-lens adversarial review (rendering,
> council data-flow, UX, testing/rollout). §12 lists what v1 got wrong and why.
> Owner: muonroi.
>
> Goal: make debate mode (and other metadata-heavy modes like `ideal`) readable
> by (1) fixing the scroll-yank so reading survives streaming, (2) grouping the
> transcript by **round** with done rounds shown inline (metrics + outcome +
> leader decision), and (3) moving static session/debate metadata into an
> **always-global** right Context Rail. No mode-switching rail, no click-to-open
> accordion as the primary path.

---

## 1. Problem (verified against 2 live screenshots + source)

Single full-width column (`src/ui/app.tsx:746` → `Semantic id="log"` →
`<scrollbox>`) mixes three unrelated things:

1. **Header spam** (`type:"content"`): `⋯ …sub-session ngầm…`,
   `[Auto-council triggered…]`, `Leader auto-promoted…`, `Leader: …·Panel: …`,
   `↳ Leader recommends research…`, `[Experience] N warnings`,
   `── Opening Analysis ──`, `Leader-proposed debate budget…`
   (`orchestrator.ts:2283/2878`, `tool-engine.ts:700`, `council/index.ts:188-336`,
   `debate.ts:589/670/901`).
2. **Three full info-cards** inline (`app.tsx:833-847`).
3. **Round separators decoupled from turns** (`── Round N ──` = bare content at
   `debate.ts:901`; turns folded into one `CouncilDebatePill` at `app.tsx:915`)
   → rounds look empty.
4. **Two forces yank to bottom every render**: native
   `stickyScroll={true} stickyStart="bottom"` (`app.tsx:750`) **plus** the
   `scrollToBottom()` fan-out (`use-app-logic.tsx:2070`, ~15 callers) **and two
   direct bypasses** `scrollRef.current?.scrollTo(scrollHeight)` at
   `use-app-logic.tsx:1785` and `:1811`.

## 2. Goals / Non-goals

**Goals** — reading survives streaming; per-round metrics/outcome/leader decision
visible; static metadata off the transcript into a rail; mode-aware + responsive
with a safe fallback; every interaction keyboard-reachable.

**Non-goals** — no council reasoning/quality change; no mouse-only feature; no new
model/provider string literals (Zero-Hardcode rule); **no rail mode-switching**;
**no accordion that hides history behind a click**.

## 3. Locked decisions (post-review)

- **Scroll fix ships first, standalone** (highest value, lowest risk, independent
  of rail/rounds). It is *deletion/gating*, not a new poll loop (§5.1).
- **Rail is always GLOBAL** — never re-scopes to a selected round. Per-round
  detail lives **inline in the expanded round** in the main column
  (lazygit/k9s idiom: detail is panel content, not a hijacked nav).
- **Done rounds render EXPANDED inline** (compact header + turns + outcome). The
  *running* round is the only "live" one. `Ctrl+O` collapses/expands **all**
  (existing key). No per-round click-to-open as the required path; optional
  keyboard round-nav is a later enhancement (§6 P7), never the only way in.
- **Keep a short model tag per turn** (2–3 chars) next to `● role`; **drop the
  word-count** instead. Full model ids never in the 36-col rail.
- Rail: **`flexShrink:0` + explicit `width`**, main `flexGrow:1`; auto-hide when
  `width < 100`; toggle **`Ctrl+B`**; rail is **fixed / non-scrolling** (summary
  only, no overflow).
- **Feature flags default OFF** for ≥1 bake release, wired centrally in
  `src/gsd/flags.ts` style: `MUONROI_CONTEXT_RAIL`, `MUONROI_ROUND_GROUPS`,
  `MUONROI_SCROLL_LOCK`. Engine content-emit removal is **gated on the rail flag
  being ON** — fallback transcript keeps all metadata when the rail is off.
- **ASCII-safe glyphs only**: reuse the proven set `●` (`council-message-bubble.tsx:53`)
  and `✓` (`council-phase-timeline.tsx:79`); disclosure via `>`/`v`, kind via
  `*`/`#`. `app.tsx` reports as `data` to `file(1)` → always search with
  `grep -a`, never plain grep.

## 4. Data model

### 4.1 New chunks (incremental, NOT one-shot)

`CouncilMeta` is **assembled over time from two generators** — the UI upserts a
partial. `index.ts` emits leader/panel/research/goal; `debate.ts` emits the
budget (it is a local inside `runDebate`, invisible to `index.ts`).

```ts
export interface CouncilMetaPatch {           // upsert-merge on the UI side
  leader?: { role: string; model: string };
  panel?: Array<{ role: string; model: string }>;
  costAware?: boolean;
  researchMode?: string;                       // codebase-first|internet-first|none
  autoReason?: string;
  goal?: string;                               // debatePlan.intentSummary
  budgetRounds?: number;                        // from debate.ts, second emit
  effectiveCeiling?: number;
  kindCapped?: boolean;
}

export type CouncilRoundKind = "opening" | "planned" | "emergent";
export type CouncilLeaderDecision =
  | "converged" | "continue" | "extended" | "code-override" | "unavailable";

export interface CouncilRoundRecord {
  round: number;                 // 0 = opening
  kind: CouncilRoundKind;        // captured at loop-top, BEFORE maxRounds mutates
  status: "running" | "done";
  topic?: string;                // nextRoundFocus (prev round) — absent for r1
  participants: Array<{ role: string; model: string; task: string }>;
  input?: string;                // runningSummary; empty at round 1 — omit
  outcome?: string;              // "{met}/{total} criteria met — {reason}"
  criteriaMet?: number;
  criteriaTotal?: number;
  leaderDecision?: CouncilLeaderDecision;
  extendBy?: number;
}
```

New `StreamChunk` variants `council_meta` (patch) and `council_round` (upsert by
`round`).

### 4.2 Field provenance (corrected — several were NOT "just wire-up")

| Field | Source | Caveat |
|---|---|---|
| leader/panel/costAware | `index.ts:171-201` | one emit |
| researchMode | `index.ts:319-338` | later, **second patch** |
| goal | `debatePlan.intentSummary` after plan (`index.ts:382`) | later patch |
| budget/ceiling/kindCapped | **local in `runDebate`** (`debate.ts:659-667`) | **NOT visible to index.ts → emit from debate.ts** |
| kind (emergent) | `round > plannedMaxRounds` | ✅ `plannedMaxRounds` is a const captured before the `let maxRounds` mutation (`debate.ts:659-664`) — stable |
| participants+task | `active[]` + `DebateStance{lens,focus}` | known at loop-top |
| input | `runningSummary` (`debate.ts:1220`) | **empty entering round 1** — omit |
| topic | new `nextRoundFocus` from prev eval | **absent for round 1** (no predecessor eval) |
| outcome/criteria/leaderDecision | `evaluateDebate` (`debate.ts:1053-1076`) | round END only; **missing on break paths** |

## 5. Architecture

### 5.1 Scroll fix (P0 — deletion/gating, no poll loop)

Root cause is not "no scroll-lock"; OpenTUI already sets `_hasManualScroll=true`
and stops auto-sticking once the user leaves the bottom (verified in
`@opentui/core` `updateStickyState`/scrollbar `onChange`). The bug is code that
**overrides** it by forcing the bottom.

- Introduce `stickToBottomRef` (default true). Set false when the user scrolls up
  — detect via OpenTUI's own manual-scroll signal, **not** a per-frame React
  setState (a 60 Hz setState storm is the M6 hazard). If a frame observer is
  needed, register an **unconditional** `addPostProcessFn` (the one at
  `use-app-logic.tsx:607` is `agentRuntime`-gated → agent-mode only; reusing it
  would make the feature pass harness specs while doing nothing for real users)
  and update React state **only on locked↔unlocked transitions**.
- **Gate every forced-bottom call site** behind `stickToBottomRef`: `scrollToBottom`
  (2070) **and the two direct bypasses at 1785 / 1811** and any other
  `scrollTo(scrollHeight)`. Add `scrollToBottomForced()` for genuine jumps
  (user-sent turn start; the jump-to-latest pill).
- Keep `stickyStart="bottom"` explicit (re-lock depends on it; it currently rides
  an `as any` cast at `app.tsx:750`).
- `End` (and pill click) → `scrollToBottomForced()` + re-lock. `PageUp/PageDown`
  → `scrollRef.scrollBy`, **only when the composer is empty/unfocused** (else the
  textarea owns Home/End/PageX cursor semantics — global `useKeyboard` fires
  regardless of focus).
- Surface `props.locked` (=!stickToBottom) and `props.newSinceLock` on
  `Semantic id="log"` for deterministic testing (scrollTop is NOT observable —
  see §7).

### 5.2 Layout (P1)

`app.tsx:746` → `flexDirection="row"`:

```
<box flexGrow={1} flexDirection="row" gap={1}>
  <box flexGrow={1} flexDirection="column">   {/* MAIN */}
    <Semantic id="log"><scrollbox stickyScroll={...}>…</scrollbox></Semantic>
    {locked && <JumpToLatestPill .../>}
  </box>
  {railVisible && <ContextRail flexShrink={0} width={36} .../>}
</box>
```

Composer/status bar stay siblings **below** 746 (unchanged). Delete or reconcile
the **orphaned duplicate** `src/ui/containers/chat-feed.tsx` (imported nowhere,
a second copy of the feed) **before** editing — otherwise edits risk the wrong
file / `lint:semantic` drift.

### 5.3 Components

- `src/ui/components/context-rail.tsx` — `Semantic id="context-rail"
  role="complementary"`. **Always global**: goal, total rounds (planned+emergent),
  member roster as **role + color chip only** (no full model id — 36 cols can't
  hold `deepseek-ai/DeepSeek-V4-Flash`), emergent count, budget, per-round outcome
  list, leader's final proposal. Fixed height, no internal scroll.
- `src/ui/components/council-round-group.tsx` — one round; **done rounds render
  expanded inline** (header `> R{n} {topic} · ✓met/total · leader:{verdict}` +
  turns + a short outcome block). Running round streams. No required click.
- `src/ui/components/jump-to-latest-pill.tsx` — `v N new · End`.
- Turn row (`council-message-bubble.tsx`): `● role [mdl]` (short model tag) +
  body; drop word-count/quote line.

### 5.4 Shared council-chunk reducer (P2 prerequisite)

There are **four divergent** stream loops, not "three mirror copies":
`use-app-logic.tsx:3160` (main `switch`, handles `council_info_card`), `~4055`
(`/ideal`), `4305` (`runCouncilV2` — **does NOT handle `council_info_card`**, so
Spec/Plan cards already drop in explicit `/council`), `4762` (`runCouncilRound`,
content/done only). Extract **one `applyCouncilChunk(chunk, setters)`** used by
all loops, with a `default:` that logs unhandled council kinds, **before** adding
`council_meta`/`council_round`. A missed site otherwise ships silently (the only
sub-session spec has zero council assertions).

### 5.5 Engine emit (P4/P5) — gated, lifecycle-complete

- **`council_meta`**: two patches (index.ts leader/panel/research/goal; debate.ts
  budget after `debate.ts:667`). UI upsert-merges.
- **`council_round`**: emit `{status:"running"}` at loop-top (`debate.ts:682`,
  capturing `kind`/participants/input there) **and a guaranteed
  `{status:"done"}`** on every exit — including the break paths that skip the
  eval (`pairs.length===0` at 716-723; circuit-breaker at 1033-1039) and the
  `evaluation===null` parse-failure branch (1194) — defaulting `outcome` to
  "evaluation unavailable" and `leaderDecision:"unavailable"`. Opening (round 0,
  no eval) is its own `kind:"opening"` shape.
- **`leaderDecision`** distinguishes leader-said-continue-but-code-forced-stop
  (`debate.ts:1162-1172`) via `"code-override"`, not a mislabeled "converged".
- **`nextRoundFocus`**: add to the leader-eval JSON schema (`prompts.ts` ~442),
  placed **first** in the object and/or raise the eval `maxTokens` (currently
  1024, `debate.ts:1334`) so a verbose leader can't truncate the JSON and null
  the *entire* evaluation (which would also kill outcome/criteria). Do **not**
  add it to the 256-token `evaluateResearchNeed` call.
- **Removing the header/round-separator/budget `content` lines** happens **only
  when the rail flag is ON**; when off, the engine still emits them so headless
  (`src/headless/council-answers.ts`), legacy `runCouncilRound`, and narrow-
  terminal fallback keep full metadata. The per-round `council_status` persist
  (`debate.ts:1020`) and the `[Debate Transcript]` rebuild (`index.ts:458`) are
  untouched.

## 6. Phases

| Phase | Deliverable | Flag / gate |
|---|---|---|
| **P0** | **Scroll fix** — gate all forced-bottom sites (2070, 1785, 1811, any `scrollTo(scrollHeight)`); jump-to-latest pill; `End`/`PageUp`/`PageDown` (composer-aware); `props.locked`/`newSinceLock` on `id="log"`. Standalone, shippable alone. | `MUONROI_SCROLL_LOCK` (OFF→ON after bake) |
| **P1** | Row layout + empty **global** rail (flexShrink:0/width, hide `<100`, `Ctrl+B`); footer legend; **delete/reconcile `chat-feed.tsx`**. | `MUONROI_CONTEXT_RAIL` (OFF) |
| **P2** | Shared `applyCouncilChunk` reducer (+ default logging) across all 4 loops; sub-session council render spec. Move info-cards + phase timeline + `productStatus` into rail, **keep inline fallback when rail off**. | rail flag |
| **P3** | `council_meta` (2 incremental patches) → rail shows leader/panel/budget/research; header spam removed **only when rail ON**. | rail flag |
| **P4** | Rail for `ideal`/product-loop (reuse `ProductStatusCardData`). | rail flag |
| **P5** | `council_round` emit refactor (lifecycle + break-path done-emit + `nextRoundFocus` + `leaderDecision` enum). Unit-tested in `src/council/__tests__/`. Round-separator content removed **only when round-groups flag ON**. | `MUONROI_ROUND_GROUPS` (OFF) |
| **P6** | Round-grouped transcript UI: done rounds expanded inline, running streams, short model tag per turn, drop word-count. **Keep `CouncilDebatePill` as fallback when `councilRounds.length===0`** so live debates never render empty during rollout. | round-groups flag |
| **P7** (opt) | Keyboard round-nav (number keys / `j`+`k` with a visible highlight) + inline per-round detail block. **No** click-to-rescope-rail, **no** `selectedRound` driving the rail. | round-groups flag |

**Build order:** P0 first (independent win). Prototype P1/P6 against **synthetic
`council_round`/`council_meta` chunks injected directly** (not a live debate — a
≥3-round emergent debate is not deterministically reproducible via the mock, see
§7). P5 (real emit) must land **before or with** P6 (consume), or P6 keeps the
`CouncilDebatePill` fallback so `develop` never ships a half-working feed.

## 7. Testing (corrected — the v1 fixture plan was infeasible)

- **Round-group rendering**: drive via **synthetic `council_round` chunks**
  through the agent-mode input (or a dedicated fixture that emits pre-baked
  records), asserting on the semantic tree. Do **not** try to make the mock-llm
  produce ≥3 rounds incl. emergent — council uses the positional `sequence`
  fixture path (not `createMockModel`), emergent needs `extendRounds>0` which the
  lock-phrase detector (`debate.ts:153-187`) vetoes, and `council-flow.spec` is
  already CI-quarantined for 25–46s cold boots. Emergent/extend/break-path logic
  is **unit-tested** in `src/council/__tests__/` against `runDebate` internals,
  not E2E.
- **Scroll fix**: assert on the **boolean** `props.locked` / `props.newSinceLock`
  on `id="log"`, never on `scrollTop` — `determinism.spec.ts:118` strips
  `scrollTop` ("0 vs 1 flake") and `scroll.spec.ts` is `it.todo` for exactly this
  reason.
- **Rail**: force a **≥100-col PTY** in `spawnHarness` (default 80 → rail hidden →
  vacuous spec); add an explicit **resize-across-100** boundary test.
- **Consumer coverage**: a sub-session council-render assertion (the current
  sub-session spec has none) so a missed reducer site can't ship silently.
- Existing gates each phase: `bunx tsc --noEmit`, harness suite (Win + WSL),
  `lint:semantic`, `lint:harness-skips`, Tier-1 `self-verify`. Regenerate
  `tests/harness/auto/*` when structure changes; ensure no phase commits a render
  path that can throw (a mid-phase render exception → error toast → self-verify
  FAIL → pre-push blocked).

## 8. Rollout / kill-switch

All three flags **default OFF**, wired in a central `src/gsd/flags.ts`-style
module before any consumer reads them. Bake behind flags ≥1 release; flip to ON
only after the narrow-terminal fallback and sub-session paths are verified. The
engine content-emit **removal is coupled to the rail flag** so no configuration
ever loses metadata: rail ON → metadata in rail; rail OFF/narrow/headless →
metadata still in transcript.

## 9. Risks / mitigations (top)

- **Narrow-terminal metadata blackout** (the single most likely regression): rail
  auto-hides `<100` cols (80 is the harness/default width) → mitigated by gating
  content removal on the rail flag + inline fallback (§5.5).
- **Scroll fix silently dead in prod**: the 607 hook is agent-mode-only →
  register an unconditional observer or rely on native `_hasManualScroll`; verify
  manually in a real session, not just the harness.
- **Missed reducer site / sub-session drop**: shared `applyCouncilChunk` +
  default logging + sub-session spec (§5.4, §7).
- **Orphan "running" round**: guaranteed done-emit on all break paths (§5.5).
- **Eval JSON truncation** from `nextRoundFocus`: field-first + raised cap (§5.5).
- **Mouse hit-testing through a translated/culled scrollbox** is unproven → click
  is enhancement only; keyboard/inline is the contract.

## 10. Open items (defaults chosen; flag to change)

- Rail width 36 / hide threshold 100 — constants; 36 forces role+chip only.
- Non-council/non-ideal chat mode shows no rail (default).
- P7 round-nav interaction model (number keys vs `j/k` highlight) — deferred.

## 11. File touch map

`src/ui/app.tsx` (layout, scroll gating), `src/ui/use-app-logic.tsx` (scroll
gating 2070/1785/1811, reducer, state, keys), `src/ui/components/{context-rail,
council-round-group,jump-to-latest-pill,council-message-bubble}.tsx`,
`src/ui/containers/chat-feed.tsx` (delete/reconcile), `src/types/index.ts` +
`packages/agent-harness-core/src/protocol.ts` (chunks), `src/council/index.ts`
(`council_meta` patch 1), `src/council/debate.ts` (`council_meta` patch 2,
`council_round` lifecycle, gated content removal), `src/council/prompts.ts`
(`nextRoundFocus`), `src/orchestrator/{orchestrator,tool-engine}.ts` (gated header
removal), `src/gsd/flags.ts` (flags), `src/headless/council-answers.ts` (verify
fallback intact), `tests/harness/*`, `src/council/__tests__/*`.

## 12. Changelog vs v1 (what the adversarial review falsified)

- **Scroll-lock**: v1 "reuse `addPostProcessFn` (already wired 607)" — FALSE, that
  hook is `agentRuntime`-gated (agent-mode only). And the real fix is gating the
  forced-bottom calls (incl. the 1785/1811 bypasses v1 never mentioned) +
  leveraging native `_hasManualScroll`, not a new poll loop. → §5.1, P0-first.
- **`council_meta` one chunk**: FALSE — budget is a local in `runDebate`,
  unreachable from `index.ts`; fields arrive across two generators over time. →
  incremental patch (§4.1/§4.2/§5.5).
- **`council_round` "engine computes everything, just wire-up"**: FALSE — no
  single emit point; break paths (`pairs.length===0`, circuit breaker,
  `evaluation===null`) skip the eval and orphan rounds; round 1 has no
  topic/input. → lifecycle emit + guaranteed done + defaults (§5.5).
- **Remove content at the engine**: FALSE-unsafe — strips headless/legacy/narrow
  paths that have no rail. → gate removal on the rail flag + fallback (§5.5, §8).
- **Rail re-scopes on round select / click-to-open accordion**: rejected — hides
  the global overview the user asked for, recreates "rounds look empty", and the
  feed has no selection cursor so it's mouse-only. → rail always global; done
  rounds expanded inline; detail inline, not in rail (§3, §5.3, drop `selectedRound`).
- **Drop `model` per turn**: rejected — breaks who-said-what in mixed-model
  debates. → keep short model tag, drop word-count instead (§3, §5.3).
- **Flags default ON**: rejected — default-ON rewrite with no canary + content
  removal = silent loss. → default OFF, central wiring, bake first (§8).
- **≥3-round emergent mock fixture**: infeasible/flaky. → synthetic chunk
  injection for UI + unit tests for engine logic (§7).
- **Glyphs `▸▾◆↓`**: unproven under repo encoding. → ASCII-safe `●`/`✓`/`>`/`v`
  (§3). Also: `chat-feed.tsx` is an orphaned duplicate to delete first (§5.2);
  layout needs rail `flexShrink:0` + main `flexGrow:1` (§5.2);
  `End`/`PageUp/Down` must be composer-focus-aware (§5.1).

---

## 13. Implementation progress (session 2026-07-05)

Verified LIVE by driving the real agent-mode TUI (standalone bun driver, not
vitest — user preference [[verify-drive-tui-directly]]). Each phase committed.

- **P0 scroll-lock — DONE.** `MUONROI_SCROLL_LOCK` (default OFF). `scrollToBottom`
  respects OpenTUI `_hasManualScroll`; `scrollToBottomForced` re-pins (submit +
  End). `id=jump-to-latest` pill; End/PageUp/PageDown composer-aware; `id=log`
  exposes `props.locked`+`newSinceLock`. Live: PageUp→locked+pill, End→re-pin.
- **P1 rail skeleton — DONE.** `MUONROI_CONTEXT_RAIL` (default OFF). Row layout
  (main `flexGrow:1` + `ContextRail` `flexShrink:0`), auto-hide <100 cols, Ctrl+B
  toggle. Deleted orphan `containers/chat-feed.tsx`. Harness input-bridge now
  parses `C-/M-/S-` modifier prefixes (needed to drive Ctrl combos). Live: rail
  role=region, Ctrl+B hide/show.
- **P2 hoist council cards — DONE.** `renderCouncilMeta(cols)` fragment renders
  phases/product-status/statuses/info-cards inline (rail OFF) or in the rail
  (rail ON). Rail body scrolls. Live: `/council` → `context-rail` contains
  `council-phases`.
- **P3 council_meta rows — DONE.** New `council_meta` chunk + `CouncilMetaPatch`
  (leader/panel/roundBudget/roundCeiling/researchMode/costAware). Emitted from
  `council/index.ts` (leader/panel/research/cost) + `debate.ts` (budget/ceiling);
  upsert-merged; appended as rail rows. Consumed in all 3 council loops. Live:
  rail rowCount 3→8 on `/council`.
- **P4 rail for /ideal — COVERED by P2.** `productStatus` is inside
  `renderCouncilMeta`, so it hoists to the rail for any session incl. `/ideal`.
  No extra code; re-verify with a real `/ideal --force-council` run.

### REMAINING — P5 + P6 (round grouping, user complaint #2)

**P5 council_round emit (engine, `src/council/debate.ts`).** ADDITIVE yields only
(do not remove existing `content`/`council_status`/`council_message` emits —
headless/legacy sinks depend on them). Add a `council_round` chunk +
`CouncilRoundRecord` type ({round, topic, participants:string[], pairCount,
state:'running'|'done', criteriaMet, criteriaTotal, leaderReason, leaderDecision,
emergent:boolean}). Emit `state:'running'` at loop top (debate.ts:700, after
`roundCount=round`), then a GUARANTEED `state:'done'` on EVERY exit of the round
body with sensible defaults:
  - normal end-of-iteration after leader eval (debate.ts:1065 `if(evaluation)`
    branch → met/total/reason; and the `evaluation===null` branch ~1194 →
    done with `leaderReason:'evaluation unavailable'`).
  - `signal?.aborted` break (696), `pairs.length===0` break (726),
    circuit-breaker break (1048) — each must emit a `done` before `break`.
`nextRoundFocus` (per-round topic): add as the FIRST field of the leader-eval
JSON schema (`src/council/prompts.ts:442`) and RAISE the eval `maxTokens` (1024 →
~1536, debate.ts:1334) so a long focus line can't truncate+null the whole eval
(parsed by one `JSON.parse`, returns null on any failure). Feed the PRIOR round's
`nextRoundFocus` as the NEXT round's `topic` on the running emit. `emergent` =
round index > original `plannedMaxRounds` (extendRounds fired).
Consume `council_round` in all 3 council loops (mirror the P3 `council_meta`
pattern) → `councilRounds: CouncilRoundRecord[]` state, upsert by round number
(running then done overwrite). Reset with the other council state (`use-app-logic
~2140`).

**P6 round-grouped transcript UI (`src/ui/`).** New `council-round-group.tsx`:
one collapsible group per `CouncilRoundRecord`. ONLY the running round auto-opens;
done rounds render an EXPANDED-INLINE summary (topic, participants + per-member
task, criteria met/total, leader decision, metrics) — NOT a click-to-open
accordion (feed has no selection cursor → mouse-only; rejected in §5.3). Keep the
existing `CouncilDebatePill` as the fallback when `councilRounds` is empty (older
paths / no round data). Overall header: total rounds, total members, emergent
count. In the transcript render (app.tsx ~880 debate block), when
`isRoundGroupsEnabled()` (`MUONROI_ROUND_GROUPS`, default OFF) AND
`councilRounds.length>0`, render round groups keyed by round, folding
`councilMessages` into their round via `cm.round`; else keep the current pill.
Keep short model tag per turn, drop word-count (§3).

**Testing:** synthetic `council_round` chunk injection to exercise the UI without
a ≥3-round live debate (lock-phrase detector vetoes emergent rounds; hard to
force live). Engine emit: verify a live `/council` still completes and emits a
`done` record per round via the standalone driver (assert `councilRounds` all
`state:'done'` at debate end). Do NOT rely on vitest for the interactive check.

### P5 + P6 — DONE (2026-07-05, same session)

- **P5 council_round emit — DONE.** `council_round` chunk + `CouncilRoundRecord`.
  `runDebate` emits `running` at round start + guaranteed `done` on every exit
  (leader-eval branch, evaluation-null else, circuit-breaker break). Leader-eval
  gained `nextRoundFocus` (first schema field, maxTokens 1024→1536) → next round's
  topic. Consumed/upsert-merged in all 3 loops; reset with council state.
- **P6 round-grouped UI — DONE.** `CouncilRoundGroup` + `CouncilRoundsOverview`
  behind `MUONROI_ROUND_GROUPS`. Running round streams turns; done rounds show an
  expanded-inline summary (topic, members, criteria met/total, leader decision,
  next focus). Overview: total/emergent/members. Falls back to `CouncilDebatePill`
  when no round records. Verified live: `/council` → `council-rounds-overview`
  (total=3, members=2) + `council-round-1/2/3` regions.

**STATUS: all phases P0–P6 complete + verified live.** All 3 flags default OFF:
`MUONROI_SCROLL_LOCK`, `MUONROI_CONTEXT_RAIL`, `MUONROI_ROUND_GROUPS`.
