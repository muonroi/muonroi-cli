# PIL Repo-Grounding Probe (Design B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Size repo-relative `/ideal` tasks by measured repository signals (matched files, total LOC, directory spread, symbol collisions) instead of the prompt sentence alone, so a "trivial-looking" prompt over a large surface (e.g. `refactor auth`) routes to Council instead of the hot-path.

**Architecture:** Keep the single cheap LLM classify (`llm-classify.ts`) unchanged. After it returns, when its verdict is ambiguous (not-`quick` OR low-confidence) AND the prompt references a repo target, run a deterministic grounding probe that reuses the existing `REPO_DEEP_MAP.md` index (`getRepoStructureHints`) — NO extra LLM call. The probe emits a `RepoGroundingProbeResult`; the `/ideal` route gate (`orchestrator.ts`) then applies two rules: `groundingUncertainty ⇒ Council`, and a measured LOC/file `bucket` that can escalate depth. Confidence becomes trigger-only — once the probe runs, its measured facts (not the classifier's confidence) drive routing.

**Tech Stack:** TypeScript (bun runtime), vitest (unit), muonroi agent-harness MCP (E2E routing verification). No new dependencies.

## Global Constraints

- **No hardcoded depth→routing tables.** Routing derives from measured counts via a monotonic threshold *formula* with fixture tests — never a fixed `{depth: route}` map. (CLAUDE.md Zero-Hardcode; council synthesis "Sizing signal / rejected: LOC variance / bucket becomes table → monotonic fixture tests".)
- **No extra LLM call.** The probe is pure/deterministic (filesystem index lookup + at most one bounded file read per distinct target). (Council: "Grounding method: deterministic reusable probe / rejected: second LLM call".)
- **Common path stays one cheap call.** Generic prompts (no repo target) and unambiguous high-confidence prompts skip the probe entirely.
- **`groundingUncertainty ⇒ council` is the accepted invariant**, scoped: `probe ran AND matchedFiles === 0 ⇒ council`, plus `collision ⇒ council`. The broad "zero matches always council" is rejected (non-repo tasks never define a probe result). (Council synthesis "Uncertainty policy".)
- **Confidence cannot override grounding.** After the probe runs, classifier confidence is used only to *trigger* the probe, never to override a measured routing decision. (Council: `auth-ghost` fixture.)
- **No Silent Catch.** Every catch logs module + operation + `err.message`. (CLAUDE.md.)
- **Evidence-First / Pre-Push Test Gate.** `bunx tsc --noEmit` 0 errors + full `bunx vitest run` 0 failures before any push. Routing behavior verified live via the MCP harness (per repo convention — deterministic core is unit-tested, end-to-end routing is harness-driven).
- **Commit messages:** conventional prefix, subject ≤72 chars, body ≤100 chars/line. Trailers `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_012VnyZhG51hJiEDSbUZESoM`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/pil/layer1_5-complexity-size.ts` | Complexity sizing; owns path-token extraction + repo-grounding scorer | Modify — export `extractPathTokens` and `scoreRepoGrounding` (currently module-private `collectDistinctPaths` / `scoreRepoGrounding`) so the probe reuses them (DRY). No behavior change. |
| `src/pil/repo-grounding-probe.ts` | The deterministic probe: prompt + repo index → measured grounding result | Create |
| `src/pil/__tests__/repo-grounding-probe.test.ts` | Unit tests for the probe (auth-small / auth-large / auth-ghost / generic) | Create |
| `src/orchestrator/orchestrator.ts` | `/ideal` route gate — run probe after classify, apply grounding rules | Modify (`~2384–2445`) |

The probe reuses the existing `getRepoStructureHints(cwd)` (`src/pil/repo-structure-hints.ts`) as its grounding source — the checked-in `REPO_DEEP_MAP.md` index (`path → lineCount`), already cached. A live full-repo glob is deliberately **out of v1 scope** (deferred; the static index is the "reuse layer1_5 where practical" path the council accepted). A target that is an exact existing file path but absent from the index is confirmed by a single bounded `existsSync`+line-count read.

---

## Interfaces produced (referenced by later tasks)

```ts
// src/pil/layer1_5-complexity-size.ts (now exported)
export function extractPathTokens(rawText: string): string[];
export function scoreRepoGrounding(
  paths: string[],
  hints: RepoStructureHint[],
): { score: number; hits: number };

// src/pil/repo-grounding-probe.ts
export type GroundingBucket = "none" | "small" | "medium" | "large";
export interface RepoGroundingProbeResult {
  ran: boolean;              // false when there was no repo target to probe
  targets: string[];         // distinct path/symbol tokens extracted from the prompt
  matchedFiles: number;      // indexed files (or confirmed on-disk paths) the targets resolved to
  totalLoc: number;          // summed lineCount across matched files
  matchedDirs: number;       // distinct top-two-segment directories among matches
  collision: boolean;        // a bare symbol/basename target resolved to >1 distinct path
  bucket: GroundingBucket;   // measured size bucket (formula, not a table)
  groundingUncertainty: boolean; // (ran && matchedFiles===0) || collision
}
export function probeRepoGrounding(
  prompt: string,
  hints: RepoStructureHint[],
  opts?: { cwd?: string },
): RepoGroundingProbeResult;
```

---

### Task 1: Export path extractor + grounding scorer from layer1_5

**Files:**
- Modify: `src/pil/layer1_5-complexity-size.ts` (rename `collectDistinctPaths` → exported `extractPathTokens`; add `export` to `scoreRepoGrounding`; update the one internal caller)
- Test: `src/pil/__tests__/layer1_5-exports.test.ts` (Create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function extractPathTokens(rawText: string): string[]`, `export function scoreRepoGrounding(paths: string[], hints: RepoStructureHint[]): { score: number; hits: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/pil/__tests__/layer1_5-exports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractPathTokens, scoreRepoGrounding } from "../layer1_5-complexity-size.js";

describe("extractPathTokens", () => {
  it("extracts distinct path-like tokens, lowercased", () => {
    expect(extractPathTokens("refactor src/auth/login.ts and Src/Auth/Login.ts").sort()).toEqual([
      "src/auth/login.ts",
    ]);
  });

  it("returns [] when no path-like token is present", () => {
    expect(extractPathTokens("explain how oauth works")).toEqual([]);
  });
});

describe("scoreRepoGrounding", () => {
  it("scores +4 for a >=5000-line indexed match, +2 for >=2000", () => {
    const hints = [
      { path: "src/ui/app.tsx", lineCount: 6200 },
      { path: "src/pil/config.ts", lineCount: 2100 },
    ];
    expect(scoreRepoGrounding(["src/ui/app.tsx"], hints)).toEqual({ score: 4, hits: 1 });
    expect(scoreRepoGrounding(["src/pil/config.ts"], hints)).toEqual({ score: 2, hits: 1 });
  });

  it("returns zero when no path or no hint matches", () => {
    expect(scoreRepoGrounding([], [{ path: "a", lineCount: 9000 }])).toEqual({ score: 0, hits: 0 });
    expect(scoreRepoGrounding(["nope.ts"], [{ path: "a.ts", lineCount: 9000 }])).toEqual({ score: 0, hits: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/layer1_5-exports.test.ts`
Expected: FAIL — `extractPathTokens` / `scoreRepoGrounding` are not exported (import resolves to `undefined`).

- [ ] **Step 3: Make the change**

In `src/pil/layer1_5-complexity-size.ts`:

Rename the function and export it:

```ts
export function extractPathTokens(rawText: string): string[] {
  const matches = rawText.match(PATH_TOKEN_RE);
  if (!matches) return [];
  const set = new Set<string>();
  for (const m of matches) set.add(m.toLowerCase());
  return [...set];
}
```

Add `export` to the scorer (keep the body verbatim):

```ts
export function scoreRepoGrounding(paths: string[], hints: RepoStructureHint[]): { score: number; hits: number } {
  if (paths.length === 0 || hints.length === 0) return { score: 0, hits: 0 };
  const hinted = new Map(hints.map((hint) => [hint.path.toLowerCase(), hint]));
  let score = 0;
  let hits = 0;
  for (const path of paths) {
    const hint = hinted.get(path);
    if (!hint) continue;
    hits += 1;
    if (hint.lineCount >= 5000) score = Math.max(score, 4);
    else if (hint.lineCount >= 2000) score = Math.max(score, 2);
  }
  return { score, hits };
}
```

Update the internal caller inside `scoreComplexitySize` (was `collectDistinctPaths(rawText)`):

```ts
  const distinctPaths = extractPathTokens(rawText);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/pil/__tests__/layer1_5-exports.test.ts src/pil/layer1_5-complexity-size.test.ts`
Expected: PASS (new file + the existing 32-test file both green — the rename is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add src/pil/layer1_5-complexity-size.ts src/pil/__tests__/layer1_5-exports.test.ts
git commit -m "refactor(pil): export path extractor + grounding scorer"
```

---

### Task 2: The deterministic repo-grounding probe

**Files:**
- Create: `src/pil/repo-grounding-probe.ts`
- Test: `src/pil/__tests__/repo-grounding-probe.test.ts`

**Interfaces:**
- Consumes: `extractPathTokens` (Task 1), `RepoStructureHint` from `./repo-structure-hints.js`.
- Produces: `RepoGroundingProbeResult`, `GroundingBucket`, `probeRepoGrounding(prompt, hints, opts?)`.

- [ ] **Step 1: Write the failing test**

Create `src/pil/__tests__/repo-grounding-probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { probeRepoGrounding } from "../repo-grounding-probe.js";

const AUTH_SMALL = [
  { path: "src/auth/login.ts", lineCount: 80 },
  { path: "src/auth/session.ts", lineCount: 40 },
];

// 47 files, ~9k LOC, broad dir spread.
const AUTH_LARGE = Array.from({ length: 47 }, (_, i) => ({
  path: `src/${["auth", "ui", "orchestrator", "council", "pil"][i % 5]}/mod-${i}.ts`,
  lineCount: 191,
}));

describe("probeRepoGrounding", () => {
  it("does NOT run when the prompt has no repo target (generic prompt)", () => {
    const r = probeRepoGrounding("explain how oauth refresh works", AUTH_SMALL);
    expect(r.ran).toBe(false);
    expect(r.matchedFiles).toBe(0);
    expect(r.groundingUncertainty).toBe(false); // non-repo tasks never define a probe result
    expect(r.bucket).toBe("none");
  });

  it("auth-small: a small grounded target stays small (direct-eligible)", () => {
    const r = probeRepoGrounding("refactor src/auth/login.ts", AUTH_SMALL);
    expect(r.ran).toBe(true);
    expect(r.matchedFiles).toBe(1);
    expect(r.totalLoc).toBe(80);
    expect(r.groundingUncertainty).toBe(false);
    expect(r.bucket).toBe("small");
  });

  it("auth-large: many files / high LOC / broad spread → large + heavier", () => {
    const targets = AUTH_LARGE.map((h) => h.path).join(" ");
    const r = probeRepoGrounding(`refactor ${targets}`, AUTH_LARGE);
    expect(r.ran).toBe(true);
    expect(r.matchedFiles).toBe(47);
    expect(r.totalLoc).toBeGreaterThanOrEqual(8000);
    expect(r.matchedDirs).toBeGreaterThanOrEqual(4);
    expect(r.bucket).toBe("large");
  });

  it("auth-ghost: a named target that resolves to ZERO indexed files sets uncertainty", () => {
    const r = probeRepoGrounding("refactor src/auth/ghost.ts", AUTH_SMALL);
    expect(r.ran).toBe(true);
    expect(r.matchedFiles).toBe(0);
    expect(r.groundingUncertainty).toBe(true); // probe ran AND matchedFiles===0
    expect(r.bucket).toBe("none");
  });

  it("collision: a bare basename matching >1 indexed path sets uncertainty", () => {
    const hints = [
      { path: "src/auth/config.ts", lineCount: 50 },
      { path: "src/pil/config.ts", lineCount: 60 },
    ];
    const r = probeRepoGrounding("update config.ts everywhere", hints);
    expect(r.ran).toBe(true);
    expect(r.collision).toBe(true);
    expect(r.groundingUncertainty).toBe(true);
  });

  it("is monotonic: adding a matched large file never lowers the bucket", () => {
    const small = probeRepoGrounding("touch src/auth/login.ts", AUTH_SMALL);
    const bigger = probeRepoGrounding("touch src/auth/login.ts and src/ui/app.tsx", [
      ...AUTH_SMALL,
      { path: "src/ui/app.tsx", lineCount: 6200 },
    ]);
    const rank = { none: 0, small: 1, medium: 2, large: 3 } as const;
    expect(rank[bigger.bucket]).toBeGreaterThanOrEqual(rank[small.bucket]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/pil/__tests__/repo-grounding-probe.test.ts`
Expected: FAIL — `../repo-grounding-probe.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/pil/repo-grounding-probe.ts`:

```ts
/**
 * src/pil/repo-grounding-probe.ts
 *
 * Deterministic repo-grounding probe (Design B). Given a prompt + the
 * checked-in REPO_DEEP_MAP index, measure how much repository surface the
 * prompt's targets actually cover — file count, total LOC, directory spread,
 * symbol collisions — so routing sizes on facts, not on the sentence length.
 *
 * PURE + deterministic: NO LLM call, NO network. Filesystem access is bounded
 * to at most one existsSync + line-count read per distinct target that is an
 * exact path absent from the index. Buckets come from a monotonic threshold
 * FORMULA over measured counts — never a fixed depth→route table.
 *
 * See docs/superpowers/plans/2026-07-16-pil-repo-grounding-probe.md and the
 * council synthesis (Design B) for the accepted invariants.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPathTokens } from "./layer1_5-complexity-size.js";
import type { RepoStructureHint } from "./repo-structure-hints.js";

export type GroundingBucket = "none" | "small" | "medium" | "large";

export interface RepoGroundingProbeResult {
  ran: boolean;
  targets: string[];
  matchedFiles: number;
  totalLoc: number;
  matchedDirs: number;
  collision: boolean;
  bucket: GroundingBucket;
  groundingUncertainty: boolean;
}

/** Distinct top-two path segments, e.g. "src/auth/login.ts" → "src/auth". */
function topDir(path: string): string {
  const segs = path.split("/");
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0] ?? path;
}

/** A target is a "bare basename" when it has no slash (a symbol/file name, not a path). */
function isBareName(target: string): boolean {
  return !target.includes("/");
}

/**
 * Measured LOC/file bucket. Monotonic in every input: more files, more LOC, or
 * wider directory spread never lowers the bucket. Thresholds are counts (not a
 * depth map) and are covered by fixture tests — the only knob the council
 * permits for sizing.
 */
function bucketOf(matchedFiles: number, totalLoc: number, matchedDirs: number): GroundingBucket {
  if (matchedFiles === 0) return "none";
  if (matchedFiles >= 8 || totalLoc >= 4000 || matchedDirs >= 4) return "large";
  if (matchedFiles <= 2 && totalLoc < 500 && matchedDirs <= 1) return "small";
  return "medium";
}

export function probeRepoGrounding(
  prompt: string,
  hints: RepoStructureHint[],
  opts?: { cwd?: string },
): RepoGroundingProbeResult {
  const targets = extractPathTokens(prompt);
  if (targets.length === 0) {
    return {
      ran: false,
      targets: [],
      matchedFiles: 0,
      totalLoc: 0,
      matchedDirs: 0,
      collision: false,
      bucket: "none",
      groundingUncertainty: false,
    };
  }

  const index = new Map(hints.map((h) => [h.path.toLowerCase(), h]));
  // basename → the distinct indexed paths carrying it (for collision detection).
  const byBasename = new Map<string, Set<string>>();
  for (const h of hints) {
    const base = h.path.toLowerCase().split("/").pop() ?? h.path.toLowerCase();
    const set = byBasename.get(base) ?? new Set<string>();
    set.add(h.path.toLowerCase());
    byBasename.set(base, set);
  }

  const matchedPaths = new Set<string>();
  let totalLoc = 0;
  let collision = false;

  for (const target of targets) {
    // 1. Exact indexed path.
    const exact = index.get(target);
    if (exact) {
      if (!matchedPaths.has(exact.path.toLowerCase())) {
        matchedPaths.add(exact.path.toLowerCase());
        totalLoc += exact.lineCount;
      }
      continue;
    }
    // 2. Bare basename/symbol resolving across >1 indexed path → collision.
    if (isBareName(target)) {
      const carriers = byBasename.get(target);
      if (carriers && carriers.size > 1) {
        collision = true;
        for (const p of carriers) {
          if (!matchedPaths.has(p)) {
            matchedPaths.add(p);
            totalLoc += index.get(p)?.lineCount ?? 0;
          }
        }
        continue;
      }
      if (carriers && carriers.size === 1) {
        const only = [...carriers][0];
        if (only && !matchedPaths.has(only)) {
          matchedPaths.add(only);
          totalLoc += index.get(only)?.lineCount ?? 0;
        }
        continue;
      }
    }
    // 3. Exact path not in the index but present on disk → confirm + count (bounded).
    const cwd = opts?.cwd;
    if (cwd && target.includes("/")) {
      const abs = join(cwd, target);
      try {
        if (existsSync(abs)) {
          const loc = readFileSync(abs, "utf8").split(/\r?\n/).length;
          if (!matchedPaths.has(target)) {
            matchedPaths.add(target);
            totalLoc += loc;
          }
        }
      } catch (err) {
        console.error(
          `[repo-grounding-probe] on-disk LOC read failed for ${target}: ${(err as Error)?.message}`,
        );
      }
    }
    // else: unmatched target — contributes to a zero-match uncertainty signal.
  }

  const matchedFiles = matchedPaths.size;
  const matchedDirs = new Set([...matchedPaths].map(topDir)).size;
  const bucket = bucketOf(matchedFiles, totalLoc, matchedDirs);
  const groundingUncertainty = matchedFiles === 0 || collision;

  return {
    ran: true,
    targets,
    matchedFiles,
    totalLoc,
    matchedDirs,
    collision,
    bucket,
    groundingUncertainty,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/pil/__tests__/repo-grounding-probe.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

```bash
git add src/pil/repo-grounding-probe.ts src/pil/__tests__/repo-grounding-probe.test.ts
git commit -m "feat(pil): deterministic repo-grounding probe"
```

---

### Task 3: Wire the probe into the `/ideal` route gate

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:2384-2445`

**Interfaces:**
- Consumes: `probeRepoGrounding` (Task 2), `getRepoStructureHints` from `../pil/repo-structure-hints.js`, `LlmClassifyResult.confidence`.
- Produces: no new export — mutates local `depth` / `routeForceCouncil` before `runProductLoop`.

The gate currently (lines 2401-2444) reads only `res.depthTier` + `res.needsClarification`. Insert the probe between the classify result and the council-routing gate.

- [ ] **Step 1: Add the probe imports at the classify block**

Where the classifier is imported (line ~2393), add the probe + hints imports alongside it:

```ts
        const { createLlmClassifier } = await import("../pil/llm-classify.js");
        const { probeRepoGrounding } = await import("../pil/repo-grounding-probe.js");
        const { getRepoStructureHints } = await import("../pil/repo-structure-hints.js");
```

- [ ] **Step 2: Run the probe after classify, before the gate**

Replace the block from `const res = await classify(payload.idea);` down to the end of the `try` (currently ending at line 2412 `if (res?.needsClarification === true) needsClarification = true;`) with:

```ts
        const res = await classify(payload.idea);
        if (res?.depthTier) {
          depth = res.depthTier;
        } else {
          console.error(
            `[ideal/route] model depth classify returned no depthTier — defaulting to "standard". idea=${JSON.stringify(payload.idea.slice(0, 80))}`,
          );
        }
        if (res?.needsClarification === true) needsClarification = true;

        // Design B — deterministic repo-grounding probe. Trigger on Layer-1
        // OUTPUT (ambiguity), NOT a prompt regex: run only when the verdict is
        // non-trivial (depth !== "quick") OR low-confidence, so a well-specified
        // trivial task still hot-paths on one cheap call. The probe itself is
        // deterministic (REPO_DEEP_MAP index + bounded on-disk reads, no LLM).
        // Once it runs its MEASURED facts drive routing — confidence is
        // trigger-only and can no longer override grounding.
        const lowConfidence = (res?.confidence ?? 1) < 0.7;
        if (depth !== "quick" || lowConfidence) {
          try {
            const hints = getRepoStructureHints(process.cwd());
            const probe = probeRepoGrounding(payload.idea, hints, { cwd: process.cwd() });
            if (probe.ran) {
              // Invariant: probe ran AND zero matched files, or a symbol
              // collision → route INTO Council (the arbiter). Never direct-
              // dispatch from weak grounding.
              if (probe.groundingUncertainty) {
                needsClarification = true;
                depth = depth === "quick" ? "standard" : depth;
              }
              // Measured size escalation: a large grounded surface routes heavy
              // regardless of the sentence-level classify verdict.
              if (probe.bucket === "large") depth = "heavy";
              console.error(
                `[ideal/route] grounding probe: files=${probe.matchedFiles} loc=${probe.totalLoc} ` +
                  `dirs=${probe.matchedDirs} collision=${probe.collision} bucket=${probe.bucket} ` +
                  `uncertainty=${probe.groundingUncertainty} → depth=${depth}`,
              );
            }
          } catch (err) {
            // Fail-open: a probe hiccup must never block /ideal (No-Silent-Catch).
            console.error(`[ideal/route] grounding probe failed, ignoring: ${(err as Error)?.message}`);
          }
        }
```

(The council-routing gate below is unchanged: `complexity = depth === "heavy" ? "high" : depth === "quick" ? "low" : "medium";` then `const trivial = depth === "quick" && needsClarification !== true; if (!trivial) routeForceCouncil = true;`. The probe feeds it purely by adjusting `depth` / `needsClarification`.)

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Full unit suite (Pre-Push Gate)**

Run: `bunx vitest run`
Expected: 0 failures (the gate change has no unit test — it is harness-verified in Task 4 — but the suite must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat(ideal): ground depth routing in measured repo signals"
```

---

### Task 4: Harness E2E — verify routing behavior end-to-end

**Files:**
- No source changes. This task is a live verification via the MCP harness (repo convention: routing/UX behavior is harness-driven, not unit-mocked — see CLAUDE.md self-QA + `feedback_harness_verify_no_unittest`).

**Interfaces:**
- Consumes: the wired gate from Task 3.

- [ ] **Step 1: Trivial /ideal stays hot-path (no probe escalation, no council)**

Drive the TUI via the harness (`tui_start --agent-mode` in a small temp repo cwd with no large files), send `/ideal fix a typo in README.md`, and assert: the `[ideal/route] grounding probe` log shows `bucket=small` or the probe is skipped (`depth==="quick"` and high confidence), and NO `council-speaker` event fires (hot-path).

Expected: route-decision resolves to the product-loop hot-path; `tui_last_event("council-speaker")` is null.

- [ ] **Step 2: Repo-heavy /ideal routes to Council with a `large` bucket**

In the `muonroi-cli` repo cwd, send a prompt spanning several source areas — e.g. `/ideal refactor src/ui/app.tsx src/orchestrator/orchestrator.ts src/council/llm.ts src/pil/pipeline.ts src/gsd/mutation-gate.ts` — and assert the `[ideal/route] grounding probe` log shows `bucket=large` (≥4 matched dirs / ≥8 files / ≥4000 LOC via the on-disk fallback) and a `council-speaker` event fires.

Expected: `depth=heavy` in the route log; `tui_last_event("council-speaker")` is non-null.

> Note (verified 2026-07-16): a single moderate file such as `src/ui/app.tsx` is now ~1600 lines → `bucket=medium`, NOT large — it still routes to Council via the `standard`-depth gate, but does not escalate depth to `heavy`. Use a multi-area prompt to exercise the `large ⇒ heavy` escalation. The static `REPO_DEEP_MAP.md` index resolves only ~1 hint under `MAP_LINE_RE`, so grounding here comes almost entirely from the on-disk fallback read.

- [ ] **Step 3: Ghost target escalates to Council (grounding beats confidence)**

Send `/ideal refactor src/auth/ghost.ts` (a path NOT in the index and NOT on disk). Assert the probe log shows `files=0 uncertainty=true` and the run routes into Council rather than the hot-path — proving a confident-but-ungrounded prompt cannot direct-dispatch.

Expected: `uncertainty=true` in the route log; council convenes.

- [ ] **Step 4: Record evidence + commit notes**

Capture the three `[ideal/route] grounding probe` log lines (stderr) + the `council-speaker` presence/absence for each case into the PR description as the acceptance evidence. No code commit for this task.

---

## Self-Review

**1. Spec coverage (council synthesis → task):**
- Accept Design B, Layer 1 → probe → gate → Task 3. ✓
- Reuse `layer1_5` / no new LLM call → Tasks 1-2 (reuse `extractPathTokens` + `scoreRepoGrounding`; probe is pure). ✓
- Triggers repo-relative (skip generic / skip unambiguous-high-conf) → Task 3 (`depth !== "quick" || lowConfidence`, and probe `ran:false` when no target). ✓
- No hardcoded depth table; measured LOC/file bucket formula → Task 2 `bucketOf` + monotonic test. ✓
- `groundingUncertainty ⇒ council`, scoped `ran && matchedFiles===0`, plus collision → Task 2 result + Task 3 gate. ✓
- Confidence cannot override grounding (auth-ghost) → Task 2 ghost test + Task 3 (confidence trigger-only). ✓
- Acceptance fixtures auth-small/large/ghost + call-count (generic → no probe) → Task 2 tests + Task 4 Step 1. ✓
- LOC-variance deferred → intentionally absent (bucket replaces it). ✓ (Council "Tradeoffs / MVP: LOC variance deferred".)

**2. Placeholder scan:** No TBD/TODO; every code step carries full code; commands have expected output. ✓

**3. Type consistency:** `RepoGroundingProbeResult` fields identical across the Interfaces block, Task 2 impl, and Task 3 usage (`probe.groundingUncertainty`, `probe.bucket`, `probe.matchedFiles`). `extractPathTokens`/`scoreRepoGrounding` signatures match Task 1 exports. `bucket` union `"none"|"small"|"medium"|"large"` consistent. ✓

**Deferred (not in v1, per council):** live full-repo glob (index + bounded on-disk read only); LOC-variance signal (no expected-LOC baseline yet); wiring the probe into the per-turn PIL Layer 1.5 (`pipeline.ts` already grounds statically — v1 targets the `/ideal` gate where mis-sizing actually causes over/under-engineering).
