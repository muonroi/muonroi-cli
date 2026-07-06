# Council UX P0 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six live-verified council UX defects: `<think>` reasoning leaking into speaker bubbles, implementation_plan synthesis rendering as a raw (often truncated) JSON wall, Esc on the post-debate askcard wiping all council UI, three hardcoded-`dark` theme components, frozen elapsed in the status list, and the static "composing…" placeholder.

**Architecture:** All fixes are surgical: one new pure util (`strip-think.ts`) applied at the council LLM boundary, one extended parser (`parseConclusion` + JSON salvage) in the existing conclusion card, one guard clause in `interruptActiveRun`, and prop/heartbeat mechanical fixes in three components. No new subsystems.

**Tech Stack:** TypeScript + React (OpenTUI), vitest for unit tests, MCP agent harness for E2E verification.

## Global Constraints

- Branch: work on current branch `feat/council-post-debate-ux`. Do NOT commit the pre-existing dirty files (`.planning/STATE.md`, `tests/harness/auto/*.spec.ts`, `tests/harness/wrapper-rejection.spec.ts`) — stage only files this plan touches.
- `src/ui/use-app-logic.tsx` is UTF-16 encoded and `src/ui/app.tsx` contains a NUL byte: **Grep cannot search them** — use `Select-String` (PowerShell) to locate, `Read`/`Edit` tools to modify (they handle the encoding).
- Zero Hardcode Rule: no model/provider string literals in production code.
- No Silent Catch Rule: every new `catch` logs module + operation + `err.message` (exception: expected-parse-failure branches that return null MAY stay silent but MUST carry a comment saying why, matching the existing `parseConclusion` style).
- Editing `src/ui/**` fires the PostToolUse self-QA hook (detached, non-blocking) — ignore it while editing; check `.claude/self-qa-last.json` only at the end.
- Full gate before push: `bunx tsc --noEmit` → `bunx vitest run` → `bunx vitest -c vitest.harness.config.ts run tests/harness/` → `bun run lint:semantic`.
- Council tests sniff prompt-text substrings (project memory `council-subsystem`) — this plan does NOT change any prompt text, keep it that way.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/council/strip-think.ts` | Create | Pure `stripThinkBlocks()` util |
| `src/council/__tests__/strip-think.test.ts` | Create | Unit tests for the util |
| `src/council/llm.ts` | Modify | Apply strip at every text-returning boundary (mock + real, generate/debate/synthesize/research) |
| `src/ui/components/council-conclusion-card.tsx` | Modify | JSON salvage for truncated synthesis, generic sections (implementation_plan), theme prop |
| `src/ui/components/__tests__/council-conclusion-card.test.ts` | Modify | New describe blocks for salvage + generic sections |
| `src/ui/components/council-synthesis-banner.tsx` | Modify | theme prop, `---READABLE---` prose-tail extraction |
| `src/ui/components/council-leader-bubble.tsx` | Modify | theme prop |
| `src/ui/components/council-status-list.tsx` | Modify | Live-ticking elapsed via startedAt stamp + heartbeat |
| `src/ui/components/__tests__/council-status-list.test.ts` | Create | Unit test for startedAt stamping in `upsertStatus` |
| `src/ui/components/council-placeholder-bubble.tsx` | Modify | Spinner + live elapsed |
| `src/ui/use-app-logic.tsx` | Modify | Esc guard in `interruptActiveRun` (line ~3052) |
| `src/ui/app.tsx` | Modify | Pass `theme={t}` at leader-bubble (line ~980) and synthesis-banner (line ~1076) call sites |
| `src/types/index.ts` | Modify | Add optional `startedAt?: number` to `CouncilStatusData` (line ~301) |

---

### Task 1: `stripThinkBlocks` util + council LLM boundary

**Files:**
- Create: `src/council/strip-think.ts`
- Test: `src/council/__tests__/strip-think.test.ts`
- Modify: `src/council/llm.ts` (return sites at lines 360, 435, 470, 611-614, 652, 800 — line numbers pre-edit)

**Interfaces:**
- Produces: `stripThinkBlocks(text: string): string` — removes `<think>…</think>` spans, an unclosed trailing `<think>…` span, and a stray leading `…</think>` prefix; trims the result.

**Why:** Kimi (opencode-go) emits chain-of-thought inline as `<think>…</think>` in `result.text`. Live-verified 2026-07-06: 4/16 debate turns rendered full internal reasoning to the user. The AI SDK's `reasoningText` separation does not fire for this provider path.

- [x] **Step 1: Write the failing test**

```ts
// src/council/__tests__/strip-think.test.ts
import { describe, expect, it } from "vitest";
import { stripThinkBlocks } from "../strip-think.js";

