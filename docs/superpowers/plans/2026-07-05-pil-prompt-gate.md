# PIL Prompt Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the leader-tier complexity assessor into a "PIL Gate" that assesses depth from full turn context and produces bounded, honest prompt enrichment (hedged hints, never asserted file targets) before the cloud agent runs.

**Architecture:** The existing turn-start assessor call (`message-processor.ts:661-706`) is upgraded: it is fed a full-context bundle (recent-turns digest + EE recall + prior plan + project-scan hints), and its structured verdict gains a `quality` block + an `enrichedPrompt`. Standard-tier turns use in-prompt producer self-critique (no extra LLM call); heavy-tier turns add up to 3 parallel adversarial critics (grounding/noise/sufficiency, downgrade-only, worst-verdict merge). The brief is *prepended* to `pilCtx.enriched` (never replaces it), under a ~2500ms gate deadline, fully fail-open so the depth writeback always runs.

**Tech Stack:** TypeScript + bun; vitest (unit) + vitest harness config (E2E); zod schemas; the council LLM infra (`createCouncilLLM` / `resolvePlanCouncilLeader`); the GSD native pipeline (`src/gsd`).

**Spec:** `docs/superpowers/specs/2026-07-05-pil-prompt-gate-design.md`
**Subsystem map (file:line anchors):** `REPO_DEEP_MAP.md` §§ src/pil, src/gsd, src/orchestrator, src/council.

## Global Constraints

- **Zero Hardcode Rule:** no model/provider ID string literals. Resolve the leader via `resolvePlanCouncilLeader(sessionModelId)`; throw if unresolvable. Exceptions only: type unions, test fixtures, `catalog.json`, `pricing.ts`.
- **No Silent Catch Rule:** every `catch` logs `[pil-gate] <op>: ${err.message}` with context. No bare `catch {}`.
- **Fail-open, never block a turn:** any producer/critic parse failure, deadline timeout, or throw degrades to `{ enrichedPrompt: raw, depth: priorDepth }`. The depth writeback + `syncWorkflowContext` must be reached on every path.
- **Billing `source=council`:** all gate LLM calls go through `createCouncilLLM` (auto-records usage; no cost leak).
- **Core/UI separation:** gate code (`src/gsd`, `src/pil`, `src/orchestrator`) may import `src/state` but NEVER `src/ui` or `opentui/react`.
- **Enrichment augments, never replaces:** the brief is *prepended* to `pilCtx.enriched`; the 1500-char budget applies to the added prefix only.
- **No asserted file targets:** any area reference is emitted as an unverified "confirm via grep before anchoring" hint, never as ground truth.
- **Depth source of truth is STATE.md** (`readState(cwd).depth`), not a pilCtx-threaded value. The producer writeback keeps `pilCtx.modelDepthTier` in sync for same-turn consumers, but the mutation gate reads STATE.md.
- **Pre-push gate:** full `bunx vitest run` (0 failures) + `bunx vitest -c vitest.harness.config.ts run tests/harness/` when touching harness surfaces.
- **Commit trailers (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01CuJVuD6u5ybAFmyJarL4pQ
  ```

## File Structure

- `src/gsd/assessment-schema.ts` — **modify**: extend the verdict schema + output contract + extractor with `quality` + `enrichedPrompt`.
- `src/gsd/flags.ts` — **modify**: add `isPilGateEnrichEnabled()`.
- `src/gsd/pil-gate-context.ts` — **new**: assemble the full-context bundle (digest / EE / plan / project hints), each tolerant + char-capped.
- `src/gsd/complexity-assessor.ts` — **modify**: populate context slots; producer emits `quality` + `enrichedPrompt`; standard-tier self-critique in-prompt; fail-open extended.
- `src/gsd/pil-gate-critic.ts` — **new**: heavy-tier parallel critics (grounding/noise/sufficiency), downgrade-only, worst-verdict merge.
- `src/orchestrator/message-processor.ts` — **modify** (~661-706 + runner 414-427): feed the bundle, run producer(+critics on heavy), apply the gate deadline, prepend the brief, wrap in own try/catch.
- `src/pil/discovery.ts` — **modify** (~306-309): drop the `scoreSufficiency` hint (discovery caller only).

---

### Task 1: Extend the assessment verdict schema + output contract

**Files:**
- Modify: `src/gsd/assessment-schema.ts:20-24` (schema), `:99` (contract), extractor at `:38`
- Test: `src/gsd/__tests__/assessment-schema.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ComplexityVerdict` gains `quality?: { verdict: "adequate"|"enriched"|"needs-user"; missing: string[]; noiseRisk: "low"|"med"|"high" }` and `enrichedPrompt?: string`. `ASSESSMENT_OUTPUT_CONTRACT` instructs the model to emit them. These are OPTIONAL so existing depth-only fixtures keep parsing.

- [ ] **Step 1: Write the failing test**

Add to `src/gsd/__tests__/assessment-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ASSESSMENT_OUTPUT_CONTRACT, extractComplexityVerdict } from "../assessment-schema.js";

