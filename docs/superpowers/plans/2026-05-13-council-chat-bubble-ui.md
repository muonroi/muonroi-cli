# Council Debate Chat-Bubble UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat markdown stream of council debate output with WhatsApp-style chat bubbles — left/right-aligned, role-colored, with reply-quote headers and distinct variants for debate, leader evaluation, synthesis, and research.

**Architecture:** A new `CouncilMessage` stream chunk type carries all structured council turn data. The producer (`debate.ts`, `planner.ts`) emits these instead of raw `content` yields for successful turns; failures stay as inline muted `content` lines. New Ink components in `src/ui/components/` render each variant. `app.tsx` routes the new chunk type to these components; the existing `council_status` text path is untouched (used for persistence and transcript).

**Tech Stack:** TypeScript, Ink (React for terminals), vitest, biome

---

## Spec Source

`docs/superpowers/specs/2026-05-13-council-chat-bubble-ui-design.md`

---

## Code Survey — Integration Points (verified against source)

| Location | Actual state |
|---|---|
| `src/types/index.ts:329–362` | `StreamChunk` is an interface with a union `type` field string literal + optional payload fields. No discriminated union. New chunk adds `"council_message"` to the union string and a `councilMessage?: CouncilMessage` optional field. |
| `src/council/debate.ts:629` | `yield { type: "content", content: \`\n## Discussion Round ${round}\n\` }` — replace with thin divider chunk |
| `src/council/debate.ts:675–695` | Failure line already yields inline `content`. Success yields two `content` chunks (header+body, then footer). Replace the success branch only with `council_message`. |
| `src/council/debate.ts:732–747` | `council_status` persistence block — **do NOT touch**. |
| `src/council/debate.ts:306` | `yield { type: "content", content: \`\n### Research findings\n${researchFindings}\n\` }` — replace with `council_message{kind:"research"}`. |
| `src/council/debate.ts:792–795` | Leader evaluation: `yield { type: "content", content: \`\n> **Leader evaluation:** ...\n\` }` — replace with `council_message{kind:"leader"}`. |
| `src/council/planner.ts:113–121` | Synthesis: `yield { type: "content", content: "\n## Synthesis\n" }` + body — replace with `council_message{kind:"synthesis"}`. |
| `src/ui/app.tsx:2502–2516` | `case "council_status":` / `case "council_phase":` switch arms. Add `case "council_message":` here (and in the two `if` chains at 2873 and 2991). |
| `src/ui/theme.ts` | No `councilPalette` yet — add 8-slot palette + sigil array + leader/synthesis border keys. |
| `src/council/leader.ts` | Contains sub-task model picker only; no yield site. Leader eval yield is in `debate.ts:792–795`. No separate `leader.ts` yield to change. **Spec's T11 ("leader.ts producer changes") is partially misrouted — actual emit is in `debate.ts`.** |

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types/index.ts` | Add `CouncilMessageKind`, `CouncilMessage` interface, `"council_message"` to `StreamChunk` type union + `councilMessage?` field |
| `src/ui/theme.ts` | Add `councilPalette` (8 Ink color names), `councilSigils` array, `councilLeaderBorder`, `councilSynthesisBorder` tokens |
| `src/ui/components/role-palette.ts` | `useRolePalette()` hook — first-seen role → `{color, sigil}` registry; `NO_COLOR` fallback |
| `src/ui/components/bubble-layout.ts` | `computeBubbleLayout(cols)` pure function; `usePairSideMap()` hook — per-pair `{pairKey → firstSeenSpeaker}` memory |
| `src/ui/components/code-block-truncate.ts` | `truncateCodeBlocks(text, maxLines?)` pure function — chop fenced blocks > 30 lines, preserve language hint |
| `src/ui/components/council-message-bubble.tsx` | `<CouncilMessageBubble msg councilCols terminalCols>` — debate variant with reply-quote header, recovered badge |
| `src/ui/components/council-placeholder-bubble.tsx` | `<CouncilPlaceholderBubble role side terminalCols>` — thin "composing…" animated placeholder |
| `src/ui/components/council-leader-bubble.tsx` | `<CouncilLeaderBubble msg terminalCols>` — centered narrow gray bordered variant |
| `src/ui/components/council-synthesis-banner.tsx` | `<CouncilSynthesisBanner msg>` — full-width double-border pinned banner |
| `src/council/debate.ts` | Replace success `content` yields with `council_message`; replace `## Discussion Round N` header with thin divider; replace research findings `content` with `council_message`; replace leader eval `content` with `council_message` |
| `src/council/planner.ts` | Replace synthesis `content` yields with `council_message{kind:"synthesis"}` |
| `src/ui/app.tsx` | Add `council_message` chunk routing in all three handler locations; manage placeholder state keyed by `statusId` |
| `src/__tests__/council/code-block-truncate.test.ts` | Unit tests for `truncateCodeBlocks` |
| `src/__tests__/council/bubble-layout.test.ts` | Unit tests for `computeBubbleLayout` at cols ∈ {70, 80, 100, 120, 160} |
| `src/__tests__/council/role-palette.test.ts` | Unit tests for `useRolePalette` stability, NO_COLOR fallback, >8 roles wrap |
| `src/__tests__/council/council-message-bubble.test.tsx` | Snapshot tests for bubble variants |

All new files target <300 LOC.

---

## Tasks

---

### Task 1: Add `CouncilMessage` types and `council_message` chunk variant

**Files:**
- Modify: `src/types/index.ts` (around line 329)
- Test: none (type-only; compile verification)

- [ ] **Step 1: Add `CouncilMessageKind` and `CouncilMessage` to `src/types/index.ts`**

Open `src/types/index.ts`. Find the `StreamChunk` interface (currently around line 329). Insert the following **above** the `StreamChunk` interface:

```ts
export type CouncilMessageKind = "debate" | "leader" | "synthesis" | "research";

export interface CouncilMessage {
  kind: CouncilMessageKind;
  speaker: { role: string; model: string };
  partner?: { role: string };       // debate turns only
  round?: number;                   // debate / leader only
  text: string;                     // raw markdown body
  toolCalls?: { name: string }[];
  attempts?: number;                // >1 → "recovered on retry" badge
  failureReason?: string;           // present → render inline skipped line, not a bubble
  runId?: string;                   // reserved for future multi-session demux
}
```

- [ ] **Step 2: Add `"council_message"` to the `StreamChunk` type union**

In the same file, extend the `type` string union inside `StreamChunk`:

```ts
// Before (line ~330):
  type:
    | "content"
    | "tool_calls"
    | "tool_result"
    | "tool_approval_request"
    | "council_question"
    | "council_preflight"
    | "council_status"
    | "council_phase"
    | "done"
    | "error"
    | "reasoning"
    | "structured_response"
    | "product_status_card"
    | "experience_warning"
    | "experience_injected"
    | "push_notification";

// After — append the new variant:
  type:
    | "content"
    | "tool_calls"
    | "tool_result"
    | "tool_approval_request"
    | "council_question"
    | "council_preflight"
    | "council_status"
    | "council_phase"
    | "done"
    | "error"
    | "reasoning"
    | "structured_response"
    | "product_status_card"
    | "experience_warning"
    | "experience_injected"
    | "push_notification"
    | "council_message";
```

- [ ] **Step 3: Add the `councilMessage` optional payload field to `StreamChunk`**

Inside the same `StreamChunk` interface body, add after the `councilPhase?` field:

```ts
  councilMessage?: CouncilMessage;
```

