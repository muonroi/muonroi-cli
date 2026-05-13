# Council Debate Chat-Bubble UI — Design Spec

**Date:** 2026-05-13
**Status:** Draft, pending user review

## Problem

Council debate currently renders as a single flowing markdown stream. Headers like `──  Round 1 · **Frontend Engineer** → **Backend Engineer**  ──` separate turns, but the wall of text makes it hard to scan who said what across 3+ rounds with 2–4 participants. Users want a chat-app feel (WhatsApp/Telegram/Messenger) so they can follow the back-and-forth visually.

## Goal

Render council output as colored, labeled chat bubbles in the TUI:
- Alternating left/right alignment per pair-turn (speaker = left, partner-being-addressed = right).
- Stable color per role across the session, derived from a hash.
- Bubble width capped so it reads like a chat thread.
- Cover all council output kinds: debate turns, leader evaluations, round/final synthesis, research findings.

Non-goals: web-based UI; replacing markdown rendering inside bubbles; changing the debate algorithm itself.

## Layout

Anchored to WhatsApp's conversation view, adapted to a terminal.

### Bubble dimensions
- **Width:** `min(65% of terminal width, 100 cols)`. Indent the opposite side by `floor(terminal_width * 0.12)` to leave room for the alignment offset. Scales sensibly up to 160-col terminals.
- **No fixed height** — body wraps to width and renders all of it (text dài bao nhiêu show bấy nhiêu).
- Top border carries the role label; body uses Ink `<Text wrap="wrap">` (word-wrap; long unbreakable tokens like URLs/hashes break at character boundary); bottom footer carries stats.

### Alignment rule
For each pair-turn within a round:
- **Speaker = left**, body and footer aligned to column 0.
- **Partner (the one being addressed) = right**, indented so the right edge sits near terminal width.

Within one round, pair `A→B` puts A left and B right; the *next* turn in that pair `B→A` flips them. With multiple pairs, each pair gets its own left/right cycle — readers see the dialogue rhythm without losing track of who's responding.

**Known limitation:** with 3+ participants across multiple pairs, the L/R column alone carries no participant identity — color and label do the work. Acceptable per user direction (WhatsApp-style alternation is the explicit goal).

### Reply-quote header
Each debate bubble (except the very first turn of a debate) carries a 1-line quoted preview of the partner's previous turn — the WhatsApp reply-arrow pattern. ~80 chars of the partner's last turn, dimmed, prefixed with `↪`:
```
↪ Backend Eng: "…we should probably check the boundary before committing to RSC"
┌─ Frontend Engineer ──────────────────────────────────────┐
│ Fair point on the boundary. Here's what I'd add…         │
…
```
The quote excerpt is computed in the UI from the previously rendered partner bubble (kept in a per-pair ring buffer), so the producer doesn't need to carry it on the message.

### Bubble anatomy (debate turn)
```
┌─ Frontend Engineer · gpt-4o ──────────────────────┐
│ I think we should use React Server Components     │
│ here because the data fetching pattern matches    │
│ the boundary check we already have.               │
│                                                   │
│   export async function Page() {                  │
│     const data = await getData();                 │
│     return <View data={data} />;                  │
│   }                                               │
│                                                   │
│ …keeps the parent tree synchronous.               │
└── Round 1 → Backend · 142 words · tools: grep ────┘
```
Right-aligned variant indents the whole block.

### Other message kinds

**Leader evaluation** — centered "system" bubble with neutral gray border, narrower (40% width):
```
              ·─ Leader · round 2 eval ─·
              │ Continue: positions still │
              │ diverging on RSC tradeoff │
              ·──────────────────────────·
```

**Round / final synthesis** — full-width "pinned" banner with double-line border, accent color:
```
══ Final Synthesis ════════════════════════════════════════
  Decision: use RSC with strict boundary checks.
  See implementation snippet in Frontend Eng's Round 3 turn.
═══════════════════════════════════════════════════════════
```

**Research findings** — left-aligned bubble like debate but with role color and a `🔍` glyph prefix in label.

**Failed/skipped turn** — NOT a bubble. Renders as a single inline muted line, matching today's format, to avoid a wall of bordered failure boxes when a round has multiple failures or the circuit-breaker trips:
```
  ⨯  Frontend Engineer → Backend Engineer  (skipped: provider returned empty after retry)
```

**Precedence rule for retry/failure state:**
- `failureReason` non-empty ⇒ render inline skipped line (above), no bubble.
- Else if `attempts > 1` ⇒ render normal bubble with a `recovered on retry` badge in the footer.

