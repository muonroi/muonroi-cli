# Plan — GSD plan-council: model-first verdict (kill regex/freetext sniffing)

> Status: ready to implement · 2026-07-02 · Branch: develop
> Supersedes the verdict-extraction approach from `2026-07-02-gsd-native-hardening.md`.

## Problem (evidence)

`src/gsd/plan-council.ts:191-195` decides the council verdict on the production
**debate path** by regex-sniffing English phrases in free-text synthesis:

```ts
if (/revision\s+required|should\s+revise|must\s+revise/i.test(synthesis)) verdict = "revise";
else if (/block/i.test(synthesis)) verdict = "block";
```

Failure modes (real, not hypothetical):

1. `synthesis = "We should **not** block on this; no revision required."`
   → matches both `block` and `revision required` → false revise/block.
2. `synthesis = "The plan is unblock-ready."` → matches `block` → false block.
3. Synthesis in Vietnamese / mixed-language → regex misses entirely → defaults to `pass`
   (silently wrong — the council wanted revision but the gate opens).

The perspective path already JSON-parses (`plan-council.ts:96-111`) but has no
tolerant extractor (one stray line before the `{` → throws → falls back to heuristic).

The user directive (this session): **model-first, never regex/freetext on verdict.**

## Goal

The verdict decision is owned by the model and emitted as **structured JSON**.
Our code only parses + validates. When parse fails we degrade conservatively
(force `revise` so the loop iterates) and surface a telemetry flag — we never
guess the verdict from prose.

Non-goals: changing `runCouncilV2` internals, changing `runDebate` signature
(ripples into the council subsystem whose tests sniff prompt substrings — see
memory `project_council_subsystem`).

## Design

### Shared verdict protocol — new `src/gsd/verdict-schema.ts`

```ts
export const PlanCouncilVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "block"]),
  concerns: z.array(z.string()).catch([]),
  evidence: z.array(z.string()).catch([]).default([]),
  rationale: z.string().catch("").optional(),
});
export type PlanCouncilVerdict = z.infer<typeof PlanCouncilVerdictSchema>;
```

`extractStructuredVerdict(raw: string): PlanCouncilVerdict | null`:

1. Scan fenced blocks (```` ```council-verdict ```` preferred, then ```` ```json ````, then bare ``` ``` ```). Take the LAST one whose content parses + zod-validates. (Model emits reasoning then a final verdict block — last wins.)
2. Else scan top-level `{...}` brace-balanced substrings right-to-left, try each.
3. Else return `null` — caller decides conservative fallback.

Zod `.catch([])` on `concerns`/`evidence` means a verdict with a missing array
still validates as long as `verdict` itself is the enum. Verdict is the only
hard field.

### Output contract appended to prompts

Both the debate topic (debate path) and perspective prompt get a suffix:

```
Emit your final decision as a fenced block in EXACTLY this shape (no prose inside the fence):

​​```council-verdict
{"verdict":"approve|revise|block","concerns":["..."],"evidence":["..."],"rationule":"..."}
​​```
```

The fenced label makes extraction deterministic and lets the model emit earlier
JSON (e.g. quoting plan acceptance criteria) without colliding.

### Debate path (`plan-council.ts` runDebate branch)

- Build topic = context bundle + plan + output contract.
- `synthesis = await runDebate(topic)`.
- `parsed = extractStructuredVerdict(synthesis)`.
- If `parsed` → verdict = `parsed.verdict`, concerns/evidence from parsed.
- If `null` → verdict = `"revise"` + `verdictParseFailed: true` (forces another cycle; leader gets a second chance; never silently passes).
- PLAN-REVIEW.md body: synthesis (truncated) + parsed concerns/evidence section.
- PLAN-VERIFY.md records `verdictSource: structured | parse-failed` for forensics.

### Perspective path (`plan-council.ts` perspective branch)

- Append same output contract.
- Parallelize: `Promise.all(perspectives.map(p => runPerspective(...)))` — they are independent. Preserve declared order in results via index map.
- `runPerspective` uses `extractStructuredVerdict` (tolerant of bare JSON too). If null → heuristic fallback + `parseFailed: true` on that result + console.error (no silent catch).

### Telemetry

`PlanCouncilResult` gains:
- `verdictSource?: "structured" | "heuristic-fallback" | "parse-failed"`
- `verdictParseFailed?: boolean`

`loop-host.ts` plan:post overlay surfaces both in `logGsdNativeEvent`.

## Tasks

1. **`src/gsd/verdict-schema.ts`** — schema + `extractStructuredVerdict` + helpers.
2. **`src/gsd/plan-council-prompts.ts`** — append output contract to `buildPerspectivePrompt`; export `buildDebateTopic(planBody, bundle)` with contract suffix (move topic assembly out of plan-council.ts for reuse + testability).
3. **`src/gsd/plan-council.ts`** — both paths use `extractStructuredVerdict`; parallelize perspectives; add `verdictSource`/`verdictParseFailed` to result; conservative revise on parse-fail; remove the two regex checks.
4. **`src/gsd/loop-host.ts`** — surface `councilVerdictSource` + `councilVerdictParseFailed` in plan:post telemetry.
5. **`src/gsd/__tests__/verdict-schema.test.ts`** — golden cases: fenced council-verdict, fenced json, bare json, multi-block (last wins), quoted-plan-no-collision, missing verdict field → null, malformed → null.
6. **`src/gsd/__tests__/plan-council.test.ts`** — add: debate path returns parsed verdict; debate path parse-fail → conservative revise + flag; perspective path tolerant parse; perspective parallel order preserved.
7. **`tests/harness/fixtures/llm/gsd-native-lifecycle/*.json`** — multi-round mock fixture emitting `gsd_plan` → `gsd_plan_review` → `gsd_execute` → `gsd_verify` tool-calls, each followed by a text-only final round.
8. **`tests/harness/gsd-native-lifecycle.spec.ts`** — spawn greenfield, drive the 4-tool lifecycle via the fixture, assert STATE phase advance plan→execute→review + PLAN-VERIFY.md verdict.

## Acceptance

- `grep -n "revision\s*required|should\s+revise|must\s+revise" src/gsd/plan-council.ts` → no match.
- `extractStructuredVerdict` covered by ≥6 golden cases including adversarial ("do not block" prose, no JSON).
- All 3 debate-path outcomes (approve / revise via parsed / revise via parse-fail) unit-tested.
- Perspectives run in parallel — verify via timing (serial 4 × 200ms ⇒ ~800ms; parallel ⇒ ~200ms) in a test with a stubbed `runPerspectiveFn` that sleeps.
- `bunx vitest run src/gsd` green (0 fail).
- `bunx vitest -c vitest.harness.config.ts run tests/harness/gsd-native-lifecycle.spec.ts` green.
- `bunx tsc --noEmit` 0 errors.

## Risk register

| Risk | Mitigation |
|---|---|
| Leader ignores contract, emits prose-only | parse-fail → conservative revise (forces retry); 2nd cycle prompts with prior-concern directive that re-states the contract |
| zod v4 ESM under vitest | schema lives in same module graph that already works post-`optimizeDeps.include:["zod"]` fix |
| Parallel perspectives change log order | preserve declared-order results via index map; telemetry counts unchanged |
| Mock-fixture tool-call sequences brittle | one round per tool-call + final text-only round; reuse `toolCallStream` helper already in mock-model.ts |
| `runCouncilV2` synthesis shape drifts | extraction is shape-agnostic (fence scan + brace scan); only depends on the model honoring the contract, not on synthesis structure |
