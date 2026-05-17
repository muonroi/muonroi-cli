# Leader Debug Instrumentation (Layer A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `MUONROI_DEBUG_LEADER` envvar-gated diagnostic logging to `leaderRecommend` and `councilRecommend` so raw leader responses are visible on both failure AND success paths without changing any behavior in normal (unset-envvar) runs.

**Architecture:** Instrument the two call sites in `discovery-recommender.ts` that invoke `parseLeaderResponse` — the `leaderRecommend` loop (lines 50–76) and the `councilRecommend` synth-tiebreak loop (lines 193–210). When `MUONROI_DEBUG_LEADER === "1"`, emit a single JSON line to `process.stderr` prefixed `[leader-debug]` on each attempt. Zero runtime cost otherwise. A unit test in the existing `__tests__/discovery-recommender.test.ts` file covers the failure path (markdown-fenced response + truncated JSON) and asserts the debug line appears in captured stderr.

**Tech Stack:** TypeScript, Vitest, Node.js `process.stderr`, `process.env`

---

### Task 1: Add debug helper inside `discovery-recommender.ts`

**Files:**
- Modify: `src/product-loop/discovery-recommender.ts:29-45` (after `stripFences`, before `parseLeaderResponse`)

- [ ] **Step 1: Read the current file to anchor line numbers**

Open `src/product-loop/discovery-recommender.ts`. Confirm `stripFences` ends around line 34 and `parseLeaderResponse` starts around line 36. (Already done — do not re-read, just use the snapshot.)

- [ ] **Step 2: Add the `emitLeaderDebug` helper immediately above `parseLeaderResponse`**

Insert this block between `stripFences` (ends at line 34) and `parseLeaderResponse` (starts at line 36):

```typescript
// ---------------------------------------------------------------------------
// Diagnostic: MUONROI_DEBUG_LEADER=1 → emit JSON line to stderr on each attempt
// Zero cost when envvar is unset.
// ---------------------------------------------------------------------------
interface LeaderDebugPayload {
  attempt: number;
  model: string;
  system: string;       // truncated to 500 chars
  prompt: string;       // truncated to 500 chars
  rawResponse: string;  // full
  outcome: "parse_ok" | "parse_fail";
  parseError?: string;
}

function emitLeaderDebug(payload: LeaderDebugPayload): void {
  if (process.env.MUONROI_DEBUG_LEADER !== "1") return;
  process.stderr.write("[leader-debug] " + JSON.stringify(payload) + "\n");
}
```

The final diff for this step touches only the region between `stripFences` and `parseLeaderResponse`. No other lines move.

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
cd D:\sources\Core\muonroi-cli
bunx tsc --noEmit
```

Expected: 0 errors. If errors appear, they are unrelated to this change (pre-existing baseline).

- [ ] **Step 4: Commit**

```powershell
git add src/product-loop/discovery-recommender.ts
git commit -m "feat(debug): add emitLeaderDebug helper behind MUONROI_DEBUG_LEADER gate"
```

---

### Task 2: Instrument `leaderRecommend` — failure and success paths

**Files:**
- Modify: `src/product-loop/discovery-recommender.ts` — `leaderRecommend` function body (lines 47–76)

The `leaderRecommend` function calls `leader.generate(...)` then `parseLeaderResponse(res.content)`. We instrument at both parse outcomes. We also need the `model` — expose it from the `leader` parameter.

- [ ] **Step 1: Check if `LeaderLike` carries a `modelId` field**

Open `src/product-loop/discovery-prompt-parser.ts` and search for `LeaderLike`:

```powershell
Select-String -Path "src\product-loop\discovery-prompt-parser.ts" -Pattern "LeaderLike"
```

Note whether `modelId` is already a field. If it is not, we use `"unknown"` as the model string (do NOT add a field — that is Agent 2 scope).

- [ ] **Step 2: Instrument `leaderRecommend`**

Replace the `for` loop body in `leaderRecommend` (lines 50–68) so it becomes:

```typescript
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await leader.generate({ system: LEADER_SYSTEM, prompt, maxTokens: 4096 });
      cost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        emitLeaderDebug({
          attempt,
          model: (leader as any).modelId ?? "unknown",
          system: LEADER_SYSTEM.slice(0, 500),
          prompt: prompt.slice(0, 500),
          rawResponse: res.content,
          outcome: "parse_ok",
        });
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "leader",
          costUsd: cost,
        };
      }
      emitLeaderDebug({
        attempt,
        model: (leader as any).modelId ?? "unknown",
        system: LEADER_SYSTEM.slice(0, 500),
        prompt: prompt.slice(0, 500),
        rawResponse: res.content,
        outcome: "parse_fail",
        parseError: "parseLeaderResponse returned null",
      });
    } catch (err) {
      emitLeaderDebug({
        attempt,
        model: (leader as any).modelId ?? "unknown",
        system: LEADER_SYSTEM.slice(0, 500),
        prompt: prompt.slice(0, 500),
        rawResponse: "",
        outcome: "parse_fail",
        parseError: err instanceof Error ? err.message : String(err),
      });
      /* retry */
    }
  }