describe("stripThinkBlocks", () => {
  it("removes a leading think block and keeps the answer", () => {
    const input = "<think>\nLet me draft this…\nword count ok\n</think>\n**Position:** approved.";
    expect(stripThinkBlocks(input)).toBe("**Position:** approved.");
  });

  it("removes multiple think blocks", () => {
    const input = "<think>a</think>hello<think>b</think> world";
    expect(stripThinkBlocks(input)).toBe("hello world");
  });

  it("removes an unclosed trailing think block (truncated output)", () => {
    const input = "final answer here\n<think>this got cut off by maxTok";
    expect(stripThinkBlocks(input)).toBe("final answer here");
  });

  it("removes a stray leading close tag (model omits the opener)", () => {
    const input = "reasoning tail…</think>\nreal answer";
    expect(stripThinkBlocks(input)).toBe("real answer");
  });

  it("returns empty string when the whole text is one unclosed think block", () => {
    expect(stripThinkBlocks("<think>only reasoning, truncated")).toBe("");
  });

  it("passes through text with no think markup unchanged", () => {
    const input = "**Position:** the approach is `sound`.\n- bullet";
    expect(stripThinkBlocks(input)).toBe(input);
  });

  it("is case-insensitive on the tag name", () => {
    expect(stripThinkBlocks("<THINK>x</THINK>answer")).toBe("answer");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/council/__tests__/strip-think.test.ts`
Expected: FAIL — `Cannot find module '../strip-think.js'`

- [x] **Step 3: Write the implementation**

```ts
// src/council/strip-think.ts
/**
 * Strip inline chain-of-thought markup from council LLM output.
 *
 * Some providers (kimi-k2.7 via opencode-go, GLM thinking variants) emit
 * reasoning inline as `<think>…</think>` in `result.text` instead of the AI
 * SDK's separated `reasoningText`. Rendered verbatim, the user sees hundreds
 * of words of internal drafting above every debate turn (live-verified
 * 2026-07-06). Applied at the council LLM boundary (src/council/llm.ts) so
 * every consumer — debate turns, leader evals, synthesis — is covered.
 *
 * Handles three shapes:
 *   - complete `<think>…</think>` blocks anywhere (global, case-insensitive)
 *   - an unclosed trailing `<think>…` block (output truncated mid-reasoning)
 *   - a stray leading `…</think>` (model omitted the opener; everything up to
 *     and including the close tag is reasoning)
 */
export function stripThinkBlocks(text: string): string {
  if (!text || !/<\/?think>/i.test(text)) return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Stray close tag with no opener before it → everything before it is reasoning.
  const closeIdx = out.search(/<\/think>/i);
  if (closeIdx !== -1) {
    out = out.slice(closeIdx).replace(/^<\/think>/i, "");
  }
  // Unclosed opener → everything after it is reasoning that got truncated.
  const openIdx = out.search(/<think>/i);
  if (openIdx !== -1) {
    out = out.slice(0, openIdx);
  }
  return out.trim();
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/council/__tests__/strip-think.test.ts`
Expected: PASS (7 tests)

- [x] **Step 5: Apply at every council LLM text boundary**

In `src/council/llm.ts`, add the import at the top with the other local imports:

```ts
import { stripThinkBlocks } from "./strip-think.js";
```

Then wrap each return (6 sites; find them with `Grep pattern="return result.text|return \{ text" path=src\council\llm.ts`):

| Site (pre-edit line) | Old | New |
|---|---|---|
| generate mock (360) | `return result.text;` | `return stripThinkBlocks(result.text);` |
| generate real (435) | `return result.text;` | `return stripThinkBlocks(result.text);` |
| debate mock (470) | `return { text: result.text, toolCalls: [] };` | `return { text: stripThinkBlocks(result.text), toolCalls: [] };` |
| debate real (611-614) | `text: result.text,` | `text: stripThinkBlocks(result.text),` |
| synthesize-ish (652) | `return result.text;` | `return stripThinkBlocks(result.text);` |
| research (800) | `return result.text + internetGapWarning;` | `return stripThinkBlocks(result.text) + internetGapWarning;` |

Do NOT touch the error-fallback return at line 633 (`[debate failed: …]` carries no model text).

- [x] **Step 6: Typecheck + council unit tests**

Run: `bunx tsc --noEmit && bunx vitest run src/council`
Expected: 0 type errors, all council tests PASS (llm.ts consumers unaffected — strip is a no-op without think markup).

- [x] **Step 7: Commit**

```bash
git add src/council/strip-think.ts src/council/__tests__/strip-think.test.ts src/council/llm.ts
git commit -m "fix(council): strip inline <think> reasoning at the council LLM boundary

Kimi via opencode-go emits chain-of-thought inline in result.text; 4/16
debate turns in a live run (2026-07-06) rendered full internal drafting
to the user. Strip complete, unclosed-trailing, and stray-leading think
blocks at every text return in createCouncilLLM."
```

---

### Task 2: Truncated-JSON salvage + implementation_plan sections in the conclusion card

**Files:**
- Modify: `src/ui/components/council-conclusion-card.tsx`
- Modify: `src/ui/components/__tests__/council-conclusion-card.test.ts` (append new describes)
- Modify: `src/ui/components/council-synthesis-banner.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ParsedConclusion` gains `sections: Array<{ title: string; items: string[] }>`; `parseConclusion(text: string): ParsedConclusion | null` (same signature); new exported `salvageJson(body: string): Record<string, unknown> | null` (exported for tests); `CouncilConclusionCard` and `CouncilSynthesisBanner` gain a required `theme: Theme` prop (call-site update is Task 4 — this task keeps a temporary default binding so it compiles standalone: give the prop a default `theme = dark` in the destructure and remove the default in Task 4).

**Why:** Live-verified: an `implementation_plan` synthesis rendered as a ~10-screen raw JSON wall because (a) the JSON was truncated mid-array (`"nextActions":[…"action":"ask`) so `JSON.parse` failed, and (b) even untruncated, keys like `agreed_architecture`/`phases`/`actionItems` are invisible to the current evaluation/decision-only extraction.

- [x] **Step 1: Write the failing tests**

Append to `src/ui/components/__tests__/council-conclusion-card.test.ts`:

```ts
describe("salvageJson", () => {
  it("parses valid JSON unchanged", () => {
    expect(salvageJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("salvages JSON truncated mid-string inside a nested array", () => {
    const truncated = '{"summary": "ok", "nextActions": [{"action": "continue"}, {"action": "ask';
    const out = salvageJson(truncated);
    expect(out).not.toBeNull();
    expect(out?.summary).toBe("ok");
  });

  it("salvages JSON truncated between members", () => {
    const truncated = '{"summary": "ok", "risks": ["r1", "r2"],';
    const out = salvageJson(truncated);
    expect(out?.summary).toBe("ok");
    expect(out?.risks).toEqual(["r1", "r2"]);
  });

  it("returns null for hopeless input", () => {
    expect(salvageJson("not json at all")).toBeNull();
  });
});

describe("parseConclusion — implementation_plan shape", () => {
  const implPlan = JSON.stringify({
    type: "implementation_plan",
    summary: "Ship a progressive rollout.",
    agreed_architecture: "Flag served from a polled config endpoint.",
    phases: [
      { phase: "1 Canary", traffic_pct: "1%", gate: "error budget" },
      { phase: "2 Ramp", traffic_pct: "5%", gate: "same" },
    ],
    acceptance_criteria: ["Flag ships dark", "Rollback in 6 minutes"],
    risks: [{ risk: "SW cache", mitigation: "TTL floor", residual: "Medium" }],
  });

  it("extracts summary and generic sections instead of returning null-equivalent content", () => {
    const c = parseConclusion(implPlan);
    expect(c).not.toBeNull();
    expect(c?.summary).toBe("Ship a progressive rollout.");
    const titles = c?.sections.map((s) => s.title) ?? [];
    expect(titles).toContain("Agreed Architecture");
    expect(titles).toContain("Phases");
    expect(titles).toContain("Acceptance Criteria");
  });

  it("flattens object-list rows to ' · '-joined key/value cells", () => {
    const c = parseConclusion(implPlan);
    const phases = c?.sections.find((s) => s.title === "Phases");
    expect(phases?.items[0]).toBe("phase: 1 Canary · traffic_pct: 1% · gate: error budget");
  });

  it("puts object-shaped risks into the generic risks handling, not silently dropped", () => {
    const c = parseConclusion(implPlan);
    const all = JSON.stringify(c);
    expect(all).toContain("SW cache");
  });

  it("parses a TRUNCATED implementation_plan via salvage", () => {
    const truncated = implPlan.slice(0, implPlan.length - 30);
    const c = parseConclusion(truncated);
    expect(c).not.toBeNull();
    expect(c?.summary).toBe("Ship a progressive rollout.");
  });

  it("skips noise keys: type, nextActions, sections", () => {
    const c = parseConclusion(
      JSON.stringify({ summary: "s", type: "decision", nextActions: [{ action: "x" }], sections: { a: 1 } }),
    );
    const titles = c?.sections.map((s) => s.title) ?? [];
    expect(titles).not.toContain("Type");
    expect(titles).not.toContain("Next Actions");
    expect(titles).not.toContain("Sections");
  });
});
```

Add `salvageJson` to the existing import from `../council-conclusion-card.js` at the top of the test file.

- [x] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/ui/components/__tests__/council-conclusion-card.test.ts`
Expected: FAIL — `salvageJson` not exported; `sections` undefined.

- [x] **Step 3: Implement salvage + generic sections in `council-conclusion-card.tsx`**

Add after the existing helper functions (`coverageRows`), before `parseConclusion`:

```ts
/**
 * Best-effort parse of possibly-truncated JSON. Providers cut synthesis output
 * at maxTokens mid-array (live-verified 2026-07-06: `"nextActions":[…"action":"ask`),
 * which made the whole conclusion fall back to a raw-JSON text wall. Strategy:
 * scan once tracking string/escape state and the open-bracket stack, remember
 * the last "safe" index (end of a complete value at any depth), then close the
 * remaining brackets from there.
 */
export function salvageJson(body: string): Record<string, unknown> | null {
  try {
    const direct = JSON.parse(body) as unknown;
    return direct && typeof direct === "object" && !Array.isArray(direct)
      ? (direct as Record<string, unknown>)
      : null;
  } catch {
    // fall through to salvage — expected branch for truncated output
  }

  // Single scan tracking string/escape state and the open-bracket stack.
  // A "safe point" is the index AFTER a complete VALUE (string close, bracket
  // close, or a number/true/false/null character). A closed string is only
  // tentatively safe: if the next structural char is `:` it was a KEY, so we
  // roll back to the previous safe point (otherwise the cut would produce a
  // dangling `{"key"` — invalid JSON). The bracket stack is snapshotted at
  // each safe point so the closers match the cut position, not the ragged end.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1;
  let stackAtSafe: string[] = [];
  let prevSafe = -1;
  let stackAtPrevSafe: string[] = [];
  let lastStringEnd = -1; // safe point created by the most recent string close
  const markSafe = (endExclusive: number) => {
    if (endExclusive === lastSafe) return;
    prevSafe = lastSafe;
    stackAtPrevSafe = stackAtSafe;
    lastSafe = endExclusive;
    stackAtSafe = stack.slice();
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        markSafe(i + 1);
        lastStringEnd = i + 1;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      markSafe(i + 1);
    } else if (ch === ":") {
      // The string that just closed was a key, not a value — retract it.
      if (lastSafe === lastStringEnd && prevSafe !== -1) {
        lastSafe = prevSafe;
        stackAtSafe = stackAtPrevSafe;
      }
    } else if (/[0-9el]/.test(ch)) {
      // Number / true / false / null terminal characters (outside strings,
      // JSON only allows literals here) — cheap approximation of a value end.
      markSafe(i + 1);
    }
  }
  if (lastSafe <= 0) return null;

  const prefix = body.slice(0, lastSafe).replace(/,\s*$/, "") + stackAtSafe.reverse().join("");
  try {
    const parsed = JSON.parse(prefix) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // salvage failed — caller renders plain text; expected for hopeless input
    return null;
  }
}

/** "agreed_architecture" → "Agreed Architecture"; "actionItems" → "Action Items". */
function titleCase(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Keys never worth a generic section: routing/meta fields. */
const NOISE_KEYS = new Set(["type", "nextActions", "sections", "kind"]);

/** Flatten one unknown top-level value into displayable bullet items. */
function flattenValue(v: unknown): string[] {
  if (typeof v === "string") return v.trim().length > 0 ? [v.trim()] : [];
  if (Array.isArray(v)) {
    const items: string[] = [];
    for (const el of v) {
      if (typeof el === "string" && el.trim().length > 0) items.push(el.trim());
      else if (el && typeof el === "object") {
        const cells = Object.entries(el as Record<string, unknown>)
          .filter(([, cv]) => cv !== null && cv !== undefined && typeof cv !== "object")
          .map(([ck, cv]) => `${ck}: ${String(cv)}`);
        if (cells.length > 0) items.push(cells.join(" · "));
      }
    }
    return items;
  }
  return [];
}
```

Update `ParsedConclusion`:

```ts
export interface ParsedConclusion {
  summary?: string;
  recommendation?: string;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  tradeoffs: string[];
  /** Generic rows: each row is a list of its string cell values, best-effort. */
  coverage: string[][];
  /** Leftover top-level keys (implementation_plan etc.) as generic titled sections. */
  sections: Array<{ title: string; items: string[] }>;
}
```

Rewrite the body of `parseConclusion` (keep the `---READABLE---` early return and fence-stripping; replace the parse and extraction):

```ts
export function parseConclusion(text: string): ParsedConclusion | null {
  const trimmed = text.trim();
  if (trimmed.includes("---READABLE---")) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf("{");
  if (start === -1) return null;
  const end = body.lastIndexOf("}");
  // Truncated output may have NO balanced end — hand the raw tail to salvage.
  const candidate = end > start ? body.slice(start, end + 1) : body.slice(start);

  const parsed = salvageJson(candidate) ?? (end > start ? salvageJson(body.slice(start)) : null);
  if (!parsed) return null;

  const summary = firstString(parsed, ["summary", "conclusion"]);
  const recommendation = firstString(parsed, ["recommendation", "decision", "verdict"]);
  const strengths = firstArray(parsed, ["strengths", "pros", "agreed"]);
  const weaknesses = firstArray(parsed, ["weaknesses", "cons", "gaps"]);
  const risks = firstArray(parsed, ["risks", "concerns"]);
  const tradeoffs = firstArray(parsed, ["tradeoffs", "trade_offs", "trade-offs"]);
  const coverage = coverageRows(parsed);

  // Track which keys the named extractions actually consumed (a key only
  // counts as consumed when it produced content — object-shaped `risks`
  // yield [] above and must still reach the generic pass).
  const consumed = new Set<string>();
  if (summary) for (const k of ["summary", "conclusion"]) if (firstString(parsed, [k])) consumed.add(k);
  if (recommendation)
    for (const k of ["recommendation", "decision", "verdict"]) if (firstString(parsed, [k])) consumed.add(k);
  const arrayKeyGroups: Array<[string[], string[]]> = [
    [["strengths", "pros", "agreed"], strengths],
    [["weaknesses", "cons", "gaps"], weaknesses],
    [["risks", "concerns"], risks],
    [["tradeoffs", "trade_offs", "trade-offs"], tradeoffs],
  ];
  for (const [keys, extracted] of arrayKeyGroups) {
    if (extracted.length > 0) for (const k of keys) if (asStringArray(parsed[k]).length > 0) consumed.add(k);
  }
  if (coverage.length > 0)
    for (const k of ["coverage_matrix", "coverage", "criteria", "coverageMatrix"])
      if (Array.isArray(parsed[k])) consumed.add(k);

  const sections: Array<{ title: string; items: string[] }> = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (consumed.has(key) || NOISE_KEYS.has(key)) continue;
    const items = flattenValue(value);
    if (items.length > 0) sections.push({ title: titleCase(key), items });
  }

  const hasContent =
    !!summary ||
    !!recommendation ||
    strengths.length > 0 ||
    weaknesses.length > 0 ||
    risks.length > 0 ||
    tradeoffs.length > 0 ||
    coverage.length > 0 ||
    sections.length > 0;
  if (!hasContent) return null;

  return { summary, recommendation, strengths, weaknesses, risks, tradeoffs, coverage, sections };
}
```

Render the generic sections in `CouncilConclusionCard` after the Coverage block (inside the outer `<box>`):

```tsx
      {conclusion.sections.map((sec) => (
        <BulletSection key={sec.title} title={sec.title} items={sec.items} color={dark.accent} />
      ))}
```

(`dark.accent` here is replaced by the theme prop in this same task — see Step 4.)

- [x] **Step 4: Theme prop for conclusion card + synthesis banner**

In `council-conclusion-card.tsx`: replace `import { dark } from "../theme.js";` with `import { dark, type Theme } from "../theme.js";`, add `theme?: Theme` to `CouncilConclusionCardProps`, destructure as `{ conclusion, round, theme: t = dark }`, and replace every `dark.` usage inside `CouncilConclusionCard`/`BulletSection` with `t.` (thread `t` into `BulletSection` via new prop `theme: Theme`). The `= dark` default keeps old call sites compiling until Task 4 threads the real theme.

In `council-synthesis-banner.tsx`: same pattern — `theme?: Theme` prop with `= dark` default, replace `dark.` usages, pass `theme={t}` down to `<CouncilConclusionCard …/>`. Additionally fix the `---READABLE---` fallback: the marker means "human prose follows", so render only the prose tail:

```ts
  const raw = msg.text.trim();
  const readableIdx = raw.indexOf("---READABLE---");
  const bodyText = truncateCodeBlocks(
    readableIdx !== -1 ? raw.slice(readableIdx + "---READABLE---".length).trim() || raw : raw,
  );
```

(`|| raw`: if nothing follows the marker, keep the full text rather than rendering an empty banner.)

- [x] **Step 5: Run the component tests**

Run: `bunx vitest run src/ui/components/__tests__/council-conclusion-card.test.ts src/ui/components/__tests__/council-synthesis-banner.test.ts`
Expected: PASS (existing + new). If an existing test constructs `ParsedConclusion` literals, add `sections: []` to those literals.

- [x] **Step 6: Commit**

```bash
git add src/ui/components/council-conclusion-card.tsx src/ui/components/council-synthesis-banner.tsx src/ui/components/__tests__/council-conclusion-card.test.ts
git commit -m "fix(council): salvage truncated synthesis JSON + render implementation_plan sections

Live-verified 2026-07-06: an implementation_plan synthesis rendered as a
~10-screen raw JSON wall — the output was cut at maxTokens mid-array so
JSON.parse failed, and even valid impl-plan keys had no card mapping.
salvageJson() closes unbalanced brackets from the last complete value;
leftover top-level keys render as generic titled bullet sections.
---READABLE--- fallback now shows only the prose tail."
```

---

### Task 3: Esc on a pending council askcard must not wipe council UI

**Files:**
- Modify: `src/ui/use-app-logic.tsx` (function `interruptActiveRun`, line ~3052)

**Interfaces:**
- Consumes: `pendingCouncilQuestionRef` (line 1018), `preflightCardStateRef` (referenced at line 3118).

**Why:** Live-verified: Esc on the post-debate askcard destroyed rounds, rail, and synthesis. Two handlers both receive Escape: the normal key path cancels the card (`respondToCouncilQuestion(qid, "")` → council treats it like save_exit), but a renderer-internal listener (line 3085-3096) unconditionally calls `interruptActiveRun`, which — because `isProcessingRef.current` is still true during the card — falls to Stage 2: `clearLiveTurnUi()` (wipes `councilMessages`/`councilRounds`/…) + `activeAgent.abort()`. The typing-jump listener at line 3110-3121 already guards on `pendingCouncilQuestionRef.current`; `interruptActiveRun` is missing the same guard.

- [ ] **Step 1: Add the guard**

In `interruptActiveRun` (after the `btwStateRef` block, before `if (!isProcessingRef.current) return false;` at line ~3063) insert:

```ts
      // A pending council/preflight askcard owns the Escape key: the card's
      // own handler cancels it (routed as an empty answer → save-and-exit
      // semantics). Without this guard the renderer-internal Escape listener
      // (below) also fired Stage 2 — clearLiveTurnUi() + abort() — wiping the
      // whole debate transcript the instant the user dismissed the card
      // (live-verified 2026-07-06). Mirrors the pendingCouncilQuestionRef
      // guard the typing-jump listener already has.
      if (pendingCouncilQuestionRef.current || preflightCardStateRef.current) {
        return false;
      }
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (`preflightCardStateRef` is in scope — verify with `Select-String -Path src\ui\use-app-logic.tsx -Pattern "preflightCardStateRef = useRef"`; if its declaration is below `interruptActiveRun`, refs are stable across renders so hook order is irrelevant, but confirm the const is declared before line 3052 — if not, move the guard to reference only `pendingCouncilQuestionRef` and handle preflight via its existing declaration position.)

- [ ] **Step 3: Harness E2E verification (manual, mock)**

Re-create the mock fixture flow used in the 2026-07-06 verification session (sequence fixture with a `{model:{stream}}` file alongside — see memory `council-ux-live-verified`), then:

1. `tui.start` with mockLlmDir in a scratch cwd, `/council 2 <topic>`, wait for `id=askcard`.
2. Press `Escape`.
3. Assert via `tui_query`: `id=rail-rounds` still present; `id~="council-round"` regions still present.
4. `tui.stop`, delete scratch fixture dir.

Expected: rounds + synthesis survive Esc exactly as they survive Save & Exit.

- [ ] **Step 4: Commit**

```bash
git add src/ui/use-app-logic.tsx
git commit -m "fix(council): Esc on a pending askcard no longer wipes the debate UI

interruptActiveRun had no pending-askcard guard, so the renderer-internal
Escape listener ran Stage 2 (clearLiveTurnUi + abort) in parallel with the
card's own cancel handling — destroying rounds/rail/synthesis the moment
the post-debate card was dismissed (live-verified 2026-07-06). Guard
mirrors the existing typing-jump listener check."
```

---

### Task 4: Theme prop for leader bubble + thread theme at app.tsx call sites

**Files:**
- Modify: `src/ui/components/council-leader-bubble.tsx`
- Modify: `src/ui/app.tsx` (lines ~980, ~1076)
- Modify: `src/ui/components/council-conclusion-card.tsx`, `src/ui/components/council-synthesis-banner.tsx` (remove the `= dark` defaults added in Task 2)

**Why:** Three components hardcode the `dark` theme and break under a light theme. Every sibling takes `theme: Theme`.

- [ ] **Step 1: Convert `council-leader-bubble.tsx`**

```tsx
import type { CouncilMessage } from "../../types/index.js";
import type { Theme } from "../theme.js";

export interface CouncilLeaderBubbleProps {
  msg: CouncilMessage;
  terminalCols: number;
  theme: Theme;
}

export function buildLeaderHeader(round: number | undefined): string {
  return round !== undefined ? `Leader · round ${round} eval` : "Leader";
}

/**
 * Leader evaluation, rendered as a linear group-chat row (matching the debate
 * speakers) instead of a centered narrow bubble — a muted gray left bar marks
 * it as the moderator's turn while keeping the single downward reading flow.
 */
export function CouncilLeaderBubble({ msg, theme: t }: CouncilLeaderBubbleProps) {
  const header = buildLeaderHeader(msg.round);

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      border={["left"]}
      borderColor={t.councilLeaderBorder}
      paddingLeft={2}
    >
      <text fg={t.textMuted} attributes={1}>
        {header}
      </text>
      <text fg={t.textMuted}>{msg.text.trim()}</text>
    </box>
  );
}
```

- [ ] **Step 2: Thread theme in `app.tsx`**

Line ~980: `<CouncilLeaderBubble key={idx} msg={cm} terminalCols={width} />` → add `theme={t}`.
Line ~1076: `<CouncilSynthesisBanner key={idx} msg={cm} />` → add `theme={t}`.
(The surrounding JSX already has `t` in scope — `CouncilStatusList` at line 801 uses `theme={t}`. There may be more than one `CouncilSynthesisBanner`/`CouncilLeaderBubble` call site — `Select-String` for both names and update every occurrence.)

- [ ] **Step 3: Remove the temporary defaults**

In `council-conclusion-card.tsx` and `council-synthesis-banner.tsx`: change `theme?: Theme` → `theme: Theme` and drop `= dark` defaults; remove the now-unused `dark` import if nothing else references it.

- [ ] **Step 4: Typecheck + component tests + commit**

Run: `bunx tsc --noEmit && bunx vitest run src/ui/components`
Expected: PASS. Fix any test call sites that render these components without a theme by passing the `dark` theme fixture (tests import `dark` directly — that is allowed in tests).

```bash
git add src/ui/components/council-leader-bubble.tsx src/ui/components/council-conclusion-card.tsx src/ui/components/council-synthesis-banner.tsx src/ui/app.tsx src/ui/components/__tests__
git commit -m "fix(council): thread Theme prop through leader bubble, conclusion card, synthesis banner

Three council components hardcoded the dark theme (broken under light
theme) while every sibling takes theme via props. app.tsx call sites now
pass theme={t}."
```

---

### Task 5: Live-ticking elapsed in the council status list

**Files:**
- Modify: `src/types/index.ts` (`CouncilStatusData`, line ~301)
- Modify: `src/ui/components/council-status-list.tsx`
- Create: `src/ui/components/__tests__/council-status-list.test.ts`

**Interfaces:**
- Produces: `CouncilStatusData.startedAt?: number` (client-side stamp); `upsertStatus` stamps it — emitters unchanged.

**Why:** `formatElapsed(s.elapsedMs)` renders only the last emitted value; a stalled speaker freezes at its last-reported elapsed — the same "im lìm" symptom the phase timeline already fixed with `useHeartbeat` (council-phase-timeline.tsx:46-53).

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/components/__tests__/council-status-list.test.ts
import { describe, expect, it } from "vitest";
import type { CouncilStatusData } from "../../../types/index.js";
import { upsertStatus } from "../council-status-list.js";

const base: CouncilStatusData = {
  statusId: "s1",
  state: "active",
  phase: "debate",
  label: "Primary Analyst",
  elapsedMs: 2000,
};

describe("upsertStatus startedAt stamping", () => {
  it("stamps startedAt on first insert, back-dated by emitted elapsedMs", () => {
    const before = Date.now();
    const out = upsertStatus([], base);
    const after = Date.now();
    expect(out[0].startedAt).toBeGreaterThanOrEqual(before - 2000);
    expect(out[0].startedAt).toBeLessThanOrEqual(after - 2000);
  });

  it("preserves the original startedAt across updates", () => {
    const first = upsertStatus([], base);
    const stamped = first[0].startedAt;
    const second = upsertStatus(first, { ...base, elapsedMs: 5000, detail: "still going" });
    expect(second[0].startedAt).toBe(stamped);
  });

  it("keeps an emitter-provided startedAt untouched", () => {
    const out = upsertStatus([], { ...base, startedAt: 12345 });
    expect(out[0].startedAt).toBe(12345);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/ui/components/__tests__/council-status-list.test.ts`
Expected: FAIL — `startedAt` does not exist / is undefined.

- [ ] **Step 3: Implement**

`src/types/index.ts` — add to `CouncilStatusData` after `elapsedMs?: number;`:

```ts
  /** Client-side first-seen stamp (upsertStatus), back-dated by the emitted elapsedMs. Drives live-ticking elapsed. */
  startedAt?: number;
```

`council-status-list.tsx`:

```ts
export function upsertStatus(prev: CouncilStatusData[], next: CouncilStatusData): CouncilStatusData[] {
  const idx = prev.findIndex((s) => s.statusId === next.statusId);
  if (idx === -1) {
    // Stamp a client-side start anchor so the row can live-tick between emitter
    // updates (emitters only send elapsedMs on state transitions).
    const startedAt = next.startedAt ?? Date.now() - (next.elapsedMs ?? 0);
    return [...prev, { ...next, startedAt }];
  }
  const out = prev.slice();
  out[idx] = { ...next, startedAt: next.startedAt ?? out[idx].startedAt };
  return out;
}
```

In the component, mirror the timeline's heartbeat (copy the `useHeartbeat` pattern from council-phase-timeline.tsx:46-53 — it is 8 lines; duplicating beats a premature shared module, matching existing codebase style where each component owns its Spinner):

```ts
function useHeartbeat(tickMs = 1000): number {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return Date.now();
}
```

In `CouncilStatusList`, call `const now = useHeartbeat(1000);` as the FIRST line of the component — before the `if (statuses.length === 0) return null;` early return, hooks must be unconditional — and compute per row:

```ts
        const liveElapsedMs =
          s.state === "active" && typeof s.startedAt === "number" ? Math.max(0, now - s.startedAt) : s.elapsedMs;
        const meta = `(${formatElapsed(liveElapsedMs)}${formatTokens(s)})`;
```

- [ ] **Step 4: Run tests, commit**

Run: `bunx vitest run src/ui/components/__tests__/council-status-list.test.ts`
Expected: PASS.

```bash
git add src/types/index.ts src/ui/components/council-status-list.tsx src/ui/components/__tests__/council-status-list.test.ts
git commit -m "fix(council): live-ticking elapsed in the status list

Status rows froze at the last emitter-sent elapsedMs (same 'im lìm'
symptom the phase timeline fixed with useHeartbeat). upsertStatus stamps
a client-side startedAt anchor; active rows now tick every second."
```

---

### Task 6: Placeholder liveness — spinner + elapsed

**Files:**
- Modify: `src/ui/components/council-placeholder-bubble.tsx`
- Modify: `src/ui/components/__tests__/council-placeholder-bubble.test.ts` (if label assertions change)

**Why:** "Role · composing…" is a static line — no animation, no elapsed; a hung provider looks identical at 2s and 2min. Doc comment even promises a `●` sigil that was never rendered.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from "react";
import type { Theme } from "../theme.js";

export type PlaceholderVariant = "participant" | "leader";

export interface CouncilPlaceholderBubbleProps {
  role: string;
  /** Legacy pair-side hint — ignored in the linear group-chat layout. */
  side: "left" | "right";
  terminalCols: number;
  color: string;
  theme: Theme;
  variant?: PlaceholderVariant;
}

const FALLBACK_ROLE = "Speaker";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function buildPlaceholderLabel(role: string, elapsedSec?: number): string {
  const trimmed = role.trim();
  const display = trimmed.length > 0 ? trimmed : FALLBACK_ROLE;
  const elapsed = elapsedSec !== undefined && elapsedSec >= 1 ? ` · ${elapsedSec}s` : "";
  return `${display} · composing…${elapsed}`;
}

/**
 * "Typing…" indicator for a speaker whose turn is in flight — a spinner + a
 * role-colored line (`⠋ Role · composing… · 12s`) in the same linear stream as
 * the real messages, WhatsApp-style. Swapped for the real CouncilMessageBubble
 * when the council_message arrives. The spinner + ticking elapsed distinguish
 * a live provider from a hung one (a static line looked identical at 2s and
 * 2min — live-verified 2026-07-06).
 */
export function CouncilPlaceholderBubble({ role, color, theme: t }: CouncilPlaceholderBubbleProps) {
  const [startedAt] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);

  return (
    <box marginBottom={1} paddingLeft={2}>
      <text fg={t.accent}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} </text>
      <text fg={color}>{buildPlaceholderLabel(role, elapsedSec)}</text>
    </box>
  );
}
```

(The 100ms spinner interval doubles as the elapsed re-render tick — no second timer needed. Braille frames match the timeline/pill spinner vocabulary rather than adding a third glyph set.)

- [ ] **Step 2: Update label tests if they assert the exact string**

Run: `bunx vitest run src/ui/components/__tests__/council-placeholder-bubble.test.ts`
If FAIL on label text: `buildPlaceholderLabel("X")` (no elapsed arg) still returns `"X · composing…"` — signature is backward-compatible; only update tests that render the component and assert full output.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/council-placeholder-bubble.tsx src/ui/components/__tests__/council-placeholder-bubble.test.ts
git commit -m "fix(council): animate the composing placeholder with spinner + elapsed

Static 'Role · composing…' made a hung provider indistinguishable from a
live one. Braille spinner (matching timeline/pill vocabulary) + per-second
elapsed suffix."
```

---

### Task 7: Full verification gate

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Full unit suite (Pre-Push Test Gate — 0 failed)**

Run: `bunx vitest run`
Expected: PASS. Any red test — including pre-existing — blocks push; fix before proceeding.

- [ ] **Step 3: Harness suite**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/`
Expected: PASS (council specs cover the mock flow; Task 3 changed key handling — watch `askcard.spec.ts`, `council-flow.spec.ts`).

- [ ] **Step 4: Semantic lint + self-verify**

Run: `bun run lint:semantic`
Run: `bun run src/index.ts self-verify --since HEAD~6 --max 4`
Expected: both green; check `.claude/self-qa-last.json` for the PostToolUse hook verdicts.

- [ ] **Step 5: Live E2E spot-check (real model, optional but recommended)**

Repeat the 2026-07-06 live scenario: `tui.start` (no mock) in a scratch cwd, `/council 1 <small topic>`, approve plan, wait for synthesis. Assert: no `<think>` text in any `id~="council-msg"` value; synthesis renders as a conclusion card (query `id~="council-msg"` synthesis value should NOT start with `{`); Esc on the post-debate card leaves `id=rail-rounds` intact.

- [ ] **Step 6: Push**

```bash
git push origin feat/council-post-debate-ux
```

(Pre-push hook runs Tier 1 self-verify automatically on the touched UI surfaces.)