describe("assessment-schema quality + enrichment", () => {
  it("parses a verdict carrying quality + enrichedPrompt", () => {
    const raw = [
      "```complexity-verdict",
      JSON.stringify({
        depth: "heavy",
        autoCouncil: true,
        rationale: "multi-file refactor",
        quality: { verdict: "enriched", missing: ["acceptance"], noiseRisk: "low" },
        enrichedPrompt: "Intent: ...\nLikely area: src/auth/ (confirm via grep before anchoring)",
      }),
      "```",
    ].join("\n");
    const v = extractComplexityVerdict(raw);
    expect(v?.quality?.verdict).toBe("enriched");
    expect(v?.quality?.missing).toEqual(["acceptance"]);
    expect(v?.quality?.noiseRisk).toBe("low");
    expect(v?.enrichedPrompt).toContain("confirm via grep");
  });

  it("still parses a depth-only verdict (backward compatible)", () => {
    const raw = '```complexity-verdict\n{"depth":"quick","autoCouncil":false,"rationale":"typo"}\n```';
    const v = extractComplexityVerdict(raw);
    expect(v?.depth).toBe("quick");
    expect(v?.quality).toBeUndefined();
    expect(v?.enrichedPrompt).toBeUndefined();
  });

  it("contract mentions the quality + enrichment fields", () => {
    expect(ASSESSMENT_OUTPUT_CONTRACT).toMatch(/quality/);
    expect(ASSESSMENT_OUTPUT_CONTRACT).toMatch(/enrichedPrompt/);
    expect(ASSESSMENT_OUTPUT_CONTRACT).toMatch(/noiseRisk/);
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `bunx vitest run src/gsd/__tests__/assessment-schema.test.ts`
Expected: FAIL — `quality`/`enrichedPrompt` stripped by the schema; contract lacks the fields.

- [ ] **Step 3: Extend the zod schema**

In `src/gsd/assessment-schema.ts`, extend `ComplexityVerdictSchema` (currently at ~L20-24):

```ts
export const ComplexityVerdictSchema = z.object({
  depth: z.enum(["quick", "standard", "heavy"]),
  autoCouncil: z.boolean(),
  rationale: z.string().default(""),
  quality: z
    .object({
      verdict: z.enum(["adequate", "enriched", "needs-user"]),
      missing: z.array(z.string()).default([]),
      noiseRisk: z.enum(["low", "med", "high"]).default("low"),
    })
    .optional(),
  enrichedPrompt: z.string().optional(),
});
```

- [ ] **Step 4: Extend the output contract**

Append to `ASSESSMENT_OUTPUT_CONTRACT` (the prompt-suffix constant at ~L99) a block describing the enrichment task. Use this exact text:

```ts
export const ASSESSMENT_OUTPUT_CONTRACT = `
Respond with ONLY a fenced code block labelled complexity-verdict containing JSON:

\`\`\`complexity-verdict
{
  "depth": "quick|standard|heavy",
  "autoCouncil": true|false,
  "rationale": "one sentence",
  "quality": { "verdict": "adequate|enriched|needs-user", "missing": ["intent"|"target"|"scope"|"acceptance"], "noiseRisk": "low|med|high" },
  "enrichedPrompt": "the enriched brief, or empty string when adequate"
}
\`\`\`

Prompt-quality rubric — a prompt is "adequate" when these BLOCKERS are present or confidently derivable WITHOUT padding: (1) Intent/Outcome, (2) Target/Locus, (3) Scope boundary, (4) Acceptance.
Enrichment rules (SIGNAL over noise):
- Every added line MUST change what the coding agent does; if it does not, omit it. Over-enrichment is a FAILURE — set noiseRisk="high" and cut.
- NEVER assert a file path as fact. Any area reference is an UNVERIFIED HINT: write "likely area: <dir> (confirm via grep before anchoring)". You cannot see the codebase.
- verdict="adequate" -> enrichedPrompt="" (use the raw prompt).
- verdict="enriched" -> a brief that fills derivable gaps + hedged hints only.
- verdict="needs-user" -> a blocker is NOT derivable from context; keep the brief minimal and list the open question(s) under "OPEN QUESTIONS:".
Keep enrichedPrompt under 1500 characters.`;
```

- [ ] **Step 5: Confirm extractor passes them through**

`extractComplexityVerdict` already parses via `ComplexityVerdictSchema.safeParse` — no code change needed; the new optional fields flow automatically. If `extractComplexityVerdict` maps fields manually, add `quality` + `enrichedPrompt` to the returned object.

- [ ] **Step 6: Run tests to verify pass**

Run: `bunx vitest run src/gsd/__tests__/assessment-schema.test.ts`
Expected: PASS (3/3). Then `bunx tsc --noEmit` → 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/gsd/assessment-schema.ts src/gsd/__tests__/assessment-schema.test.ts
git commit -m "feat(pil-gate): extend assessment schema with quality + enrichedPrompt"
```

---

### Task 2: Full-context bundle assembler + enrichment flag

**Files:**
- Create: `src/gsd/pil-gate-context.ts`
- Modify: `src/gsd/flags.ts` (add `isPilGateEnrichEnabled`)
- Test: `src/gsd/__tests__/pil-gate-context.test.ts`

**Interfaces:**
- Consumes: `readState`/`planningArtifact` (`src/gsd`), `BrainData` type (`src/pil/types.ts`), `getCachedProjectContext` (`src/pil/discovery-cache.ts`).
- Produces:
  ```ts
  export interface GateContextInput {
    cwd: string;
    conversationDigest?: string | null;   // deps.buildRecentTurnsSummary()
    brainData?: unknown;                   // pilCtx._brainData
  }
  export interface GateContextBundle {
    conversationDigest: string;   // "" when absent
    eeContext: string;            // formatted from brainData, "" when absent
    priorPlan: string;            // PLAN.md excerpt + phase, "" when absent
    projectHints: string;         // hedged directory hints, "" when empty scan
    totalChars: number;
  }
  export function buildGateContextBundle(input: GateContextInput): GateContextBundle;
  ```
- `isPilGateEnrichEnabled(): boolean` — `isGsdNativeEnabled() && process.env.MUONROI_PIL_GATE_ENRICH !== "0"`.

- [ ] **Step 1: Write the failing test**

Create `src/gsd/__tests__/pil-gate-context.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGateContextBundle } from "../pil-gate-context.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "pil-gate-ctx-"));
}

describe("buildGateContextBundle", () => {
  it("returns empty strings when nothing is available (tolerant)", () => {
    const b = buildGateContextBundle({ cwd: tempCwd() });
    expect(b.conversationDigest).toBe("");
    expect(b.eeContext).toBe("");
    expect(b.priorPlan).toBe("");
    expect(b.projectHints).toBe("");
    expect(b.totalChars).toBe(0);
  });

  it("includes the digest and caps oversized inputs", () => {
    const b = buildGateContextBundle({ cwd: tempCwd(), conversationDigest: "x".repeat(5000) });
    expect(b.conversationDigest.length).toBeLessThanOrEqual(1200);
    expect(b.totalChars).toBeGreaterThan(0);
  });

  it("reads a prior PLAN.md when present", () => {
    const cwd = tempCwd();
    mkdirSync(join(cwd, ".planning"), { recursive: true });
    writeFileSync(join(cwd, ".planning", "PLAN.md"), "# PLAN\n\n## Steps\n1. do the thing", "utf8");
    const b = buildGateContextBundle({ cwd });
    expect(b.priorPlan).toContain("do the thing");
  });

  it("formats brainData principles/patterns into eeContext", () => {
    const b = buildGateContextBundle({
      cwd: tempCwd(),
      brainData: { t0_principles: ["Prefer library over bespoke"], t2_patterns: ["auth lives in providers"] },
    });
    expect(b.eeContext).toContain("Prefer library");
    expect(b.eeContext).toContain("auth lives in providers");
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

Run: `bunx vitest run src/gsd/__tests__/pil-gate-context.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the assembler**

Create `src/gsd/pil-gate-context.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { planningArtifact } from "./paths.js";
import { readState } from "./workflow-engine.js";

export interface GateContextInput {
  cwd: string;
  conversationDigest?: string | null;
  brainData?: unknown;
}

export interface GateContextBundle {
  conversationDigest: string;
  eeContext: string;
  priorPlan: string;
  projectHints: string;
  totalChars: number;
}

function cap(text: string, max: number): string {
  const t = (text ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…[truncated]`;
}

/** Render EE recall (BrainData shape from layer1's pilContext fetch) into a compact block. */
function formatEeContext(brainData: unknown): string {
  if (!brainData || typeof brainData !== "object") return "";
  const b = brainData as Record<string, unknown>;
  const principles = Array.isArray(b.t0_principles) ? (b.t0_principles as unknown[]).map(String) : [];
  const patterns = Array.isArray(b.t2_patterns) ? (b.t2_patterns as unknown[]).map(String) : [];
  const rules = Array.isArray(b.t1_rules) ? (b.t1_rules as unknown[]).map(String) : [];
  const lines = [
    ...principles.slice(0, 3).map((p) => `- principle: ${p}`),
    ...rules.slice(0, 3).map((r) => `- rule: ${r}`),
    ...patterns.slice(0, 3).map((p) => `- pattern: ${p}`),
  ];
  return cap(lines.join("\n"), 600);
}

function readPriorPlan(cwd: string): string {
  const p = planningArtifact(cwd, "PLAN.md");
  if (!existsSync(p)) return "";
  let phase = "";
  try {
    phase = readState(cwd).phase ?? "";
  } catch (err) {
    console.error(`[pil-gate] readState for prior-plan phase failed: ${(err as Error).message}`);
  }
  const body = cap(readFileSync(p, "utf8"), 800);
  return phase ? `phase: ${phase}\n${body}` : body;
}

export function buildGateContextBundle(input: GateContextInput): GateContextBundle {
  const conversationDigest = cap(input.conversationDigest ?? "", 1200);
  let eeContext = "";
  try {
    eeContext = formatEeContext(input.brainData);
  } catch (err) {
    console.error(`[pil-gate] formatEeContext failed: ${(err as Error).message}`);
  }
  let priorPlan = "";
  try {
    priorPlan = readPriorPlan(input.cwd);
  } catch (err) {
    console.error(`[pil-gate] readPriorPlan failed: ${(err as Error).message}`);
  }
  // projectHints intentionally left "" in v1: the discovery ProjectContext scan is
  // directory-level only (REPO_DEEP_MAP §src/pil) and produces mislead-prone
  // substring matches. Hedged hints are the producer's job, not asserted here.
  const projectHints = "";
  const totalChars = conversationDigest.length + eeContext.length + priorPlan.length + projectHints.length;
  return { conversationDigest, eeContext, priorPlan, projectHints, totalChars };
}
```

- [ ] **Step 4: Add the flag**

In `src/gsd/flags.ts`, mirroring `isComplexityAssessorEnabled` (~L16):

```ts
export function isPilGateEnrichEnabled(): boolean {
  return isGsdNativeEnabled() && process.env.MUONROI_PIL_GATE_ENRICH !== "0";
}
```

- [ ] **Step 5: Test the flag**

Add `src/gsd/__tests__/flags.test.ts` cases (or extend existing):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { isPilGateEnrichEnabled } from "../flags.js";

describe("isPilGateEnrichEnabled", () => {
  const orig = { native: process.env.MUONROI_GSD_NATIVE, enrich: process.env.MUONROI_PIL_GATE_ENRICH };
  afterEach(() => {
    process.env.MUONROI_GSD_NATIVE = orig.native;
    process.env.MUONROI_PIL_GATE_ENRICH = orig.enrich;
  });
  it("defaults on with native GSD", () => {
    delete process.env.MUONROI_GSD_NATIVE;
    delete process.env.MUONROI_PIL_GATE_ENRICH;
    expect(isPilGateEnrichEnabled()).toBe(true);
  });
  it("off when explicitly disabled", () => {
    process.env.MUONROI_PIL_GATE_ENRICH = "0";
    expect(isPilGateEnrichEnabled()).toBe(false);
  });
  it("off when native GSD is off (coupling)", () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    delete process.env.MUONROI_PIL_GATE_ENRICH;
    expect(isPilGateEnrichEnabled()).toBe(false);
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bunx vitest run src/gsd/__tests__/pil-gate-context.test.ts src/gsd/__tests__/flags.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` → 0.

- [ ] **Step 7: Commit**

```bash
git add src/gsd/pil-gate-context.ts src/gsd/flags.ts src/gsd/__tests__/pil-gate-context.test.ts src/gsd/__tests__/flags.test.ts
git commit -m "feat(pil-gate): context bundle assembler + MUONROI_PIL_GATE_ENRICH flag"
```

---

### Task 3: Producer — expand the complexity assessor to emit quality + enrichment

**Files:**
- Modify: `src/gsd/complexity-assessor.ts` (AssessResult `:17-24`, buildAssessorPrompt `:34-48`, assessComplexity `:80-133`)
- Test: `src/gsd/__tests__/complexity-assessor.test.ts`

**Interfaces:**
- Consumes: `GateContextBundle` (Task 2), `ComplexityVerdict.quality`/`.enrichedPrompt` (Task 1).
- Produces: `AssessResult` gains `quality?: {verdict; missing; noiseRisk}` and `enrichedPrompt: string` (defaults `""`). `AssessInput` gains `bundle?: GateContextBundle` (replaces the raw `conversationDigest`/`eeContext` string slots by folding them through the bundle; keep the existing optional fields for back-compat but prefer `bundle`). Fail-open paths return `enrichedPrompt: ""`, `quality: undefined`.

- [ ] **Step 1: Write the failing test**

Add to `src/gsd/__tests__/complexity-assessor.test.ts`:

```ts
it("passes bundle context into the assessor prompt and returns quality + enrichedPrompt", async () => {
  let seenPrompt = "";
  const res = await assessComplexity({
    cwd: tempCwd(),
    raw: "fix the login bug",
    priorDepth: "heavy",
    confidence: 0.75,
    sessionModelId: "test-model",
    bundle: {
      conversationDigest: "prior: user asked about oauth login",
      eeContext: "- pattern: auth lives in providers",
      priorPlan: "",
      projectHints: "",
      totalChars: 60,
    },
    runAssessor: async (prompt) => {
      seenPrompt = prompt;
      return [
        "```complexity-verdict",
        JSON.stringify({
          depth: "heavy",
          autoCouncil: false,
          rationale: "auth change",
          quality: { verdict: "enriched", missing: ["acceptance"], noiseRisk: "low" },
          enrichedPrompt: "Intent: fix login\nLikely area: providers (confirm via grep before anchoring)",
        }),
        "```",
      ].join("\n");
    },
  });
  expect(seenPrompt).toContain("prior: user asked about oauth login");
  expect(seenPrompt).toContain("auth lives in providers");
  expect(res.quality?.verdict).toBe("enriched");
  expect(res.enrichedPrompt).toContain("confirm via grep");
});