```

Important: the `catch` block previously had only `/* retry */`. We now call `emitLeaderDebug` before the comment. The `return` statement below the loop (lines 70–75, `user-only` fallback) is **unchanged**.

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
bunx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```powershell
git add src/product-loop/discovery-recommender.ts
git commit -m "feat(debug): instrument leaderRecommend failure+success paths with MUONROI_DEBUG_LEADER"
```

---

### Task 3: Instrument `councilRecommend` synth-tiebreak loop

**Files:**
- Modify: `src/product-loop/discovery-recommender.ts` — `councilRecommend` function, synth-tiebreak `for` loop (lines 193–210)

This loop is structurally identical to `leaderRecommend` but uses `SYNTH_SYSTEM` as the system prompt and `synthPrompt` as the user prompt.

- [ ] **Step 1: Instrument the synth-tiebreak `for` loop**

Replace the synth-tiebreak loop body (currently lines 193–210):

```typescript
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await leader.generate({ system: SYNTH_SYSTEM, prompt: synthPrompt, maxTokens: 4096 });
      synthCost += res.costUsd;
      const parsed = parseLeaderResponse(res.content);
      if (parsed) {
        emitLeaderDebug({
          attempt,
          model: (leader as any).modelId ?? "unknown",
          system: SYNTH_SYSTEM.slice(0, 500),
          prompt: synthPrompt.slice(0, 500),
          rawResponse: res.content,
          outcome: "parse_ok",
        });
        return {
          primary: parsed.primary,
          alternatives: parsed.alternatives,
          source: "council",
          costUsd: chunks.costUsd + synthCost,
          tiebreakUsed: true,
        };
      }
      emitLeaderDebug({
        attempt,
        model: (leader as any).modelId ?? "unknown",
        system: SYNTH_SYSTEM.slice(0, 500),
        prompt: synthPrompt.slice(0, 500),
        rawResponse: res.content,
        outcome: "parse_fail",
        parseError: "parseLeaderResponse returned null",
      });
    } catch (err) {
      emitLeaderDebug({
        attempt,
        model: (leader as any).modelId ?? "unknown",
        system: SYNTH_SYSTEM.slice(0, 500),
        prompt: synthPrompt.slice(0, 500),
        rawResponse: "",
        outcome: "parse_fail",
        parseError: err instanceof Error ? err.message : String(err),
      });
      /* retry */
    }
  }
```

The confidence-fallback block after this loop (lines 212–222) is **unchanged**.

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
bunx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add src/product-loop/discovery-recommender.ts
git commit -m "feat(debug): instrument councilRecommend synth-tiebreak loop with MUONROI_DEBUG_LEADER"
```

---

### Task 4: Unit test — `[leader-debug]` lines appear on failure path

**Files:**
- Modify: `src/product-loop/__tests__/discovery-recommender.test.ts` — add new `describe` block at the bottom

The test must:
1. Set `process.env.MUONROI_DEBUG_LEADER = "1"` in `beforeEach` and restore it in `afterEach`.
2. Spy on `process.stderr.write` to capture output (Vitest `vi.spyOn`).
3. Feed a leader that returns markdown-fenced JSON on attempt 0 and truncated JSON on attempt 1.
4. Assert two `[leader-debug]` lines appear, both with `outcome: "parse_fail"`.
5. Feed a leader that returns valid JSON and assert one line with `outcome: "parse_ok"`.