- [ ] **Step 4: Verify TypeScript compiles clean**

```bash
npx tsc --noEmit
```

Expected: zero errors related to the new types. Ignore pre-existing unrelated errors if any.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(council): add CouncilMessage type + council_message StreamChunk variant"
```

---

### Task 2: `truncateCodeBlocks` pure helper

**Files:**
- Create: `src/ui/components/code-block-truncate.ts`
- Create: `src/__tests__/council/code-block-truncate.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/council/code-block-truncate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { truncateCodeBlocks } from "../../ui/components/code-block-truncate.js";

describe("truncateCodeBlocks", () => {
  it("leaves short code blocks untouched", () => {
    const text = "```ts\nconst x = 1;\n```";
    expect(truncateCodeBlocks(text)).toBe(text);
  });

  it("truncates a block with exactly 31 lines to 30 + footer", () => {
    const lines = Array.from({ length: 31 }, (_, i) => `line${i + 1}`).join("\n");
    const text = `\`\`\`ts\n${lines}\n\`\`\``;
    const result = truncateCodeBlocks(text);
    const kept = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n");
    expect(result).toContain(`\`\`\`ts\n${kept}`);
    expect(result).toContain("… 1 more line");
    expect(result).toContain("/export");
  });

  it("preserves fence language hint after truncation", () => {
    const lines = Array.from({ length: 40 }, () => "x").join("\n");
    const text = `\`\`\`python\n${lines}\n\`\`\``;
    const result = truncateCodeBlocks(text);
    expect(result).toMatch(/^```python/m);
    expect(result).toContain("… 10 more lines");
  });

  it("handles multiple fenced blocks — truncates only long ones", () => {
    const shortBlock = "```js\nconst a = 1;\n```";
    const longLines = Array.from({ length: 35 }, (_, i) => `line${i}`).join("\n");
    const longBlock = `\`\`\`js\n${longLines}\n\`\`\``;
    const text = `${shortBlock}\n\n${longBlock}`;
    const result = truncateCodeBlocks(text);
    expect(result).toContain("const a = 1;");
    expect(result).toContain("… 5 more lines");
  });

  it("handles a block with exactly 30 lines (boundary — no truncation)", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const text = `\`\`\`\n${lines}\n\`\`\``;
    expect(truncateCodeBlocks(text)).toBe(text);
  });

  it("uses custom maxLines param", () => {
    const lines = Array.from({ length: 10 }, () => "x").join("\n");
    const text = `\`\`\`\n${lines}\n\`\`\``;
    const result = truncateCodeBlocks(text, 5);
    expect(result).toContain("… 5 more lines");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail (module not found)**

```bash
npx vitest run src/__tests__/council/code-block-truncate.test.ts
```

Expected: FAIL — `Cannot find module '../../ui/components/code-block-truncate.js'`

- [ ] **Step 3: Implement `code-block-truncate.ts`**

Create `src/ui/components/code-block-truncate.ts`:

```ts
/**
 * Truncates fenced code blocks that exceed maxLines.
 * Appends a dim footer line indicating how many lines were hidden.
 * Preserves fence language hint.
 *
 * Pure function — no side effects, safe to call in tests without Ink.
 */
export function truncateCodeBlocks(text: string, maxLines = 30): string {
  // Match fenced blocks: opening fence (with optional language), body, closing fence.
  // Multiline flag required because we scan across newlines.
  const FENCE_RE = /^(```[^\n]*)\n([\s\S]*?)^```/gm;

  return text.replace(FENCE_RE, (match, openFence: string, body: string) => {
    const bodyLines = body.split("\n");
    // Remove trailing empty line that appears before the closing ``` (artifact of split)
    const contentLines = bodyLines.at(-1) === "" ? bodyLines.slice(0, -1) : bodyLines;

    if (contentLines.length <= maxLines) {
      return match;
    }

    const hidden = contentLines.length - maxLines;
    const kept = contentLines.slice(0, maxLines).join("\n");
    const footer = `… ${hidden} more line${hidden === 1 ? "" : "s"} — see /export for full source`;
    return `${openFence}\n${kept}\n\`\`\`\n${footer}`;
  });
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/council/code-block-truncate.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/code-block-truncate.ts src/__tests__/council/code-block-truncate.test.ts
git commit -m "feat(council): add truncateCodeBlocks pure helper with 30-line threshold"
```

---

### Task 3: `computeBubbleLayout` and `usePairSideMap`

**Files:**
- Create: `src/ui/components/bubble-layout.ts`
- Create: `src/__tests__/council/bubble-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/council/bubble-layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeBubbleLayout } from "../../ui/components/bubble-layout.js";