## Content rendering inside bubbles

- **Plain text / markdown prose:** wrap to bubble width, render all of it.
- **Code blocks:**
  - Wrap to bubble inner width (no horizontal scroll).
  - If `> 30 lines`, truncate and append a dim footer line: `… N more lines — see /export for full source`. (30 chosen because debate frequently quotes mid-size functions; 15 was too aggressive and hid the thing being argued about.)
  - Keep syntax highlight via existing `mdCodeBlock*` theme tokens.
- **Lists / bold / italic:** render via existing markdown component.
- **Tool-call traces:** stay in `council_status` chunks (unchanged), not inside bubbles.

## Color palette

8-color palette mapped from a **first-seen registry**: the first distinct role encountered in a session gets slot 0, the next slot 1, etc. Wraps modulo 8 if more than 8 distinct roles appear (collision acceptable in that extreme; typical council has ≤ 4 participants). Beats `hash(role) % 8` because role-name collisions across the small palette are likely (~70% birthday-paradox probability with 6 names).

| Slot | Ink color | Typical role |
|------|-----------|--------------|
| 0 | cyan      | Frontend Engineer |
| 1 | magenta   | Backend Engineer |
| 2 | yellow    | Security Engineer |
| 3 | green     | DevOps Engineer |
| 4 | blue      | Product Manager |
| 5 | red       | QA Engineer |
| 6 | white     | (fallback / overflow) |
| 7 | gray      | (fallback / overflow) |

Same role string ⇒ same color within a session. Color applies to: border, label, side-indent rule. Body text stays default foreground so wall-of-text doesn't tint.

**a11y / `NO_COLOR`:** when the env var `NO_COLOR` is set, the palette collapses to default foreground. To preserve role differentiation without color, each slot also has a sigil that prefixes the label: `●` `◆` `▲` `★` `■` `◐` `◇` `△`. The sigil is rendered whether color is on or off, so two same-colored bubbles (under wrap) remain distinguishable.