- [ ] **Step 1: Write the failing test block**

Append the following describe block to the bottom of `src/product-loop/__tests__/discovery-recommender.test.ts`:

```typescript
describe("discovery-recommender — MUONROI_DEBUG_LEADER instrumentation", () => {
  const baseInput = {
    question: { id: "productType", required: true, recommendMode: "leader", prompt: "What type?" } as any,
    context: {},
    detection: {
      isGitRepo: false,
      hasCommitHistory: false,
      srcFileCount: 0,
      manifests: [],
      languages: [],
      frameworks: [],
      classification: "greenfield",
    } as any,
  };

  let stderrLines: string[] = [];
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalDebug: string | undefined;

  beforeEach(() => {
    originalDebug = process.env.MUONROI_DEBUG_LEADER;
    process.env.MUONROI_DEBUG_LEADER = "1";
    stderrLines = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrLines.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalDebug === undefined) {
      delete process.env.MUONROI_DEBUG_LEADER;
    } else {
      process.env.MUONROI_DEBUG_LEADER = originalDebug;
    }
  });

  it("emits two [leader-debug] parse_fail lines when leader returns invalid responses twice", async () => {
    // attempt 0: markdown-fenced JSON (valid JSON but wrapped → stripFences handles it; however
    // we want a case where parsing still fails — use truncated JSON that stripFences can't repair)
    const markdownFenced = "```json\n{\"primary\":{\"value\":\"saas\""; // truncated — no closing braces
    const truncated = "{\"primary\":{\"rationale\":\"x\"}}"; // missing `value` field → parseLeaderResponse returns null

    const leader = makeLeader([markdownFenced, truncated]);
    const rec = await leaderRecommend(baseInput, leader as any);

    expect(rec.source).toBe("user-only");

    const debugLines = stderrLines.filter((l) => l.startsWith("[leader-debug] "));
    expect(debugLines).toHaveLength(2);

    const parsed0 = JSON.parse(debugLines[0]!.replace("[leader-debug] ", "").trim());
    expect(parsed0.attempt).toBe(0);
    expect(parsed0.outcome).toBe("parse_fail");
    expect(parsed0.rawResponse).toBe(markdownFenced);
    expect(parsed0).toHaveProperty("model");
    expect(parsed0).toHaveProperty("system");
    expect(parsed0).toHaveProperty("prompt");
    expect(typeof parsed0.system).toBe("string");
    expect(parsed0.system.length).toBeLessThanOrEqual(500);
    expect(parsed0.prompt.length).toBeLessThanOrEqual(500);

    const parsed1 = JSON.parse(debugLines[1]!.replace("[leader-debug] ", "").trim());
    expect(parsed1.attempt).toBe(1);
    expect(parsed1.outcome).toBe("parse_fail");
    expect(parsed1.rawResponse).toBe(truncated);
  });

  it("emits one [leader-debug] parse_ok line when leader returns valid JSON", async () => {
    const validResponse = JSON.stringify({
      primary: { value: "saas", rationale: "good fit" },
      alternatives: [{ value: "b2b", rationale: "alt" }],
    });
    const leader = makeLeader([validResponse]);
    const rec = await leaderRecommend(baseInput, leader as any);

    expect(rec.source).toBe("leader");
    expect(rec.primary.value).toBe("saas");

    const debugLines = stderrLines.filter((l) => l.startsWith("[leader-debug] "));
    expect(debugLines).toHaveLength(1);

    const parsed = JSON.parse(debugLines[0]!.replace("[leader-debug] ", "").trim());
    expect(parsed.attempt).toBe(0);
    expect(parsed.outcome).toBe("parse_ok");
    expect(parsed.rawResponse).toBe(validResponse);
  });

  it("does NOT emit [leader-debug] lines when MUONROI_DEBUG_LEADER is unset", async () => {
    delete process.env.MUONROI_DEBUG_LEADER;
    const leader = makeLeader(["bad", "bad"]);
    await leaderRecommend(baseInput, leader as any);

    const debugLines = stderrLines.filter((l) => l.startsWith("[leader-debug] "));
    expect(debugLines).toHaveLength(0);
  });
});
```

Note: `makeLeader` is already defined at the top of the file — do NOT redefine it.

- [ ] **Step 2: Run the new tests to confirm they fail before implementation**

```powershell
bunx vitest run src/product-loop/__tests__/discovery-recommender.test.ts --reporter=verbose 2>&1 | Select-String "MUONROI_DEBUG_LEADER|FAIL|PASS|Error"
```

Expected: the three new tests FAIL (the instrumentation doesn't exist yet). Existing tests PASS.

- [ ] **Step 3: Run tests after Tasks 1–3 are complete to confirm they pass**

```powershell
bunx vitest run src/product-loop/__tests__/discovery-recommender.test.ts --reporter=verbose
```

Expected: ALL tests PASS (5 existing + 3 new = at least 8 total in this file).

- [ ] **Step 4: Run the full product-loop suite to confirm no regressions**

```powershell
bunx vitest run src/product-loop/ 2>&1 | tail -20
```

Expected: same pass count as before this change (no new failures).

- [ ] **Step 5: Commit**

```powershell
git add src/product-loop/__tests__/discovery-recommender.test.ts
git commit -m "test(debug): assert MUONROI_DEBUG_LEADER emits [leader-debug] stderr lines on fail + success"
```

---

### Task 5: Smoke verification — no noise in normal mode

**Files:**
- No file changes — verification only

- [ ] **Step 1: Confirm `--smoke-boot-only` exits 0 with no `[leader-debug]` output**

```powershell
$env:MUONROI_DEBUG_LEADER = $null   # ensure unset
bun run src/index.ts --smoke-boot-only 2>&1
```

Expected: exits 0, no `[leader-debug]` lines in output.

- [ ] **Step 2: Confirm TypeScript is clean**

```powershell
bunx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Final commit — conventional message**