it("fail-open returns empty enrichedPrompt + priorDepth on parse failure", async () => {
  const res = await assessComplexity({
    cwd: tempCwd(),
    raw: "x",
    priorDepth: "standard",
    confidence: 0.75,
    sessionModelId: "test-model",
    runAssessor: async () => "garbage, no fenced block",
  });
  expect(res.depth).toBe("standard");
  expect(res.enrichedPrompt).toBe("");
  expect(res.quality).toBeUndefined();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bunx vitest run src/gsd/__tests__/complexity-assessor.test.ts`
Expected: FAIL — `res.quality`/`res.enrichedPrompt` undefined; `bundle` not threaded into the prompt.

- [ ] **Step 3: Extend types + prompt + result mapping**

In `src/gsd/complexity-assessor.ts`:

Add to `AssessInput` (~L7-16): `bundle?: import("./pil-gate-context.js").GateContextBundle;`

Add to `AssessResult` (~L17-24): `quality?: { verdict: "adequate" | "enriched" | "needs-user"; missing: string[]; noiseRisk: "low" | "med" | "high" }; enrichedPrompt: string;`

Update `buildAssessorPrompt` (~L34-48) to prefer the bundle:

```ts
function buildAssessorPrompt(input: AssessInput): string {
  const digest = input.bundle?.conversationDigest || input.conversationDigest || "";
  const ee = input.bundle?.eeContext || input.eeContext || "";
  const plan = input.bundle?.priorPlan || "";
  return [
    "You are the complexity assessor — the highest-tier router for an autonomous coding agent.",
    "Judge how much rigor this task needs, whether it warrants multi-perspective debate, and enrich an under-specified prompt.",
    "Be decisive: over-tiering wastes time, under-tiering ships unreviewed risk, over-enriching adds noise.",
    "",
    `Fast classifier's first-pass depth: ${input.priorDepth} (confidence ${input.confidence.toFixed(2)}).`,
    digest ? `\nRecent conversation:\n${digest}` : "",
    ee ? `\nPrior experience (EE recall):\n${ee}` : "",
    plan ? `\nPrior plan (this task):\n${plan}` : "",
    "",
    "### Task",
    input.raw,
    ASSESSMENT_OUTPUT_CONTRACT,
  ].join("\n");
}
```

In `assessComplexity`, every return path must carry `enrichedPrompt`. On the three fail-open paths add `enrichedPrompt: ""`. On the success path (after `extractComplexityVerdict`) map:

```ts
return {
  depth: verdict.depth,
  autoCouncil: verdict.autoCouncil,
  rationale: verdict.rationale,
  assessed: true,
  source: "assessor",
  assessmentPath: path,
  quality: verdict.quality,
  enrichedPrompt: verdict.enrichedPrompt ?? "",
};
```

Also add `enrichedPrompt: ""` to the two early prefilter-skip returns (`shouldAssess` false, no `runAssessor`).

- [ ] **Step 4: Enforce the 1500-char budget defensively**

After extracting the verdict, clamp the brief so a misbehaving model cannot blow the budget:

```ts
const brief = (verdict.enrichedPrompt ?? "").slice(0, 1500);
```
and return `enrichedPrompt: brief`.

- [ ] **Step 5: Run tests to verify pass**

Run: `bunx vitest run src/gsd/__tests__/complexity-assessor.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` → 0.

- [ ] **Step 6: Commit**

```bash
git add src/gsd/complexity-assessor.ts src/gsd/__tests__/complexity-assessor.test.ts
git commit -m "feat(pil-gate): producer emits quality verdict + bounded enriched brief"
```

---

### Task 4: Heavy-tier adversarial critics (downgrade-only, worst-verdict merge)

**Files:**
- Create: `src/gsd/pil-gate-critic.ts`
- Test: `src/gsd/__tests__/pil-gate-critic.test.ts`

**Interfaces:**
- Consumes: `GateContextBundle` (Task 2), the producer draft (`{ verdict, enrichedPrompt }`).
- Produces:
  ```ts
  export type GateVerdict = "adequate" | "enriched" | "needs-user";
  export interface CriticResult { verdict: GateVerdict; brief: string }
  export type RunCriticFn = (prompt: string) => Promise<string>;
  export function buildCriticPrompt(role: "grounding" | "noise" | "sufficiency", draftBrief: string, draftVerdict: GateVerdict, bundle: GateContextBundle): string;
  export function mergeCriticVerdicts(producer: GateVerdict, criticVerdicts: GateVerdict[]): GateVerdict; // worst-wins, downgrade-only
  export function runGateCritics(args: { draftBrief: string; draftVerdict: GateVerdict; bundle: GateContextBundle; runCritic: RunCriticFn }): Promise<CriticResult>;
  ```
  Merge order (worst first): `needs-user` > `enriched` > `adequate`. A critic verdict can only move the result toward `needs-user`, never toward `adequate` (downgrade-only). Each critic returns a fenced `gate-critic` JSON `{ "verdict": "...", "strippedBrief": "..." }`; parse failure → treat as `needs-user` with the producer brief (conservative), never as approval.

- [ ] **Step 1: Write the failing test**

Create `src/gsd/__tests__/pil-gate-critic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeCriticVerdicts, runGateCritics } from "../pil-gate-critic.js";

const bundle = { conversationDigest: "", eeContext: "", priorPlan: "", projectHints: "", totalChars: 0 };

describe("mergeCriticVerdicts (downgrade-only, worst-wins)", () => {
  it("a critic cannot upgrade needs-user to adequate", () => {
    expect(mergeCriticVerdicts("needs-user", ["adequate", "adequate"])).toBe("needs-user");
  });
  it("a critic downgrades enriched to needs-user", () => {
    expect(mergeCriticVerdicts("enriched", ["adequate", "needs-user"])).toBe("needs-user");
  });
  it("all-adequate stays adequate", () => {
    expect(mergeCriticVerdicts("adequate", ["adequate", "adequate", "adequate"])).toBe("adequate");
  });
});

describe("runGateCritics", () => {
  it("runs 3 critics and applies the worst verdict", async () => {
    let calls = 0;
    const res = await runGateCritics({
      draftBrief: "Likely area: src/state/ (confirm via grep before anchoring)",
      draftVerdict: "enriched",
      bundle,
      runCritic: async () => {
        calls++;
        const verdict = calls === 2 ? "needs-user" : "enriched";
        return `\`\`\`gate-critic\n{"verdict":"${verdict}","strippedBrief":"trimmed"}\n\`\`\``;
      },
    });
    expect(calls).toBe(3);
    expect(res.verdict).toBe("needs-user");
  });

  it("parse failure is conservative (needs-user, keeps producer brief)", async () => {
    const res = await runGateCritics({
      draftBrief: "keep me",
      draftVerdict: "enriched",
      bundle,
      runCritic: async () => "no fenced block here",
    });
    expect(res.verdict).toBe("needs-user");
    expect(res.brief).toContain("keep me");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bunx vitest run src/gsd/__tests__/pil-gate-critic.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the critic module**

Create `src/gsd/pil-gate-critic.ts`:

```ts
export type GateVerdict = "adequate" | "enriched" | "needs-user";

export interface CriticResult {
  verdict: GateVerdict;
  brief: string;
}

export type RunCriticFn = (prompt: string) => Promise<string>;

const RANK: Record<GateVerdict, number> = { adequate: 0, enriched: 1, "needs-user": 2 };
const CRITIC_ROLES = ["grounding", "noise", "sufficiency"] as const;
type CriticRole = (typeof CRITIC_ROLES)[number];

const ROLE_MANDATE: Record<CriticRole, string> = {
  grounding:
    "Strip any claim not traceable to the provided context. Flag ANY area/file reference not explicitly hedged as 'confirm via grep before anchoring' — an asserted file path is a defect.",
  noise:
    "Strip any line that does not change what the coding agent does. If most of the brief is noise, downgrade the verdict.",
  sufficiency:
    "Decide whether 'adequate' is honest or a blocker (intent/target/scope/acceptance) is being papered over. You may flip to needs-user; you may NOT upgrade toward adequate.",
};

export function buildCriticPrompt(
  role: CriticRole,
  draftBrief: string,
  draftVerdict: GateVerdict,
  bundle: { conversationDigest: string; eeContext: string; priorPlan: string },
): string {
  return [
    `You are the ${role} critic for a prompt-enrichment gate. You may only TIGHTEN — downgrade the verdict and strip lines, never upgrade or add.`,
    ROLE_MANDATE[role],
    "",
    "Provided context (the ONLY sources the brief may draw on):",
    bundle.conversationDigest ? `Recent conversation:\n${bundle.conversationDigest}` : "(no recent conversation)",
    bundle.eeContext ? `EE recall:\n${bundle.eeContext}` : "(no EE recall)",
    bundle.priorPlan ? `Prior plan:\n${bundle.priorPlan}` : "(no prior plan)",
    "",
    `Producer verdict: ${draftVerdict}`,
    "Producer brief:",
    draftBrief || "(empty)",
    "",
    "Respond with ONLY a fenced block:",
    '```gate-critic',
    '{ "verdict": "adequate|enriched|needs-user", "strippedBrief": "the brief with noise/ungrounded/unhedged lines removed" }',
    "```",
  ].join("\n");
}

function parseCritic(raw: string): { verdict: GateVerdict; strippedBrief: string } | null {
  const m = raw.match(/```gate-critic\s*([\s\S]*?)```/);
  const body = m?.[1] ?? raw;
  const brace = body.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    const parsed = JSON.parse(brace[0]) as { verdict?: string; strippedBrief?: string };
    if (parsed.verdict !== "adequate" && parsed.verdict !== "enriched" && parsed.verdict !== "needs-user") return null;
    return { verdict: parsed.verdict, strippedBrief: String(parsed.strippedBrief ?? "") };
  } catch (err) {
    console.error(`[pil-gate] critic parse failed: ${(err as Error).message}`);
    return null;
  }
}

/** Worst-wins AND downgrade-only: the result is never less severe than the producer verdict. */
export function mergeCriticVerdicts(producer: GateVerdict, criticVerdicts: GateVerdict[]): GateVerdict {
  let worst = producer;
  for (const v of criticVerdicts) {
    if (RANK[v] > RANK[worst]) worst = v;
  }
  return worst;
}

export async function runGateCritics(args: {
  draftBrief: string;
  draftVerdict: GateVerdict;
  bundle: { conversationDigest: string; eeContext: string; priorPlan: string };
  runCritic: RunCriticFn;
}): Promise<CriticResult> {
  const settled = await Promise.all(
    CRITIC_ROLES.map((role) =>
      args
        .runCritic(buildCriticPrompt(role, args.draftBrief, args.draftVerdict, args.bundle))
        .then((raw) => parseCritic(raw))
        .catch((err) => {
          console.error(`[pil-gate] critic ${role} threw: ${(err as Error).message}`);
          return null;
        }),
    ),
  );
  // Parse/throw failure is conservative: a null critic votes needs-user and keeps the producer brief.
  const verdicts: GateVerdict[] = settled.map((r) => r?.verdict ?? "needs-user");
  const verdict = mergeCriticVerdicts(args.draftVerdict, verdicts);
  // Prefer the shortest surviving stripped brief (most noise removed) among successful critics;
  // fall back to the producer brief when none parsed.
  const stripped = settled
    .filter((r): r is { verdict: GateVerdict; strippedBrief: string } => r !== null && r.strippedBrief.trim().length > 0)
    .map((r) => r.strippedBrief)
    .sort((a, b) => a.length - b.length)[0];
  return { verdict, brief: (stripped ?? args.draftBrief).slice(0, 1500) };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bunx vitest run src/gsd/__tests__/pil-gate-critic.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/gsd/pil-gate-critic.ts src/gsd/__tests__/pil-gate-critic.test.ts
git commit -m "feat(pil-gate): heavy-tier adversarial critics with downgrade-only merge"
```

---

### Task 5: Wire the gate into message-processor (deadline + prepend + fail-open)

**Files:**
- Modify: `src/orchestrator/message-processor.ts` — assessor runner (`:414-427`), gate block (`:661-706`)
- Test: `tests/harness/gsd-pil-gate.spec.ts` is Task 8; this task is covered by a focused unit around a small extracted helper.

**Interfaces:**
- Consumes: `buildGateContextBundle` (T2), `assessComplexity` w/ bundle + enrichedPrompt (T3), `runGateCritics` (T4), `isPilGateEnrichEnabled` (T2), `deps.buildRecentTurnsSummary()` (`orchestrator.ts:3298`), `pilCtx._brainData`.
- Produces: after the gate block, `pilCtx.enriched` is prepended with the brief when non-empty; `pilCtx.modelDepthTier` writeback + `syncWorkflowContext` always run.

- [ ] **Step 1: Add a gate deadline constant + a critic runner builder**

In `message-processor.ts`, near `buildLeaderAssessorRunner` (~L414). The council `generate` has no per-call timeout (`llm.ts:331`, 5-min default) — enforce the gate budget with an `AbortSignal.timeout` passed as the `signal` arg:

```ts
const PIL_GATE_DEADLINE_MS = 2500;

// Reuses the council LLM (billed source=council) with a tight per-call deadline.
function buildGateCriticRunner(deps: OrchestratorDeps, sessionModel: string): import("../gsd/pil-gate-critic.js").RunCriticFn {
  return async (prompt: string): Promise<string> => {
    const { createCouncilLLM } = await import("../council/llm.js");
    const { resolvePlanCouncilLeader } = await import("../council/leader.js");
    const leader = await resolvePlanCouncilLeader(sessionModel);
    const stats = { calls: 0, startMs: Date.now(), phases: [] };
    const llm = createCouncilLLM(deps.bash, deps.mode, deps.session?.id, stats);
    return llm.generate(leader.modelId, "You are a prompt-enrichment critic.", prompt, 512, undefined, AbortSignal.timeout(PIL_GATE_DEADLINE_MS));
  };
}
```

Also update `buildLeaderAssessorRunner` (~L423) to pass the deadline signal to its `llm.generate(...)` call (append `undefined, AbortSignal.timeout(PIL_GATE_DEADLINE_MS)` as the `onUsage`, `signal` args).

- [ ] **Step 2: Feed the bundle into the assessor call**

Replace the `assessComplexity({...})` argument object (~L675-683) so the context slots are populated:

```ts
const { buildGateContextBundle } = await import("../gsd/pil-gate-context.js");
const bundle = buildGateContextBundle({
  cwd,
  conversationDigest: deps.buildRecentTurnsSummary(),
  brainData: pilCtx._brainData,
});
const assessed = await assessComplexity({
  cwd,
  raw: pilCtx.raw,
  priorDepth: depth,
  confidence: pilCtx.confidence,
  bundle,
  sessionModelId: sessionModel,
  runAssessor: buildLeaderAssessorRunner(deps, sessionModel),
});
depth = assessed.depth;
pilCtx.modelDepthTier = depth;
if (assessed.assessed) pilCtx.gsdAutoCouncil = assessed.autoCouncil;
```

- [ ] **Step 3: Run critics on heavy, resolve the brief**

Immediately after the assessor result, still inside the inner try (so a throw is caught and depth writeback survives — see Step 5):

```ts
let brief = "";
if (isPilGateEnrichEnabled() && assessed.enrichedPrompt) {
  let verdict = assessed.quality?.verdict ?? "enriched";
  brief = assessed.enrichedPrompt;
  if (depth === "heavy") {
    const { runGateCritics } = await import("../gsd/pil-gate-critic.js");
    const critiqued = await runGateCritics({
      draftBrief: brief,
      draftVerdict: verdict,
      bundle,
      runCritic: buildGateCriticRunner(deps, sessionModel),
    });
    verdict = critiqued.verdict;
    brief = critiqued.brief;
  }
  if (verdict === "adequate") brief = "";
}
```

Standard tier: no critic call (producer self-critique already happened in the single producer call, per Task 3 rubric).

- [ ] **Step 4: Prepend the brief to pilCtx.enriched (never replace)**

The brief must be applied BEFORE `pilCtx.enriched` is first consumed at L717. Apply it right after the gate block, guarded:

```ts
if (brief) {
  pilCtx.enriched = `[PIL Gate brief]\n${brief.slice(0, 1500)}\n\n${pilCtx.enriched}`;
}
```

- [ ] **Step 5: Wrap the new enrichment code in its OWN try/catch**

The existing catch at L694 is the assessor-only inner catch; `syncWorkflowContext` is at L702. Ensure a throw in the critic/brief code cannot skip the depth writeback. Wrap Steps 2-4's producer+critic+brief logic in a dedicated try/catch whose catch sets `brief = ""` and logs, leaving `depth` at its last good value, and keep `ensureHost`/`syncWorkflowContext` (L701-702) OUTSIDE that try so they always run:

```ts
let brief = "";
try {
  // ... Steps 2 + 3 (assessor + critics) ...
} catch (gateErr) {
  brief = "";
  console.error(`[pil-gate] enrichment failed, using raw prompt: ${(gateErr as Error).message}`);
}
// Step 4 prepend (brief is "" on failure -> no-op)
if (brief) pilCtx.enriched = `[PIL Gate brief]\n${brief.slice(0, 1500)}\n\n${pilCtx.enriched}`;
getGsdLoopHost().ensureHost(cwd, sessionModel);   // L701 — always runs
syncWorkflowContext(cwd, sessionModel, depth);    // L702 — always runs
```

- [ ] **Step 6: Fix the stray comment**

While in this block, fix the malformed comment noted in REPO_DEEP_MAP §src/gsd item 1 (`message-processor.ts:667` has a stray `\` instead of `//`).

- [ ] **Step 7: Typecheck + boot smoke**

Run: `bunx tsc --noEmit` → 0 errors.
Run: `bun run src/index.ts --smoke-boot-only`
Expected: clean boot, no throw.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/message-processor.ts
git commit -m "feat(pil-gate): wire producer+critics at turn-start with deadline and prepend"
```

---

### Task 6: Drop the scoreSufficiency regex hint from the discovery path

**Files:**
- Modify: `src/pil/discovery.ts:306-309` (the `scoreSufficiency` call + `forceDirective` injection)
- Test: `src/pil/__tests__/scoreSufficiency.test.ts` (assert the function still exists for the `/ideal` caller) + a discovery proposer test

**Interfaces:**
- Consumes: nothing new.
- Produces: the discovery proposer prompt no longer includes the regex `forceDirective` hint. `scoreSufficiency` remains exported and used by `orchestrator.ts:2120` (`/ideal`) — do NOT delete it.

- [ ] **Step 1: Write the failing/guard test**

Add to a discovery test (or create `src/pil/__tests__/discovery-proposer.test.ts`) asserting the proposer prompt no longer contains the sufficiency directive text. Confirm the exact directive string first by reading `discovery.ts:306-309`, then assert its absence. Also keep a guard in `scoreSufficiency.test.ts`:

```ts
import { scoreSufficiency } from "../layer1-intent.js";
it("scoreSufficiency remains available for the /ideal caller", () => {
  expect(typeof scoreSufficiency).toBe("function");
});
```

- [ ] **Step 2: Remove the hint injection**

In `src/pil/discovery.ts` (~306-309) delete the `scoreSufficiency(raw)` call and the `forceDirective` block that concatenates its "local heuristic flags this prompt as underspecified" text into the proposer prompt. Leave the proposer to decide purely (it is already the sole ask-decider — `clarity-gate.ts:4-9`). Remove the now-unused import of `scoreSufficiency` from `discovery.ts` only.

- [ ] **Step 3: Run tests**

Run: `bunx vitest run src/pil/__tests__/scoreSufficiency.test.ts src/pil/__tests__/discovery.test.ts`
Expected: PASS (proposer path unaffected; `/ideal` caller intact). Then `bunx tsc --noEmit` → 0.

- [ ] **Step 4: Commit**

```bash
git add src/pil/discovery.ts src/pil/__tests__/
git commit -m "refactor(pil-gate): drop scoreSufficiency regex hint from discovery proposer"
```

---

### Task 7: Relax the chitchat guard so resumed heavy tasks still enrich

**Files:**
- Modify: `src/orchestrator/message-processor.ts:661` (the gate-block guard)
- Test: unit around a small extracted predicate `shouldRunGate(pilCtx, cwd)`

**Interfaces:**
- Consumes: `readState` (`src/gsd/workflow-engine.ts`).
- Produces: the gate runs when `isGsdNativeEnabled()` AND (`intentKind !== "chitchat"` OR an active GSD run exists for the cwd — `readState(cwd).phase === "execute"` or `pilCtx.resumeDigest`/`pilCtx.activeRunId` present). Pure chitchat with no active run still skips.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/__tests__/should-run-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldRunGate } from "../should-run-gate.js";

describe("shouldRunGate", () => {
  it("runs on non-chitchat", () => {
    expect(shouldRunGate({ intentKind: "code" } as any, () => "plan")).toBe(true);
  });
  it("skips pure chitchat with no active run", () => {
    expect(shouldRunGate({ intentKind: "chitchat" } as any, () => "discover")).toBe(false);
  });
  it("runs chitchat-classified turn when a run is in execute phase (resumed heavy)", () => {
    expect(shouldRunGate({ intentKind: "chitchat" } as any, () => "execute")).toBe(true);
  });
  it("runs chitchat-classified turn when a resume digest is present", () => {
    expect(shouldRunGate({ intentKind: "chitchat", resumeDigest: "..." } as any, () => "discover")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `bunx vitest run src/orchestrator/__tests__/should-run-gate.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the predicate**

Create `src/orchestrator/should-run-gate.ts`:

```ts
// Keep the gate off pure chitchat, but ON for a resumed heavy task the classifier
// mislabels as chitchat (continuation phrases — preprocessor.ts:118-134). Reading
// STATE.md phase is the resume signal (execute phase = an active run).
export function shouldRunGate(
  pilCtx: { intentKind?: string | null; resumeDigest?: string | null; activeRunId?: string | null },
  readPhase: () => string | null,
): boolean {
  if (pilCtx.intentKind !== "chitchat") return true;
  if (pilCtx.resumeDigest || pilCtx.activeRunId) return true;
  try {
    return readPhase() === "execute";
  } catch {
    // No planning state / corrupt dir — treat as no active run; pure chitchat skips.
    return false;
  }
}
```
(The bare `catch` is acceptable here per the No-Silent-Catch rule's documented-cleanup exception: a missing `.planning/` is the normal no-run case, not an error; add the comment shown.)

- [ ] **Step 4: Use it at the guard**

In `message-processor.ts:661`, replace the guard condition with:

```ts
if (isGsdNativeEnabled() && shouldRunGate(pilCtx, () => { try { return readState(cwd).phase; } catch { return null; } })) {
```
(Import `shouldRunGate` and ensure `readState`/`cwd` are in scope — `cwd` is computed at L663; move the `const cwd = deps.bash.getCwd();` above the guard if needed.)

- [ ] **Step 5: Run tests + typecheck + boot smoke**

Run: `bunx vitest run src/orchestrator/__tests__/should-run-gate.test.ts`
Expected: PASS. Then `bunx tsc --noEmit` → 0, and `bun run src/index.ts --smoke-boot-only` clean.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/should-run-gate.ts src/orchestrator/message-processor.ts src/orchestrator/__tests__/should-run-gate.test.ts
git commit -m "feat(pil-gate): run gate on resumed heavy tasks misclassified as chitchat"
```

---

### Task 8: Deterministic harness E2E for the gate

**Files:**
- Create: `tests/harness/gsd-pil-gate.spec.ts`
- Reference pattern: `tests/harness/gsd-hard-gate.spec.ts` (mock council fixture, forced depth, deterministic)

**Interfaces:**
- Consumes: the whole gate (Tasks 1-7). Drives the real CLI via the harness with a mock council fixture that matches the assessor + critic prompts.

- [ ] **Step 1: Write the spec (four cases)**

Create `tests/harness/gsd-pil-gate.spec.ts` following `gsd-hard-gate.spec.ts`'s `spawnHarness` + mock-council-fixture pattern. Env for determinism: `MUONROI_GSD_NATIVE=1`, `MUONROI_GSD_ASSESSOR=1`, `MUONROI_PIL_GATE_ENRICH=1`, `MUONROI_LLM_FIRST_CLASSIFY=0`, `MUONROI_PIL_DISCOVERY=0`, spawn in a fresh greenfield temp cwd. The mock `responses` array matches:
- `{ match: "You are the complexity assessor", text: <complexity-verdict JSON with depth:heavy, quality.verdict:enriched, enrichedPrompt containing "confirm via grep before anchoring"> }`
- `{ match: "You are a prompt-enrichment critic", text: <gate-critic JSON keeping enriched, strippedBrief> }`

Cases:
1. **Vague heavy prompt → brief prepended, existing enrichment preserved:** assert the downstream model message (or `pilCtx.enriched` via a harness snapshot event) begins with `[PIL Gate brief]` and contains `confirm via grep`, AND still contains the original prompt text after it.
2. **Crisp/adequate prompt → raw passthrough:** mock assessor returns `quality.verdict:"adequate"`, `enrichedPrompt:""` → assert no `[PIL Gate brief]` prefix.
3. **quick + high-confidence → gate skipped:** seed a quick classification (or force via fixture) → assert zero `source=council` gate calls fired (assert on a usage/event probe or the absence of the assessor prompt in the mock call log).
4. **Standard turn → no critic call:** assert the mock `"You are a prompt-enrichment critic"` fixture is never hit on a standard-depth turn (producer self-critique only).

- [ ] **Step 2: Run the spec on Windows (named pipe)**

Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/gsd-pil-gate.spec.ts`
Expected: PASS, 4/4, deterministic across 2 runs.

- [ ] **Step 3: Full pre-push gate**

Run: `bunx vitest run` → 0 failures.
Run: `bunx vitest -c vitest.harness.config.ts run tests/harness/` → 0 failures.

- [ ] **Step 4: Commit**

```bash
git add tests/harness/gsd-pil-gate.spec.ts
git commit -m "test(pil-gate): deterministic harness E2E for enrich/adequate/skip/standard"
```

---

## Self-Review

**Spec coverage:**
- Depth from full context (digest+EE+plan) → Tasks 2,3,5. ✓
- Bounded enrichment, no asserted file targets, hedged hints → Task 1 contract + Task 3 producer + Task 4 grounding critic. ✓
- Standard = producer self-critique (+0 calls); critics heavy-only via Promise.all → Task 3 (rubric in producer) + Task 4 + Task 5 Step 3. ✓
- ~2500ms gate deadline (AbortSignal, since no per-call council timeout) → Task 5 Step 1. ✓
- Brief prepends, never replaces → Task 5 Step 4 + Global Constraints. ✓
- Own try/catch so depth writeback always runs → Task 5 Step 5. ✓
- needs-user advisory-only (no mutation-gate enforcement) → represented as a verdict + `OPEN QUESTIONS:` in the brief (Task 1 contract); no mutation-gate wiring, per spec. ✓
- Drop scoreSufficiency from discovery caller only → Task 6. ✓
- Chitchat/resume coupling → Task 7. ✓
- Flag `MUONROI_PIL_GATE_ENRICH` + coupling to GSD_NATIVE → Task 2. ✓
- E2E → Task 8. ✓

**Placeholder scan:** no TBD/TODO; every code step carries concrete code; test bodies are complete. Task 6 Step 1 requires the implementer to read the exact directive string before asserting its absence (a read, not a placeholder).

**Type consistency:** `GateVerdict` = `"adequate"|"enriched"|"needs-user"` used consistently across Tasks 1/3/4/5; `GateContextBundle` shape identical in Tasks 2/3/4; `enrichedPrompt: string` (default `""`) consistent in Tasks 1/3/5; `quality` optional everywhere.

**Known deferrals (from spec, not gaps):** projectHints is `""` in v1 (mislead risk); needs-user has no mutation-gate enforcement in v1; `/ideal` scoreSufficiency caller untouched.