Leader = `textMuted` gray. Synthesis = `accent` (#5c9cf5). Research = role color.

No user override in v1. If demand surfaces later, add `council.colors` map to settings.

## Data flow

### New stream chunk type
Add to `src/types/index.ts`:
```ts
export type CouncilMessageKind = "debate" | "leader" | "synthesis" | "research";

export interface CouncilMessage {
  kind: CouncilMessageKind;
  speaker: { role: string; model: string };
  partner?: { role: string };         // debate turns only
  round?: number;                     // debate / leader only
  text: string;                       // raw markdown body
  toolCalls?: { name: string }[];
  attempts?: number;                  // >1 ⇒ "recovered on retry" badge in footer
  failureReason?: string;             // present ⇒ inline skipped line (NOT a bubble)
  runId?: string;                     // optional, reserved for future multi-session demux
}

// Append to StreamChunk union:
| { type: "council_message"; councilMessage: CouncilMessage }
```

Fields intentionally NOT on the message:
- `wordCount` / `charCount` — UI derives from `text` (matches existing `debate.ts:686–688` inline math).
- `durationMs` — comes via paired `council_status` start/done timing if needed.
- `side` (left/right) — pure UI concern. Consumer maintains a per-pair `{firstSeenRole → "left"}` map and assigns the other to `"right"`. Producer stays presentation-agnostic and survives resume scenarios cleanly.

### Streaming / placeholder bubbles

Today's `debate.ts` awaits a full pair-turn before yielding (10–60s of silence). Under bubbles that becomes a visible gap before each turn appears. Mitigation:

- At turn-start, the producer emits a `council_status` chunk with `state: "start"` and the speaker label (already wired via `tracedAsync`). The UI shows a thin animated placeholder bubble: `┌─ Frontend Engineer · composing… ─┐` on the side the eventual bubble will use.
- When the `council_message` arrives, the placeholder is swapped for the real bubble. Implementation: placeholders are kept in component state keyed by `statusId`; on `council_message` arrival the matching placeholder resolves.
- Token-level streaming inside the bubble is out of scope for v1.

### Producer changes (`src/council/debate.ts`)
- Where today it yields `{ type: "content", content: "<header>\n<body>\n<footer>" }` for each pair-turn (lines ~675–696), instead yield `{ type: "council_message", councilMessage: { kind: "debate", … } }`.
- For failed turns (`isFailedTurn(chunk.text)` or `chunk.failureReason` set), KEEP yielding the existing inline `content` line — do NOT emit a `council_message`. This avoids a wall of bordered failure boxes when a round has multiple failures or the circuit-breaker trips.
- Keep the existing `council_status` text emission for transcript persistence (`[Council Round N]…` at lines ~732–747) unchanged. Discipline: when adding a new field to `CouncilMessage` later, also extend the text rollup at the persistence callsite so `/export` and resume stay informationally equivalent.
- Replace the "## Discussion Round N" markdown header with a thin divider chunk (`{ type: "content", content: "\n── Round N ──\n" }`) so the round break still shows.
- Same pattern for leader eval (`buildLeaderEvaluationPrompt` callsite), round/final synthesis, and research-runner output.

### Consumer changes (`src/ui/`)
- New component `src/ui/components/council-message-bubble.tsx` exporting `<CouncilMessageBubble msg={CouncilMessage} terminalCols={number} />`.
- Internal helpers (same file or `theme.ts` extension):
  - `useRolePalette()` hook — returns a `(role) ⇒ { color, sigil }` function backed by a per-session first-seen registry (stable within a run; resets on new session).
  - `computeBubbleLayout(cols)` — returns `{ bubbleCols, leftIndent, rightIndent }` per the `min(65%, 100 cols)` rule with 12% indent.
  - `truncateCodeBlocks(text, maxLines=30)` — pre-process markdown to chop long fenced blocks and append `… N more lines — see /export` line.
  - `usePairSideMap()` hook — UI-side per-pair memory mapping the first-seen speaker of a pair to `"left"`.
- `src/ui/app.tsx`: handle new chunk type, route to `<CouncilMessageBubble>`; for `kind: "synthesis"` use the wider pinned-banner variant; for `kind: "leader"` use the centered narrow variant.
- `/export` and transcript reader (`src/storage/transcript.ts`) keep reading the existing text format from `council_status` — no migration needed.

## Files touched

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `CouncilMessage` + chunk variant |
| `src/council/debate.ts` | Emit `council_message` chunks for debate/leader/synthesis turns |
| `src/council/leader.ts` | Emit `council_message` for leader evaluation |
| `src/council/index.ts` (or wherever research runs) | Emit `council_message` for research findings |
| `src/ui/theme.ts` | Add `councilPalette` (8 Ink colors), `councilLeader`, `councilSynthesis` |
| `src/ui/components/council-message-bubble.tsx` | **NEW** — bubble component + layout helpers |
| `src/ui/app.tsx` | Route `council_message` chunk type to new component |
| `src/storage/transcript.ts` | No change — keep reading `council_status` text |

Existing files stay below ~800 LOC after changes; the new component is self-contained at ~200 LOC.

## Testing

- Unit: first-seen role-palette registry returns stable color+sigil within a session; `computeBubbleLayout` math for cols ∈ {80, 100, 120, 160}; `truncateCodeBlocks` honours the 30-line threshold and preserves fence language hint; `failureReason` precedence over `attempts > 1`.
- Integration: snapshot a `<CouncilMessageBubble>` for each `kind` at three widths.
- Manual: run `/council` against a real debate session, eyeball alternating L/R alignment over 3 rounds + 2 pairs.

## Out of scope (v1)

- User-configurable colors (settings.json override).
- Collapsible / foldable long bubbles.
- Avatar glyphs beyond the `🔍` research prefix.
- Per-message timestamps inside bubbles (footer carries duration only; clock time is in transcript).
- Web/HTML rendering — TUI only.

## Risks

- **Terminal width < 80 cols:** bubble math degenerates. Fallback: if `cols < 70`, render the existing flat header+body+footer format instead of bubbles.
- **Terminal resize mid-debate:** bubbles already committed to Ink's `<Static>` are frozen at their emit-time width — resizing reflows only new bubbles. Acceptable trade vs. the cost of reflowing history. Documented behavior, not a bug.
- **Backward compat:** older transcripts persisted before this change have no `council_message` chunks — they live in `council_status` text and are read by `transcript.ts` exactly as today. The new code path produces both formats, so live new sessions and old replays both work.
- **Markdown inside narrow bubbles:** tables especially will look bad. Acceptable trade — debate turns rarely emit tables; if they do, they'll wrap visibly. Future iteration can detect tables and break them out full-width like code blocks.
- **Copy/paste pollution:** Unicode box borders get included when users select bubble text in most terminals. `/export` reads clean text from `council_status` so exports are unaffected; for ad-hoc copy/paste, document the alt/option-drag workaround in TUI help.