describe("computeBubbleLayout", () => {
  it("uses fallback mode when cols < 70", () => {
    const layout = computeBubbleLayout(60);
    expect(layout.fallback).toBe(true);
  });

  it("cols=70 is exactly at the threshold — no fallback", () => {
    const layout = computeBubbleLayout(70);
    expect(layout.fallback).toBe(false);
  });

  it("cols=80 — bubbleCols ≤ 100 and = floor(65% of 80)", () => {
    const layout = computeBubbleLayout(80);
    expect(layout.fallback).toBe(false);
    expect(layout.bubbleCols).toBe(Math.min(Math.floor(80 * 0.65), 100));
    expect(layout.leftIndent).toBe(0);
    expect(layout.rightIndent).toBe(Math.floor(80 * 0.12));
  });

  it("cols=100 — bubbleCols = 65, rightIndent = 12", () => {
    const layout = computeBubbleLayout(100);
    expect(layout.bubbleCols).toBe(65);
    expect(layout.rightIndent).toBe(12);
  });

  it("cols=120 — bubbleCols capped at 100 when 65% exceeds 100", () => {
    // 65% of 120 = 78 < 100, so not capped
    const layout = computeBubbleLayout(120);
    expect(layout.bubbleCols).toBe(Math.min(Math.floor(120 * 0.65), 100));
    expect(layout.rightIndent).toBe(Math.floor(120 * 0.12));
  });

  it("cols=160 — bubbleCols capped at 100 (65% = 104 > 100)", () => {
    const layout = computeBubbleLayout(160);
    expect(layout.bubbleCols).toBe(100);
    expect(layout.rightIndent).toBe(Math.floor(160 * 0.12));
  });

  it("leaderCols = 40% of terminal width", () => {
    const layout = computeBubbleLayout(100);
    expect(layout.leaderCols).toBe(40);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/council/bubble-layout.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bubble-layout.ts`**

Create `src/ui/components/bubble-layout.ts`:

```ts
import { useState, useCallback } from "react";

export interface BubbleLayout {
  /** When true, terminal is too narrow for bubbles — use flat format */
  fallback: boolean;
  /** Inner content width for debate bubbles */
  bubbleCols: number;
  /** Left-side bubble indent (always 0 — left aligns to column 0) */
  leftIndent: number;
  /** Right-side bubble indent so the right edge sits near terminal right */
  rightIndent: number;
  /** Width for leader evaluation bubble (40% of terminal) */
  leaderCols: number;
}

/**
 * Compute bubble layout geometry from terminal column count.
 *
 * Rules (from spec):
 * - If cols < 70: fallback mode (flat markdown header/body/footer).
 * - bubbleCols = min(floor(cols * 0.65), 100)
 * - rightIndent = floor(cols * 0.12)  — indents the right bubble so its
 *   right edge sits near the terminal right margin.
 * - leaderCols = floor(cols * 0.40)   — narrower centered system bubble.
 *
 * Pure function — deterministic, no side effects.
 */
export function computeBubbleLayout(cols: number): BubbleLayout {
  if (cols < 70) {
    return { fallback: true, bubbleCols: cols, leftIndent: 0, rightIndent: 0, leaderCols: cols };
  }

  const bubbleCols = Math.min(Math.floor(cols * 0.65), 100);
  const rightIndent = Math.floor(cols * 0.12);
  const leaderCols = Math.floor(cols * 0.4);

  return { fallback: false, bubbleCols, leftIndent: 0, rightIndent, leaderCols };
}

export type PairSide = "left" | "right";

/**
 * Per-pair side map hook.
 *
 * Maintains a registry of {pairKey → firstSeenSpeakerRole}.
 * The first speaker of a pair is always "left"; the other is "right".
 * Within one round/turn, A→B is left/right; B→A flips them.
 *
 * pairKey convention: alphabetically sorted role names joined by "↔",
 * e.g. "BackendEngineer↔FrontendEngineer". The producer should use the
 * same convention, but since side assignment is purely UI, the key can
 * be derived here from the two role names.
 */
export function usePairSideMap(): (pairKey: string, speakerRole: string) => PairSide {
  const [registry] = useState(() => new Map<string, string>());

  return useCallback(
    (pairKey: string, speakerRole: string): PairSide => {
      if (!registry.has(pairKey)) {
        registry.set(pairKey, speakerRole);
      }
      return registry.get(pairKey) === speakerRole ? "left" : "right";
    },
    [registry],
  );
}

/**
 * Build a canonical pair key from two role names (order-independent).
 */
export function makePairKey(roleA: string, roleB: string): string {
  return [roleA, roleB].sort().join("↔");
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/council/bubble-layout.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/bubble-layout.ts src/__tests__/council/bubble-layout.test.ts
git commit -m "feat(council): add computeBubbleLayout + usePairSideMap helpers"
```

---

### Task 4: `useRolePalette` hook

**Files:**
- Create: `src/ui/components/role-palette.ts`
- Create: `src/__tests__/council/role-palette.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/council/role-palette.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Factory: returns a fresh registry (simulates new hook call per-session)
function makeRegistry() {
  const map = new Map<string, number>();
  let next = 0;
  return function getSlot(role: string): number {
    if (!map.has(role)) {
      map.set(role, next % 8);
      next++;
    }
    return map.get(role)!;
  };
}

import { COUNCIL_PALETTE, COUNCIL_SIGILS } from "../../ui/components/role-palette.js";

describe("COUNCIL_PALETTE", () => {
  it("has exactly 8 entries", () => {
    expect(COUNCIL_PALETTE).toHaveLength(8);
  });

  it("slot 0 is cyan", () => {
    expect(COUNCIL_PALETTE[0]).toBe("cyan");
  });
});

describe("COUNCIL_SIGILS", () => {
  it("has exactly 8 entries", () => {
    expect(COUNCIL_SIGILS).toHaveLength(8);
  });
});

describe("role slot registry", () => {
  it("assigns stable slots within a session", () => {
    const getSlot = makeRegistry();
    const slot1 = getSlot("Frontend Engineer");
    const slot2 = getSlot("Frontend Engineer");
    expect(slot1).toBe(slot2);
  });

  it("assigns different slots to different roles", () => {
    const getSlot = makeRegistry();
    const a = getSlot("Frontend Engineer");
    const b = getSlot("Backend Engineer");
    expect(a).not.toBe(b);
  });

  it("wraps modulo 8 when >8 distinct roles appear", () => {
    const getSlot = makeRegistry();
    for (let i = 0; i < 8; i++) getSlot(`Role${i}`);
    // 9th role should wrap to slot 0
    expect(getSlot("Role9")).toBe(0);
  });

  it("NO_COLOR: collapses palette to 'default'", () => {
    process.env.NO_COLOR = "1";
    const { resolveRoleStyle } = require("../../ui/components/role-palette.js");
    // Re-import after env set is handled inline via the function
    const style = resolveRoleStyle(0, true /* noColor */);
    expect(style.color).toBe("white");
    delete process.env.NO_COLOR;
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/council/role-palette.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `role-palette.ts`**

Create `src/ui/components/role-palette.ts`:

```ts
import { useState, useCallback } from "react";

/**
 * 8-slot Ink color palette for council roles.
 * Slot order matches spec Table (slot 0 = cyan, etc.).
 */
export const COUNCIL_PALETTE: readonly string[] = [
  "cyan",
  "magenta",
  "yellow",
  "green",
  "blue",
  "red",
  "white",
  "gray",
] as const;

/**
 * Sigils for NO_COLOR mode — ensures role identity survives color-off.
 * Same slot order as COUNCIL_PALETTE.
 */
export const COUNCIL_SIGILS: readonly string[] = [
  "●",
  "◆",
  "▲",
  "★",
  "■",
  "◐",
  "◇",
  "△",
] as const;

export interface RoleStyle {
  color: string;
  sigil: string;
}

/**
 * Resolve color + sigil for a palette slot index.
 *
 * @param slot   0–7 palette index
 * @param noColor when true (NO_COLOR env), color collapses to "white"
 */
export function resolveRoleStyle(slot: number, noColor: boolean): RoleStyle {
  const sigil = COUNCIL_SIGILS[slot % COUNCIL_SIGILS.length] ?? "●";
  if (noColor) {
    return { color: "white", sigil };
  }
  const color = COUNCIL_PALETTE[slot % COUNCIL_PALETTE.length] ?? "white";
  return { color, sigil };
}

/**
 * React hook: returns a stable `(role) => RoleStyle` resolver.
 *
 * First-seen assignment: the first distinct role string encountered in
 * a session gets slot 0, the next slot 1, etc., wrapping modulo 8.
 *
 * Reset on mount (per-session). Safe to call in multiple components —
 * each hook call has its own independent registry; wire it once at the
 * council container level and pass the resolver down as a prop.
 */
export function useRolePalette(): (role: string) => RoleStyle {
  const noColor = Boolean(process.env.NO_COLOR);
  const [registry] = useState(() => new Map<string, number>());
  const [nextSlot, setNextSlot] = useState(0);

  return useCallback(
    (role: string): RoleStyle => {
      if (!registry.has(role)) {
        const slot = nextSlot % 8;
        registry.set(role, slot);
        setNextSlot((n) => n + 1);
        return resolveRoleStyle(slot, noColor);
      }
      return resolveRoleStyle(registry.get(role)!, noColor);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, nextSlot, noColor],
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/council/role-palette.test.ts
```

Expected: all tests PASS. The `require` in the NO_COLOR test is acceptable for dynamic re-import; if it fails due to ESM, change the `resolveRoleStyle` import to a static import at top and call `resolveRoleStyle(0, true)` directly — no re-import needed.

- [ ] **Step 5: Fix NO_COLOR test if ESM prevents `require`**

If Step 4 fails because `require` is not available in ESM, update the NO_COLOR test:

```ts
import { resolveRoleStyle } from "../../ui/components/role-palette.js";

it("NO_COLOR: collapses color to 'white'", () => {
  // resolveRoleStyle accepts noColor as a parameter — test directly
  const style = resolveRoleStyle(0, true);
  expect(style.color).toBe("white");
  expect(style.sigil).toBe("●");
});
```

Re-run: `npx vitest run src/__tests__/council/role-palette.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/role-palette.ts src/__tests__/council/role-palette.test.ts
git commit -m "feat(council): add useRolePalette hook with first-seen registry and NO_COLOR fallback"
```

---

### Task 5: Theme additions

**Files:**
- Modify: `src/ui/theme.ts`

- [ ] **Step 1: Add council palette tokens to the `dark` theme object**

Open `src/ui/theme.ts`. The `dark` const currently ends with `syntaxAttr`. Append the following before the closing `} as const`:

```ts
  // ── Council bubble tokens ────────────────────────────────────────────────
  councilLeaderBorder: "#666666",   // textMuted gray — neutral evaluation bubble
  councilSynthesisBorder: "#5c9cf5", // accent blue — final synthesis banner
```

The color palette (8 Ink color names) and sigil array are kept in `role-palette.ts` as constants rather than on the theme object — they reference Ink named colors, not hex values, so they don't belong in the hex-keyed theme map.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/theme.ts
git commit -m "feat(council): add councilLeaderBorder + councilSynthesisBorder to theme"
```

---

### Task 6: `<CouncilMessageBubble>` — debate variant

**Files:**
- Create: `src/ui/components/council-message-bubble.tsx`
- Create: `src/__tests__/council/council-message-bubble.test.tsx`

- [ ] **Step 1: Write snapshot tests**

Create `src/__tests__/council/council-message-bubble.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CouncilMessageBubble } from "../../ui/components/council-message-bubble.js";
import type { CouncilMessage } from "../../types/index.js";

// Minimal debate message fixture
function makeDebateMsg(overrides: Partial<CouncilMessage> = {}): CouncilMessage {
  return {
    kind: "debate",
    speaker: { role: "Frontend Engineer", model: "gpt-4o" },
    partner: { role: "Backend Engineer" },
    round: 1,
    text: "I think we should use React Server Components here.",
    ...overrides,
  };
}

describe("<CouncilMessageBubble> debate variant", () => {
  it("renders speaker role in top border", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("Frontend Engineer");
  });

  it("renders model name in top border", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("gpt-4o");
  });

  it("right side renders with indent", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="right"
        resolveStyle={() => ({ color: "magenta", sigil: "◆" })}
      />,
    );
    // Right-aligned bubbles start with leading spaces
    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";
    expect(firstLine.startsWith(" ")).toBe(true);
  });

  it("shows 'recovered on retry' badge when attempts > 1", () => {
    const msg = makeDebateMsg({ attempts: 2 });
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("recovered on retry");
  });

  it("renders reply-quote header when partnerLastText is provided", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
        partnerLastText="we should probably check the boundary before committing"
        partnerRole="Backend Engineer"
      />,
    );
    expect(lastFrame()).toContain("↪");
    expect(lastFrame()).toContain("Backend Engineer");
  });

  it("fallback to flat format when terminal < 70 cols", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={60}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    // No box border characters — flat format
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("┌");
    expect(frame).toContain("Frontend Engineer");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/council/council-message-bubble.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Install `ink-testing-library` if not already present**

```bash
npm ls ink-testing-library
```

If not listed: `npm install --save-dev ink-testing-library`

- [ ] **Step 4: Implement `council-message-bubble.tsx`**

Create `src/ui/components/council-message-bubble.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { computeBubbleLayout } from "./bubble-layout.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import type { CouncilMessage } from "../../types/index.js";
import type { RoleStyle } from "./role-palette.js";

export interface CouncilMessageBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
  /** "left" | "right" — computed by usePairSideMap in container, NOT on the message */
  side: "left" | "right";
  /** Stable role → style resolver from useRolePalette */
  resolveStyle: (role: string) => RoleStyle;
  /** The partner's last rendered text (for reply-quote header). Omit for first turn. */
  partnerLastText?: string;
  /** Partner's role name for the reply-quote label */
  partnerRole?: string;
}

const MAX_QUOTE_CHARS = 80;

function buildFooter(msg: CouncilMessage): string {
  const wordCount = msg.text.trim().split(/\s+/).filter(Boolean).length;
  const parts: string[] = [`${wordCount} words`];
  if (msg.partner) parts.push(`→ ${msg.partner.role}`);
  if (msg.toolCalls?.length) {
    parts.push(`tools: ${msg.toolCalls.map((t) => t.name).join(", ")}`);
  }
  if (msg.attempts && msg.attempts > 1) {
    parts.push("recovered on retry");
  }
  return parts.join(" · ");
}

function buildHeader(msg: CouncilMessage, style: RoleStyle): string {
  return `${style.sigil} ${msg.speaker.role} · ${msg.speaker.model}`;
}

function buildQuoteLine(partnerLastText: string, partnerRole: string): string {
  const excerpt = partnerLastText.replace(/\n/g, " ").trim().slice(0, MAX_QUOTE_CHARS);
  const ellipsis = partnerLastText.replace(/\n/g, " ").trim().length > MAX_QUOTE_CHARS ? "…" : "";
  return `↪ ${partnerRole}: "${excerpt}${ellipsis}"`;
}

/** Flat fallback for terminals < 70 cols */
function FlatDebateBubble({ msg, style }: { msg: CouncilMessage; style: RoleStyle }): React.ReactElement {
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={style.color}>{header}</Text>
      <Text wrap="wrap">{msg.text.trim()}</Text>
      <Text dimColor>{footer}</Text>
    </Box>
  );
}

export function CouncilMessageBubble({
  msg,
  terminalCols,
  side,
  resolveStyle,
  partnerLastText,
  partnerRole,
}: CouncilMessageBubbleProps): React.ReactElement {
  const layout = computeBubbleLayout(terminalCols);
  const style = resolveStyle(msg.speaker.role);

  if (layout.fallback) {
    return <FlatDebateBubble msg={msg} style={style} />;
  }

  const isRight = side === "right";
  const indent = isRight ? layout.rightIndent : 0;
  const header = buildHeader(msg, style);
  const footer = buildFooter(msg);
  const bodyText = truncateCodeBlocks(msg.text.trim());
  const roundLabel = msg.round !== undefined ? `Round ${msg.round} · ` : "";

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Reply-quote header */}
      {partnerLastText && partnerRole && (
        <Box marginLeft={indent}>
          <Text dimColor>{buildQuoteLine(partnerLastText, partnerRole)}</Text>
        </Box>
      )}

      {/* Bubble box */}
      <Box
        marginLeft={indent}
        width={layout.bubbleCols}
        borderStyle="round"
        borderColor={style.color}
        flexDirection="column"
      >
        {/* Top label (rendered as first child — Ink puts it in the border area via title prop workaround) */}
        <Text bold color={style.color}>{header}</Text>

        {/* Body */}
        <Text wrap="wrap">{bodyText}</Text>

        {/* Footer */}
        <Text dimColor>{`${roundLabel}${footer}`}</Text>
      </Box>
    </Box>
  );
}
```

**Note on Ink borders:** Ink's `<Box borderStyle>` renders a full border frame but does not natively support a title *in* the border line. The header `<Text>` renders as the first row inside the box, which is the closest equivalent to the spec's `┌─ Role ──┐` anatomy without dropping to raw ANSI strings. This is the accepted trade-off for v1.

- [ ] **Step 5: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/council/council-message-bubble.test.tsx
```

Expected: all 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/council-message-bubble.tsx src/__tests__/council/council-message-bubble.test.tsx
git commit -m "feat(council): add CouncilMessageBubble debate variant with reply-quote and retry badge"
```

---

### Task 7: `<CouncilPlaceholderBubble>` — composing… animated

**Files:**
- Create: `src/ui/components/council-placeholder-bubble.tsx`
- Create: `src/__tests__/council/council-placeholder-bubble.test.tsx`

- [ ] **Step 1: Write snapshot tests**

Create `src/__tests__/council/council-placeholder-bubble.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CouncilPlaceholderBubble } from "../../ui/components/council-placeholder-bubble.js";

describe("<CouncilPlaceholderBubble>", () => {
  it("renders role name in the placeholder", () => {
    const { lastFrame } = render(
      <CouncilPlaceholderBubble
        role="Frontend Engineer"
        side="left"
        terminalCols={100}
        color="cyan"
      />,
    );
    expect(lastFrame()).toContain("Frontend Engineer");
  });

  it("contains composing indicator text", () => {
    const { lastFrame } = render(
      <CouncilPlaceholderBubble
        role="Backend Engineer"
        side="right"
        terminalCols={100}
        color="magenta"
      />,
    );
    expect(lastFrame()).toContain("composing");
  });

  it("right side has indent", () => {
    const { lastFrame } = render(
      <CouncilPlaceholderBubble
        role="Backend Engineer"
        side="right"
        terminalCols={100}
        color="magenta"
      />,
    );
    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";
    expect(firstLine.startsWith(" ")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/council/council-placeholder-bubble.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `council-placeholder-bubble.tsx`**

Create `src/ui/components/council-placeholder-bubble.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { computeBubbleLayout } from "./bubble-layout.js";

export interface CouncilPlaceholderBubbleProps {
  role: string;
  side: "left" | "right";
  terminalCols: number;
  color: string;
}

/**
 * Thin animated placeholder bubble shown while the producer is generating a turn.
 * Rendered at turn-start (when council_status{state:"start"} arrives for this speaker).
 * Swapped for the real CouncilMessageBubble when council_message arrives.
 */
export function CouncilPlaceholderBubble({
  role,
  side,
  terminalCols,
  color,
}: CouncilPlaceholderBubbleProps): React.ReactElement {
  const layout = computeBubbleLayout(terminalCols);
  const indent = side === "right" ? layout.rightIndent : 0;

  return (
    <Box marginLeft={indent} marginBottom={1}>
      <Box
        width={layout.fallback ? terminalCols : Math.min(layout.bubbleCols, 40)}
        borderStyle="single"
        borderColor={color}
      >
        <Text color={color} dimColor>{`${role} · composing…`}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/council/council-placeholder-bubble.test.tsx
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/council-placeholder-bubble.tsx src/__tests__/council/council-placeholder-bubble.test.tsx
git commit -m "feat(council): add CouncilPlaceholderBubble for composing… state"
```

---

### Task 8: Leader and Synthesis bubble variants

**Files:**
- Create: `src/ui/components/council-leader-bubble.tsx`
- Create: `src/ui/components/council-synthesis-banner.tsx`
- Create: `src/__tests__/council/council-leader-bubble.test.tsx`
- Create: `src/__tests__/council/council-synthesis-banner.test.tsx`

- [ ] **Step 1: Write leader bubble tests**

Create `src/__tests__/council/council-leader-bubble.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CouncilLeaderBubble } from "../../ui/components/council-leader-bubble.js";
import type { CouncilMessage } from "../../types/index.js";

function makeLeaderMsg(overrides: Partial<CouncilMessage> = {}): CouncilMessage {
  return {
    kind: "leader",
    speaker: { role: "Leader", model: "gpt-4o" },
    round: 2,
    text: "Continue: positions still diverging on RSC tradeoff",
    ...overrides,
  };
}

describe("<CouncilLeaderBubble>", () => {
  it("renders 'Leader' in output", () => {
    const { lastFrame } = render(
      <CouncilLeaderBubble msg={makeLeaderMsg()} terminalCols={100} />,
    );
    expect(lastFrame()).toContain("Leader");
  });

  it("renders round number when present", () => {
    const { lastFrame } = render(
      <CouncilLeaderBubble msg={makeLeaderMsg()} terminalCols={100} />,
    );
    expect(lastFrame()).toContain("2");
  });

  it("renders bubble body text", () => {
    const { lastFrame } = render(
      <CouncilLeaderBubble msg={makeLeaderMsg()} terminalCols={100} />,
    );
    expect(lastFrame()).toContain("diverging");
  });
});
```

- [ ] **Step 2: Write synthesis banner tests**

Create `src/__tests__/council/council-synthesis-banner.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CouncilSynthesisBanner } from "../../ui/components/council-synthesis-banner.js";
import type { CouncilMessage } from "../../types/index.js";

function makeSynthMsg(): CouncilMessage {
  return {
    kind: "synthesis",
    speaker: { role: "Leader", model: "gpt-4o" },
    text: "Decision: use RSC with strict boundary checks.",
  };
}

describe("<CouncilSynthesisBanner>", () => {
  it("contains 'Synthesis' in output", () => {
    const { lastFrame } = render(<CouncilSynthesisBanner msg={makeSynthMsg()} />);
    expect(lastFrame()).toContain("Synthesis");
  });

  it("renders the body text", () => {
    const { lastFrame } = render(<CouncilSynthesisBanner msg={makeSynthMsg()} />);
    expect(lastFrame()).toContain("RSC");
  });
});
```

- [ ] **Step 3: Run both test files — verify they fail**

```bash
npx vitest run src/__tests__/council/council-leader-bubble.test.tsx src/__tests__/council/council-synthesis-banner.test.tsx
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `council-leader-bubble.tsx`**

Create `src/ui/components/council-leader-bubble.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { computeBubbleLayout } from "./bubble-layout.js";
import { dark } from "../theme.js";
import type { CouncilMessage } from "../../types/index.js";

export interface CouncilLeaderBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
}

/**
 * Centered, narrow (40% width), gray-bordered bubble for leader evaluations.
 * Matches spec: "system" bubble with neutral gray border.
 */
export function CouncilLeaderBubble({ msg, terminalCols }: CouncilLeaderBubbleProps): React.ReactElement {
  const layout = computeBubbleLayout(terminalCols);
  const width = layout.leaderCols;
  const centerIndent = Math.floor((terminalCols - width) / 2);
  const roundLabel = msg.round !== undefined ? ` · round ${msg.round} eval` : "";
  const header = `Leader${roundLabel}`;

  return (
    <Box flexDirection="column" marginBottom={1} marginLeft={centerIndent}>
      <Box
        width={width}
        borderStyle="single"
        borderColor={dark.councilLeaderBorder}
        flexDirection="column"
      >
        <Text dimColor bold>{header}</Text>
        <Text wrap="wrap" dimColor>{msg.text.trim()}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Implement `council-synthesis-banner.tsx`**

Create `src/ui/components/council-synthesis-banner.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { dark } from "../theme.js";
import { truncateCodeBlocks } from "./code-block-truncate.js";
import type { CouncilMessage } from "../../types/index.js";

export interface CouncilSynthesisBannerProps {
  msg: CouncilMessage;
}

/**
 * Full-width double-border pinned banner for round and final synthesis.
 * Accent color border; no width cap — synthesis belongs to everyone.
 */
export function CouncilSynthesisBanner({ msg }: CouncilSynthesisBannerProps): React.ReactElement {
  const bodyText = truncateCodeBlocks(msg.text.trim());
  const isFinal = msg.round === undefined;
  const title = isFinal ? "Final Synthesis" : `Round ${msg.round} Synthesis`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        borderStyle="double"
        borderColor={dark.councilSynthesisBorder}
        flexDirection="column"
      >
        <Text bold color={dark.councilSynthesisBorder}>{title}</Text>
        <Text wrap="wrap">{bodyText}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 6: Run both test files — verify they pass**

```bash
npx vitest run src/__tests__/council/council-leader-bubble.test.tsx src/__tests__/council/council-synthesis-banner.test.tsx
```

Expected: all 5 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  src/ui/components/council-leader-bubble.tsx \
  src/ui/components/council-synthesis-banner.tsx \
  src/__tests__/council/council-leader-bubble.test.tsx \
  src/__tests__/council/council-synthesis-banner.test.tsx
git commit -m "feat(council): add CouncilLeaderBubble and CouncilSynthesisBanner variants"
```

---

### Task 9: Reply-quote ring buffer in container + research variant

**Files:**
- Modify: `src/ui/components/council-message-bubble.tsx` — research variant (add `🔍` glyph prefix)
- Create: `src/ui/components/use-pair-quote-buffer.ts` — ring buffer hook
- Create: `src/__tests__/council/use-pair-quote-buffer.test.ts`

- [ ] **Step 1: Write ring buffer tests**

Create `src/__tests__/council/use-pair-quote-buffer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makePairKey } from "../../ui/components/bubble-layout.js";

// Inline the ring buffer logic for pure unit testing (no React hook overhead)
function makeQuoteBuffer() {
  const buf = new Map<string, string>();
  return {
    set(pairKey: string, speakerRole: string, text: string) {
      buf.set(`${pairKey}::${speakerRole}`, text);
    },
    getPartnerLast(pairKey: string, partnerRole: string): string | undefined {
      return buf.get(`${pairKey}::${partnerRole}`);
    },
  };
}

describe("pair quote buffer", () => {
  it("returns undefined before any text is stored", () => {
    const buf = makeQuoteBuffer();
    expect(buf.getPartnerLast("A↔B", "Backend Engineer")).toBeUndefined();
  });

  it("returns the last stored text for a partner", () => {
    const buf = makeQuoteBuffer();
    const key = makePairKey("Frontend Engineer", "Backend Engineer");
    buf.set(key, "Backend Engineer", "we should check the boundary");
    expect(buf.getPartnerLast(key, "Backend Engineer")).toBe("we should check the boundary");
  });

  it("overwrites on second store (ring = keep latest)", () => {
    const buf = makeQuoteBuffer();
    const key = makePairKey("A", "B");
    buf.set(key, "A", "first message");
    buf.set(key, "A", "second message");
    expect(buf.getPartnerLast(key, "A")).toBe("second message");
  });

  it("makePairKey is order-independent", () => {
    expect(makePairKey("A", "B")).toBe(makePairKey("B", "A"));
  });
});
```

- [ ] **Step 2: Run tests — verify they pass (uses already-implemented `makePairKey`)**

```bash
npx vitest run src/__tests__/council/use-pair-quote-buffer.test.ts
```

Expected: all 4 tests PASS (pure logic, no new module needed beyond `makePairKey`).

- [ ] **Step 3: Implement `use-pair-quote-buffer.ts` React hook**

Create `src/ui/components/use-pair-quote-buffer.ts`:

```ts
import { useRef, useCallback } from "react";

/**
 * Hook: tracks the last rendered text per (pairKey, speakerRole) so the UI
 * can show a reply-quote header on the next turn in that pair.
 *
 * Ring buffer size = 1 per (pairKey, speaker) slot — we only need the most
 * recent turn, not a full history. Map key: `${pairKey}::${speakerRole}`.
 */
export function usePairQuoteBuffer() {
  const buf = useRef(new Map<string, string>());

  const store = useCallback((pairKey: string, speakerRole: string, text: string) => {
    buf.current.set(`${pairKey}::${speakerRole}`, text);
  }, []);

  const getPartnerLast = useCallback(
    (pairKey: string, partnerRole: string): string | undefined =>
      buf.current.get(`${pairKey}::${partnerRole}`),
    [],
  );

  return { store, getPartnerLast };
}
```

- [ ] **Step 4: Add research variant support to `CouncilMessageBubble`**

Open `src/ui/components/council-message-bubble.tsx`. Update `buildHeader` to detect `kind === "research"` and prefix with `🔍`:

```ts
// Replace the existing buildHeader function:
function buildHeader(msg: CouncilMessage, style: RoleStyle): string {
  const prefix = msg.kind === "research" ? "🔍 " : `${style.sigil} `;
  return `${prefix}${msg.speaker.role} · ${msg.speaker.model}`;
}
```

The rest of the component renders the research bubble identically to debate (left-aligned, role color). No other changes needed.

- [ ] **Step 5: Add a research variant snapshot test**

Append to `src/__tests__/council/council-message-bubble.test.tsx`:

```tsx
describe("<CouncilMessageBubble> research variant", () => {
  it("renders 🔍 prefix in header", () => {
    const msg: CouncilMessage = {
      kind: "research",
      speaker: { role: "Research Agent", model: "gpt-4o-mini" },
      text: "Found 3 usages of RSC in the codebase under /app/server.",
    };
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("🔍");
  });
});
```

- [ ] **Step 6: Run all bubble tests**

```bash
npx vitest run src/__tests__/council/council-message-bubble.test.tsx src/__tests__/council/use-pair-quote-buffer.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  src/ui/components/use-pair-quote-buffer.ts \
  src/__tests__/council/use-pair-quote-buffer.test.ts \
  src/ui/components/council-message-bubble.tsx \
  src/__tests__/council/council-message-bubble.test.tsx
git commit -m "feat(council): add pair quote ring buffer + research bubble variant with 🔍 prefix"
```

---

### Task 10: Producer changes in `debate.ts`

**Files:**
- Modify: `src/council/debate.ts`

This task changes three yield sites. Read the file carefully before editing. Do NOT touch the persistence block (lines ~732–747).

- [ ] **Step 1: Replace `## Discussion Round N` header with thin divider**

Find the line (around line 629):
```ts
yield { type: "content", content: `\n## Discussion Round ${round}\n` };
```

Replace with:
```ts
yield { type: "content", content: `\n── Round ${round} ──\n` };
```

- [ ] **Step 2: Replace success debate turn yields with `council_message`**

Find the success branch (around lines 679–695). Replace the entire `else` block:

```ts
// Before (lines ~679–695):
} else {
  const toolList = chunk.toolCalls?.length ? chunk.toolCalls.map((t) => t.toolName).join(", ") : null;
  const charCount = chunk.text.trim().length;
  const wordCount = chunk.text.trim().split(/\s+/).filter(Boolean).length;
  const stats = `${wordCount} words · ${charCount} chars`;
  const separator = "─".repeat(2);
  const turnHeader = `${separator}  Round ${round} · **${speakerName}** → ${partnerName}  ${separator}`;
  yield { type: "content", content: `\n${turnHeader}\n\n${chunk.text.trim()}\n` };
  const footerBits: string[] = [stats];
  if (toolList) footerBits.push(`tools: \`${toolList}\``);
  if (chunk.attempts && chunk.attempts > 1) footerBits.push(`recovered on retry`);
  yield { type: "content", content: `\n>    ↳ ${footerBits.join(" · ")}\n` };
}
```

Replace with:
```ts
} else {
  yield {
    type: "council_message" as const,
    councilMessage: {
      kind: "debate" as const,
      speaker: { role: speakerName, model: active.find((a) => (a.stance?.name ?? a.role) === speakerName)?.model ?? "" },
      partner: { role: partnerName },
      round,
      text: chunk.text.trim(),
      toolCalls: chunk.toolCalls?.map((t) => ({ name: t.toolName })),
      attempts: chunk.attempts,
    },
  };
}
```

- [ ] **Step 3: Replace research findings `content` yield with `council_message`**

Find line ~306:
```ts
yield { type: "content", content: `\n### Research findings\n${researchFindings}\n` };
```

Replace with:
```ts
yield {
  type: "council_message" as const,
  councilMessage: {
    kind: "research" as const,
    speaker: { role: researchCandidate.role, model: researchCandidate.model },
    text: researchFindings ?? "",
  },
};
```

- [ ] **Step 4: Replace leader evaluation `content` yield with `council_message`**

Find lines ~792–795:
```ts
yield {
  type: "content",
  content: `\n> **Leader evaluation:** ${metCount}/${total} criteria met — ${evaluation.reason}\n`,
};
```

Replace with:
```ts
yield {
  type: "council_message" as const,
  councilMessage: {
    kind: "leader" as const,
    speaker: { role: "Leader", model: leaderModelId },
    round,
    text: `${metCount}/${total} criteria met — ${evaluation.reason}`,
  },
};
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 6: Run existing debate tests to confirm no regressions**

```bash
npx vitest run src/council/__tests__/
```

Expected: all existing tests still PASS (they test internal logic, not yield shape).

- [ ] **Step 7: Commit**

```bash
git add src/council/debate.ts
git commit -m "feat(council): emit council_message chunks for debate/research/leader turns in debate.ts"
```

---

### Task 11: Producer changes in `planner.ts` (synthesis)

**Files:**
- Modify: `src/council/planner.ts`

- [ ] **Step 1: Replace synthesis `content` yields with `council_message`**

Find lines ~113–121 in `src/council/planner.ts`:

```ts
    yield { type: "content", content: "\n## Synthesis\n" };
    yield {
      type: "content",
      content: ((readablePart && readablePart.length > 0)
        ? readablePart
        : (synthesisText.trim().length > 0
            ? synthesisText
            : `_(empty — ${synthesisFailReason ?? "no output"})_`)) + "\n",
    };
```

Replace with:

```ts
    const synthBody = (readablePart && readablePart.length > 0)
      ? readablePart
      : (synthesisText.trim().length > 0
          ? synthesisText
          : `_(empty — ${synthesisFailReason ?? "no output"})_`);
    yield {
      type: "council_message" as const,
      councilMessage: {
        kind: "synthesis" as const,
        speaker: { role: "Leader", model: leaderModelId },
        text: synthBody,
      },
    };
```

**Note:** `leaderModelId` is already in scope in `runPlanning`. Verify this before editing.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 3: Run planner tests**

```bash
npx vitest run src/council/__tests__/
```

Expected: all existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/council/planner.ts
git commit -m "feat(council): emit council_message{kind:synthesis} from planner.ts"
```

---

### Task 12: Wire `app.tsx` — chunk routing + placeholder lifecycle

**Files:**
- Modify: `src/ui/app.tsx`

This is the most complex wiring task. `app.tsx` has three chunk handling locations (switch at ~2502; if-chains at ~2873 and ~2991). All three must handle `council_message`.

- [ ] **Step 1: Import new components and hooks at the top of `app.tsx`**

Find the existing imports section near the top of `src/ui/app.tsx`. Add:

```ts
import { CouncilMessageBubble } from "./components/council-message-bubble.js";
import { CouncilPlaceholderBubble } from "./components/council-placeholder-bubble.js";
import { CouncilLeaderBubble } from "./components/council-leader-bubble.js";
import { CouncilSynthesisBanner } from "./components/council-synthesis-banner.js";
import { useRolePalette } from "./components/role-palette.js";
import { usePairSideMap, makePairKey } from "./components/bubble-layout.js";
import { usePairQuoteBuffer } from "./components/use-pair-quote-buffer.js";
import type { CouncilMessage } from "../types/index.js";
```

- [ ] **Step 2: Add state for council messages and placeholders**

Inside the main component function, near the existing `councilStatuses` state, add:

```ts
const [councilMessages, setCouncilMessages] = useState<CouncilMessage[]>([]);
// Placeholder: keyed by statusId → { role, side, color }
const [councilPlaceholders, setCouncilPlaceholders] = useState<
  Map<string, { role: string; side: "left" | "right"; color: string }>
>(new Map());

const resolveStyle = useRolePalette();
const getSide = usePairSideMap();
const { store: storeQuote, getPartnerLast } = usePairQuoteBuffer();
```

- [ ] **Step 3: Handle `council_message` in the switch at line ~2502**

Find `case "council_phase":` (line ~2511) and insert before it:

```ts
case "council_message":
  if (chunk.councilMessage) {
    const cm = chunk.councilMessage;
    setCouncilMessages((prev) => [...prev, cm]);
    // Resolve and store quote for reply-quote header on next turn
    if (cm.kind === "debate" && cm.partner) {
      const pairKey = makePairKey(cm.speaker.role, cm.partner.role);
      storeQuote(pairKey, cm.speaker.role, cm.text);
      // Remove placeholder for this speaker (it has now been resolved)
      setCouncilPlaceholders((prev) => {
        const next = new Map(prev);
        for (const [id, p] of next) {
          if (p.role === cm.speaker.role) { next.delete(id); }
        }
        return next;
      });
    }
  }
  break;
```

- [ ] **Step 4: Handle `council_status` start → add placeholder**

Find the existing `case "council_status":` handler (line ~2502). Inside where `cs.state` is checked, add the placeholder creation:

```ts
case "council_status":
  if (chunk.councilStatus) {
    const cs = chunk.councilStatus;
    if (cs.state === "start" && cs.label) {
      // Show placeholder bubble while this speaker is composing
      const placeholderRole = cs.label; // label = speaker name from tracedAsync
      const styleForRole = resolveStyle(placeholderRole);
      const side = getSide(`placeholder::${placeholderRole}`, placeholderRole);
      setCouncilPlaceholders((prev) => {
        const next = new Map(prev);
        next.set(cs.statusId, { role: placeholderRole, side, color: styleForRole.color });
        return next;
      });
    }
    if (cs.state === "done" || cs.state === "error") {
      councilDoneAtRef.current.set(cs.statusId, Date.now());
      // Remove placeholder when done (may already be removed by council_message arrival)
      setCouncilPlaceholders((prev) => {
        const next = new Map(prev);
        next.delete(cs.statusId);
        return next;
      });
    }
    setCouncilStatuses((prev) => upsertStatus(prev, cs));
  }
  break;
```

- [ ] **Step 5: Handle `council_message` in the two `if`-chain handlers (lines ~2873 and ~2991)**

Find the block at ~2873:
```ts
if (chunk.type === "council_status" && chunk.councilStatus) {
```

Before this line, add:
```ts
if (chunk.type === "council_message" && chunk.councilMessage) {
  const cm = chunk.councilMessage;
  setCouncilMessages((prev) => [...prev, cm]);
  if (cm.kind === "debate" && cm.partner) {
    const pairKey = makePairKey(cm.speaker.role, cm.partner.role);
    storeQuote(pairKey, cm.speaker.role, cm.text);
    setCouncilPlaceholders((prev) => {
      const next = new Map(prev);
      for (const [id, p] of next) {
        if (p.role === cm.speaker.role) { next.delete(id); }
      }
      return next;
    });
  }
}
```

Repeat the same addition before the `if (chunk.type === "council_status"...)` block at ~2991.

- [ ] **Step 6: Add render section for council messages**

Find the JSX render section where `councilStatuses` are rendered (search for `CouncilStatusCard` or `councilStatuses.map`). After the council status cards rendering, add:

```tsx
{/* Council chat bubbles */}
{councilMessages.map((cm, idx) => {
  const side = cm.kind === "debate" && cm.partner
    ? getSide(makePairKey(cm.speaker.role, cm.partner.role), cm.speaker.role)
    : "left";

  if (cm.kind === "leader") {
    return (
      <CouncilLeaderBubble key={idx} msg={cm} terminalCols={terminalWidth} />
    );
  }
  if (cm.kind === "synthesis") {
    return (
      <CouncilSynthesisBanner key={idx} msg={cm} />
    );
  }
  // debate or research
  const pairKey = cm.partner ? makePairKey(cm.speaker.role, cm.partner.role) : `solo::${cm.speaker.role}`;
  const partnerLastText = cm.partner ? getPartnerLast(pairKey, cm.partner.role) : undefined;
  return (
    <CouncilMessageBubble
      key={idx}
      msg={cm}
      terminalCols={terminalWidth}
      side={side}
      resolveStyle={resolveStyle}
      partnerLastText={partnerLastText}
      partnerRole={cm.partner?.role}
    />
  );
})}

{/* Placeholder bubbles (composing…) */}
{Array.from(councilPlaceholders.entries()).map(([id, p]) => (
  <CouncilPlaceholderBubble
    key={id}
    role={p.role}
    side={p.side}
    terminalCols={terminalWidth}
    color={p.color}
  />
))}
```

**Note:** Verify the variable name for terminal width in `app.tsx` — it may be `columns`, `terminalWidth`, or `cols`. Search for `process.stdout.columns` usage to find the correct name.

- [ ] **Step 7: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

- [ ] **Step 8: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ui/app.tsx
git commit -m "feat(council): wire council_message routing + placeholder lifecycle in app.tsx"
```

---

### Task 13: Manual QA Checklist

**No code changes in this task — verification only.**

Run a real council session with at least 2 pairs and 3 rounds:

```bash
# From inside the CLI
/council "Should we use React Server Components for data fetching in this app?"
```

- [ ] **Check 1:** Debate turn bubbles appear with left/right alternation per pair.
- [ ] **Check 2:** The first turn in a pair has no reply-quote header. Subsequent turns show `↪ Role: "…"`.
- [ ] **Check 3:** Colors are stable — the same role always gets the same border color across all rounds.
- [ ] **Check 4:** Leader evaluation renders as the centered narrow gray bubble (not a debate bubble).
- [ ] **Check 5:** Final synthesis renders as the full-width double-border accent banner.
- [ ] **Check 6:** Research findings (if triggered) show `🔍` prefix.
- [ ] **Check 7:** A failed/skipped turn renders as the inline muted line (NOT a bubble).
- [ ] **Check 8:** While a turn is generating, a thin `composing…` placeholder appears on the correct side.
- [ ] **Check 9:** At terminal width < 70 cols: bubbles degrade to flat header/body/footer format.
- [ ] **Check 10:** `/export` after the session shows clean text (no box-drawing characters in the export).

- [ ] **Commit after QA pass**

```bash
git commit --allow-empty -m "chore(council): manual QA pass — bubble UI verified in live session"
```

---

## Self-Review

### Spec Coverage

| Spec Section | Covered by |
|---|---|
| **Layout — bubble dimensions** (65%/100col, 12% indent) | T3 `computeBubbleLayout` |
| **Layout — alignment rule** (speaker=left, partner=right) | T3 `usePairSideMap`, T12 render |
| **Layout — fallback < 70 cols** | T3, T6 FlatDebateBubble |
| **Reply-quote header** (↪ partner excerpt, ring buffer) | T9 `usePairQuoteBuffer`, T6 `CouncilMessageBubble` |
| **Bubble anatomy** (header/body/footer) | T6 `CouncilMessageBubble` |
| **Leader evaluation** (centered 40%, gray border) | T8 `CouncilLeaderBubble` |
| **Round/final synthesis** (full-width double border) | T8 `CouncilSynthesisBanner` |
| **Research findings** (🔍 glyph prefix) | T9 research variant |
| **Failed/skipped turn** (inline muted line, NOT bubble) | T10 — failure branch untouched, keeps inline `content` yield |
| **Retry badge** (attempts > 1) | T6 `buildFooter`, T1 type |
| **Code block truncation** (>30 lines → footer) | T2 `truncateCodeBlocks` |
| **Color palette** (8-slot first-seen registry) | T4 `useRolePalette` |
| **Sigils** (NO_COLOR identity) | T4 `resolveRoleStyle` |
| **Leader = textMuted gray** | T5 theme, T8 `CouncilLeaderBubble` |
| **Synthesis = accent #5c9cf5** | T5 theme, T8 `CouncilSynthesisBanner` |
| **Data flow — new chunk type** | T1 types |
| **Streaming/placeholder bubble** | T7 `CouncilPlaceholderBubble`, T12 lifecycle |
| **Producer changes — debate.ts** | T10 |
| **Producer changes — planner.ts (synthesis)** | T11 |
| **Consumer changes — app.tsx** | T12 |
| **Transcript/export unchanged** | `council_status` persistence block not touched (T10 explicitly avoids it) |

### Discrepancy Notes (Spec vs. Actual Code)

1. **Spec T11 says "producer for leader-eval in `leader.ts`"** — Actual leader eval yield is in `debate.ts:792–795`, NOT in `leader.ts`. `leader.ts` contains only the model picker (`pickCouncilTaskModel`). This plan routes T11 to `planner.ts` (synthesis) and folds leader-eval producer into T10 (`debate.ts`).

2. **Spec says `side` field NOT on `CouncilMessage`** — Confirmed. `side` is computed in T12 via `usePairSideMap`, not stored on the message.

3. **Ink border titles** — Ink `<Box borderStyle>` does not natively support a label in the border line (as drawn in spec anatomy `┌─ Role ──┐`). The header `<Text>` renders as the first row inside the box. This is the v1 accepted trade-off; noted in T6.

4. **`wordCount`/`charCount` in footer** — Spec says "UI derives from `text`". Done: `buildFooter` computes wordCount inline.

5. **Opening statements** (lines 349–356 in `debate.ts`) still yield raw `content` — spec does not mention converting openings to bubbles; they precede the debate loop. Left as-is.

### Placeholder Scan (No Placeholders Found)

All steps contain complete runnable code. No "TBD", "TODO", or "similar to Task N" patterns present.

### Type Consistency Check

- `CouncilMessage` defined in T1 → imported in T6, T7, T8, T10, T11, T12. ✓
- `computeBubbleLayout` defined in T3 → used in T6, T7, T8. ✓
- `makePairKey` defined in T3 → used in T9, T12. ✓
- `usePairSideMap` defined in T3 → used in T12. ✓
- `useRolePalette` / `resolveRoleStyle` / `RoleStyle` defined in T4 → used in T6, T12. ✓
- `truncateCodeBlocks` defined in T2 → used in T6, T8. ✓
- `usePairQuoteBuffer` defined in T9 → used in T12. ✓
- `COUNCIL_PALETTE`, `COUNCIL_SIGILS` defined in T4 → referenced in tests. ✓
- `councilLeaderBorder`, `councilSynthesisBorder` added to theme in T5 → used in T8. ✓