If there are uncommitted changes after all tasks:

```powershell
git add src/product-loop/discovery-recommender.ts src/product-loop/__tests__/discovery-recommender.test.ts
git commit -m "feat(debug): MUONROI_DEBUG_LEADER gate for leader parse diagnostics (Layer A)"
```

---

## Envvar Contract

| Envvar | Value to enable | Default |
|---|---|---|
| `MUONROI_DEBUG_LEADER` | `"1"` | unset (no output) |

**Sample stderr line (failure):**
```
[leader-debug] {"attempt":0,"model":"unknown","system":"You are a product context recommender...","prompt":"Question: What type?\nField id: productType\n...","rawResponse":"```json\n{\"primary\":{\"value\":\"saas\"","outcome":"parse_fail","parseError":"parseLeaderResponse returned null"}
```

**Sample stderr line (success):**
```
[leader-debug] {"attempt":0,"model":"unknown","system":"You are a product context recommender...","prompt":"Question: What type?\nField id: productType\n...","rawResponse":"{\"primary\":{\"value\":\"saas\",\"rationale\":\"good fit\"},\"alternatives\":[{\"value\":\"b2b\",\"rationale\":\"alt\"}]}","outcome":"parse_ok"}
```

---

## Self-Review

**Spec coverage:**
- [x] `MUONROI_DEBUG_LEADER=1` gate — `emitLeaderDebug` helper in Task 1
- [x] Dump on BOTH attempts in `leaderRecommend` failure — Task 2
- [x] Dump on BOTH attempts in `councilRecommend` synth-tiebreak — Task 3
- [x] Dump on SUCCESS path — Task 2 (`parse_ok` branch)
- [x] Fields: `attempt`, `model`, `system` (≤500), `prompt` (≤500), `rawResponse` (full), `parseError` — Task 1 interface + Task 2/3 call sites
- [x] Unit test: markdown-fenced (truncated) + missing `value` field → two parse_fail lines — Task 4
- [x] Unit test: valid JSON → one parse_ok line — Task 4
- [x] Unit test: envvar unset → zero debug lines — Task 4
- [x] Zero behavior change when envvar unset — `emitLeaderDebug` returns early first line
- [x] DO NOT touch `discovery-interview.ts`, `gather.ts`, retry counter — not in any task
- [x] DO NOT modify `parseLeaderResponse` itself — only callers instrumented

**Placeholder scan:** No TBDs, no "implement later", no missing code in any step.

**Type consistency:** `LeaderDebugPayload` defined once in Task 1, used identically in Tasks 2 and 3. `outcome` discriminant is `"parse_ok" | "parse_fail"` throughout.
