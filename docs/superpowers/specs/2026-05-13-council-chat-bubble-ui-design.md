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
- **Width:** `min(60% of terminal width, 80 cols)`. Indent the opposite side by `floor(terminal_width * 0.15)` to leave room for the alignment offset.
- **No fixed height** — body wraps to width and renders all of it (text dài bao nhiêu show bấy nhiêu).
- Top border carries the role label; body uses Ink `<Text wrap="wrap">`; bottom footer carries stats.

### Alignment rule
For each pair-turn within a round:
- **Speaker = left**, body and footer aligned to column 0.
- **Partner (the one being addressed) = right**, indented so the right edge sits near terminal width.

Within one round, pair `A→B` puts A left and B right; the *next* turn in that pair `B→A` flips them. With multiple pairs, each pair gets its own left/right cycle — readers see the dialogue rhythm without losing track of who's responding.

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

**Failed/skipped turn** — single-line muted bubble:
```
┌─ Frontend Engineer ─ skipped ──────┐
│ provider returned empty after retry │
└─────────────────────────────────────┘
```

## Content rendering inside bubbles

- **Plain text / markdown prose:** wrap to bubble width, render all of it.
- **Code blocks:**
  - Wrap to bubble inner width (no horizontal scroll).
  - If `> 15 lines`, truncate and append a dim footer line: `… 23 more lines — see /export for full source`.
  - Keep syntax highlight via existing `mdCodeBlock*` theme tokens.
- **Lists / bold / italic:** render via existing markdown component.
- **Tool-call traces:** stay in `council_status` chunks (unchanged), not inside bubbles.

## Color palette

8-color palette mapped from `hash(role) % 8`:

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

Same role string ⇒ same color across rounds and sessions. Color applies to: border, label, side-indent rule. Body text stays default foreground so wall-of-text doesn't tint.

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
  wordCount?: number;
  charCount?: number;
  durationMs?: number;
  attempts?: number;                  // >1 ⇒ "recovered on retry"
  failureReason?: string;             // present ⇒ skipped variant
  side?: "left" | "right";            // computed in debate.ts per pair-turn
}

// Append to StreamChunk union:
| { type: "council_message"; councilMessage: CouncilMessage }
```

### Producer changes (`src/council/debate.ts`)
- Where today it yields `{ type: "content", content: "<header>\n<body>\n<footer>" }` for each pair-turn (lines ~675–696), instead yield `{ type: "council_message", councilMessage: { kind: "debate", … } }`.
- Compute `side`: speaker = `"left"`, partner-addressed turn = `"right"`. With multi-pair rounds, side is per-pair-local — pair `A↔B` always has A=left, B=right; pair `C↔D` always has C=left, D=right.
- Keep the existing `council_status` text emission for transcript persistence (`[Council Round N]…`) unchanged. Bubble rendering is purely a UI concern; transcript stays text-based.
- Replace the "## Discussion Round N" markdown header with a thin divider chunk (`{ type: "content", content: "\n── Round N ──\n" }`) so the round break still shows.
- Same pattern for leader eval (`buildLeaderEvaluationPrompt` callsite), round/final synthesis, and research-runner output.

### Consumer changes (`src/ui/`)
- New component `src/ui/components/council-message-bubble.tsx` exporting `<CouncilMessageBubble msg={CouncilMessage} terminalCols={number} />`.
- Internal helpers (same file or `theme.ts` extension):
  - `pickRoleColor(role: string): InkColor` — FNV-style hash mod 8.
  - `computeBubbleLayout(cols)` — returns `{ bubbleCols, leftIndent, rightIndent }`.
  - `truncateCodeBlocks(text, maxLines=15)` — pre-process markdown to chop long fenced blocks and append `… N more lines — see /export` line.
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

- Unit: `pickRoleColor` stability across runs; `computeBubbleLayout` math for cols ∈ {80, 120, 200}; `truncateCodeBlocks` honours the 15-line threshold and preserves fence language hint.
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
- **Backward compat:** older transcripts persisted before this change have no `council_message` chunks. UI must still handle the old `content`-only format gracefully — keep current renderer as default for any `content` chunk that isn't preceded by a `council_message`.
- **Markdown inside narrow bubbles:** tables especially will look bad. Acceptable trade — debate turns rarely emit tables; if they do, they'll wrap visibly. Future iteration can detect tables and break them out full-width like code blocks.
