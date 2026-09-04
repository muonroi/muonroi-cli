/**
 * tests/harness/gsd-pil-gate.spec.ts
 *
 * Task 8 (final task) of the PIL Prompt Gate plan — deterministic harness E2E
 * for the gate wired in src/orchestrator/message-processor.ts:706-789.
 *
 * The gate reuses the SAME leader-tier complexity assessor as the GSD hard
 * mutation gate (see gsd-hard-gate.spec.ts's header comment for the full
 * rationale on why the assessor is the only deterministic way to reach a
 * non-"standard" depth in this mock harness). Task 8 extends that pattern to
 * assert on the ENRICHMENT side of the assessor's verdict:
 *
 *   - assessComplexity() (src/gsd/complexity-assessor.ts) now also returns
 *     `quality: {verdict, missing, noiseRisk}` + `enrichedPrompt`.
 *   - When depth === "heavy" AND MUONROI_PIL_GATE_ENRICH is on, 3 critics run
 *     (src/gsd/pil-gate-critic.ts) via the SAME createCouncilLLM.generate ->
 *     mock.complete({prompt}) mechanism as the assessor — NOT the doStream/
 *     doGenerate `model` fixture. mock.complete matches on the literal
 *     `prompt` argument (see packages/agent-harness-core/src/mock-llm.ts:114),
 *     which for critics is built by buildCriticPrompt() and begins
 *     "You are the ${role} critic for a prompt-enrichment gate." — the
 *     common, role-independent substring "critic for a prompt-enrichment
 *     gate" is what a fixture must `match` against (NOT the literal system
 *     string "You are a prompt-enrichment critic." passed as `llm.generate`'s
 *     2nd arg — that string is never seen by mock.complete, which only
 *     receives `{prompt}`, confirmed by reading council/llm.ts:356-360 and
 *     message-processor.ts:462-469).
 *   - When the resolved verdict !== "adequate", message-processor.ts:781-783
 *     prepends `[PIL Gate brief]\n<brief, sliced to 1500 chars>\n\n` to
 *     `pilCtx.enriched`. That text (plus a `[Raw user input]\n<raw>` suffix
 *     appended at line 1066-1067 whenever raw !== enriched) becomes the user
 *     message content of the FIRST main-agent doStream call — dumped via
 *     MUONROI_MOCK_MODEL_DUMP and inspected with loadDumpedRecordings, exactly
 *     as gsd-hard-gate.spec.ts inspects tool-call feedback. There is no
 *     gate-specific LiveEvent kind (checked packages/agent-harness-core/src/
 *     protocol.ts's full LiveEvent union) — the dump-and-inspect pattern is
 *     the only harness-observable signal for this feature.
 *
 * Cases shipped as real, deterministic tests:
 *   1. Vague heavy prompt -> assessor verdict "enriched" + critics (heavy)
 *      agree "enriched" -> brief prepended, contains "confirm via grep", and
 *      the original raw prompt still appears after it (via the `[Raw user
 *      input]` suffix line 1066-1067 — no separate assertion needed for that
 *      half, it is a structural guarantee of the code path, verified here by
 *      checking the raw prompt text's index is greater than the brief's).
 *   2. Crisp/adequate prompt -> assessor returns quality.verdict:"adequate",
 *      enrichedPrompt:"" -> the enrichment `if` (message-processor.ts:759)
 *      short-circuits entirely (empty string is falsy) -> no critics call,
 *      no "[PIL Gate brief]" prefix.
 *   4. Standard-depth prompt -> assessor returns depth:"standard" with a
 *      non-empty enrichedPrompt containing a unique marker string; critics
 *      are gated by `if (depth === "heavy")` (message-processor.ts:762) so
 *      they must NOT run. Proven by giving the critic fixture a DIFFERENT,
 *      distinguishable marker string ("CRITIC-WAS-CALLED-MARKER") and
 *      asserting it never reaches the final user message — if critics had
 *      run, `runGateCritics` would have replaced the brief with the (mocked)
 *      critic's `strippedBrief`, so its absence is a real, sensitive negative
 *      signal, not just "we didn't call it directly".
 *
 *   3. quick + high-confidence -> the assessor pre-filter skips and NO assessor
 *      call fires (assessComplexity's shouldAssess(), complexity-assessor.ts:53).
 *
 *      This case previously shipped as an `it.todo` whose stated blocker was
 *      that `pilCtx.modelDepthTier` — the source of a "quick" `priorDepth`
 *      (message-processor.ts:735) — comes only from the model-first classify
 *      path, which "every harness spec keeps OFF via MUONROI_LLM_FIRST_CLASSIFY=0".
 *      Both halves of that premise are stale, verified by reading the code:
 *        - `isLlmFirstClassifyEnabled()` (src/pil/config.ts:36) is referenced by
 *          NOTHING in src/ except its own unit test, so `MUONROI_LLM_FIRST_CLASSIFY=0`
 *          is a NO-OP; layer1-intent.ts:652 gates model-first classify solely on
 *          `opts.llmFallback`, which preprocessor.ts:71 always wires.
 *        - The classify call needs no new mock surface: the mock already
 *          intercepts it by system prompt (mock-model.ts CLASSIFY_SIGNATURE +
 *          `autoClassify`, on by default for file fixtures) and answers with the
 *          fixture's `classify` line WITHOUT consuming a stream round. Omitting
 *          that field is what yields DEFAULT_CLASSIFY_LINE ("…,standard,…") —
 *          the REAL reason every gsd spec sees depth "standard". Setting its
 *          fifth word to "quick" (classifyDepthWord) reaches this case.
 *      Confidence is a constant 0.75 (llm-classify.ts:464), above the 0.7
 *      CONFIDENCE_FLOOR, and a first turn has no conversation digest so the 0.85
 *      continuation floor does not apply.
 *
 *      Observed with a deliberately LOUD assessor fixture (depth heavy +
 *      "ASSESSOR-WAS-CALLED-MARKER"): if the call fired, ASSESSMENT.md would
 *      exist, STATE.md Depth would read heavy, and the marker would be in the
 *      user message. All three are asserted absent, so the fixture is its own
 *      negative control. Falsifiability CONFIRMED by flipping classifyDepthWord
 *      to "standard": the ASSESSMENT.md assertion fails (assessor ran).
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers.js";
import { loadDumpedRecordings } from "./recording.js";

interface GateHarness {
  proc: ChildProcess;
  driver: Driver;
  dumpPath: string;
  workDir: string;
  cleanup(): void;
}

function buildFinalTextRound(text: string): unknown[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "final" },
    { type: "text-delta", id: "final", delta: text },
    { type: "text-end", id: "final" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 60, noCache: 60, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
    },
  ];
}

/**
 * Spawn the TUI in a fresh temp cwd with:
 *  - the leader-tier assessor + critics scripted via the `responses` array
 *    (matched against the raw `prompt` text passed to `llm.generate`, NOT the
 *    `model` doStream/doGenerate fixture — see header comment).
 *  - a `classify` line for PIL's layer-1 classifier, which the mock intercepts
 *    by system prompt WITHOUT consuming a stream round (mock-model.ts
 *    CLASSIFY_SIGNATURE / autoClassify) — as it does for the session-title and
 *    compaction-proposer calls. So the single `stream` round IS the main-agent
 *    turn (plain text reply; no tool call is needed for this feature).
 */
async function spawnGateHarness(
  workDir: string,
  assessorResponseJson: Record<string, unknown>,
  opts: { criticResponseJson?: Record<string, unknown>; classifyDepthWord?: "quick" | "standard" | "heavy" } = {},
): Promise<GateHarness> {
  const fixDir = join(workDir, "fix");
  mkdirSync(fixDir, { recursive: true });

  const responses: Array<{ match: string; text: string }> = [
    { match: "You are the complexity assessor", text: JSON.stringify(assessorResponseJson) },
  ];
  if (opts.criticResponseJson) {
    responses.push({ match: "critic for a prompt-enrichment gate", text: JSON.stringify(opts.criticResponseJson) });
  }
  responses.push({ match: "*", text: "continue" });

  const fixture: Record<string, unknown> = {
    responses,
    model: {
      // PIL's layer-1 classify call is INTERCEPTED by the mock (mock-model.ts
      // CLASSIFY_SIGNATURE + autoClassify, on by default for file fixtures), so
      // it never consumes a `stream` round. Its FIFTH word is the model-decided
      // depth tier, which lands in pilCtx.modelDepthTier (layer1-intent.ts:762)
      // and is the gate's `priorDepth`. Omitting it yields DEFAULT_CLASSIFY_LINE
      // ("…,standard,…") — which is the real reason depth is always "standard"
      // in these specs, NOT the (dead) MUONROI_LLM_FIRST_CLASSIFY killswitch.
      classify: `generate,concise,task,code,${opts.classifyDepthWord ?? "standard"},local,english,clear`,
      stream: [
        // The session-title and compaction-proposer calls are intercepted too
        // (ANCILLARY_SIGNATURES), so round 0 IS the main-agent turn. Plain text
        // reply — this feature is about the INPUT the model sees, not tool
        // orchestration.
        buildFinalTextRound("Understood."),
      ],
    },
  };
  writeFileSync(join(fixDir, "fixture.json"), JSON.stringify(fixture), "utf8");
  const dumpPath = join(workDir, "calls.json");

  const ctx = await spawnHarness({
    cwd: workDir,
    extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash", "--mock-llm", fixDir],
    env: {
      MUONROI_MOCK_MODEL_DUMP: dumpPath,
      MUONROI_NO_SHELL_HOLD: "1",
      MUONROI_PIL_DISCOVERY: "0",
      MUONROI_LLM_FIRST_CLASSIFY: "0",
      MUONROI_GSD_NATIVE: "1",
      MUONROI_GSD_ASSESSOR: "1",
      MUONROI_PIL_GATE_ENRICH: "1",
    },
  });

  ctx.proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[child] ${chunk.toString("utf8")}`);
  });

  await ctx.driver.wait_for({ idle: true, timeoutMs: 15_000 });
  await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 5_000 });

  return {
    proc: ctx.proc,
    driver: ctx.driver,
    dumpPath,
    workDir,
    cleanup: () => {
      try {
        ctx.proc.kill();
      } catch {
        // ignore — best-effort teardown
      }
      ctx.cleanup?.();
    },
  };
}

/**
 * Resolve a GSD planning artifact the way `planningRoot` (src/gsd/paths.ts) does:
 * legacy `.planning/` when present, else the consolidated
 * `.muonroi-flow/planning/` a fresh project now writes to.
 */
function planningFile(cwd: string, name: string): string {
  const legacy = join(cwd, ".planning");
  return existsSync(legacy) ? join(legacy, name) : join(cwd, ".muonroi-flow", "planning", name);
}

async function exitAndWaitForDump(handle: GateHarness, timeoutMs = 20_000): Promise<void> {
  handle.driver.type("/exit");
  handle.driver.press("Enter");
  await new Promise<void>((resolve) => {
    if (handle.proc.exitCode !== null) {
      resolve();
      return;
    }
    handle.proc.once("exit", () => resolve());
    setTimeout(() => {
      try {
        handle.proc.kill();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
  });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && !existsSync(handle.dumpPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Same marker used by gsd-hard-gate.spec.ts to isolate main-agent turns from
 * PIL's own classify/absorber calls in the shared doStream dump. */
function isAgentCall(c: { options?: { prompt?: unknown } } | null | undefined): boolean {
  const p = c?.options?.prompt;
  if (!Array.isArray(p) || p.length === 0) return false;
  const sys = p[0] as { content?: unknown };
  const sysText = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? "");
  return sysText.includes("muonroi-cli in Agent mode");
}

function userTextOf(c: { options?: { prompt?: unknown } } | null | undefined): string {
  const p = c?.options?.prompt;
  if (!Array.isArray(p)) return "";
  const parts: string[] = [];
  for (const msg of p) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      parts.push(m.content);
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<{ type?: string; text?: string }>) {
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

async function waitForFirstAgentCall(handle: GateHarness): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(handle.dumpPath)) {
      try {
        if (loadDumpedRecordings(handle.dumpPath).filter(isAgentCall).length >= 1) return;
      } catch {
        // dump mid-rotation — atomic rename means the next read is clean
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("PIL Prompt Gate — E2E via real TUI turn pipeline", { retry: 0 }, () => {
  let handle: GateHarness | null = null;
  let workDir: string | undefined;

  afterEach(async () => {
    handle?.cleanup();
    handle = null;
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore — best-effort cleanup
      }
      workDir = undefined;
    }
  });

  it("vague heavy prompt: brief prepended, original prompt preserved after it", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-pil-gate-enriched-"));

    const rawPrompt = "please clean up the auth stuff, it's kind of a mess";
    handle = await spawnGateHarness(
      workDir,
      {
        depth: "heavy",
        autoCouncil: false,
        rationale: "e2e: vague heavy prompt",
        quality: { verdict: "enriched", missing: ["target"], noiseRisk: "low" },
        enrichedPrompt: "Intent: refactor auth. Likely area: src/auth (confirm via grep before anchoring).",
      },
      {
        criticResponseJson: {
          verdict: "enriched",
          strippedBrief: "Likely area: src/auth (confirm via grep before anchoring).",
        },
      },
    );

    handle.driver.type(rawPrompt);
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });
    await waitForFirstAgentCall(handle);
    await exitAndWaitForDump(handle);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const userText = userTextOf(agentCalls[0]);

    const briefIdx = userText.indexOf("[PIL Gate brief]");
    expect(briefIdx).toBe(0);
    expect(userText).toContain("confirm via grep");

    const rawIdx = userText.indexOf(rawPrompt);
    expect(rawIdx).toBeGreaterThan(briefIdx);
  }, 120_000);

  it("crisp/adequate prompt: no brief prefix (raw passthrough)", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-pil-gate-adequate-"));

    const rawPrompt = "Rename the function `computeTotal` to `calculateTotal` in src/billing/totals.ts";
    handle = await spawnGateHarness(workDir, {
      depth: "quick",
      autoCouncil: false,
      rationale: "e2e: crisp prompt",
      quality: { verdict: "adequate", missing: [], noiseRisk: "low" },
      enrichedPrompt: "",
    });

    handle.driver.type(rawPrompt);
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });
    await waitForFirstAgentCall(handle);
    await exitAndWaitForDump(handle);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const userText = userTextOf(agentCalls[0]);

    expect(userText).not.toContain("[PIL Gate brief]");
    expect(userText).toContain(rawPrompt);
  }, 120_000);

  it("standard-depth prompt: no critic call (producer verdict used as-is)", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-pil-gate-standard-"));

    const rawPrompt = "Add input validation to the signup form handler";
    handle = await spawnGateHarness(
      workDir,
      {
        depth: "standard",
        autoCouncil: false,
        rationale: "e2e: standard-depth prompt",
        quality: { verdict: "enriched", missing: ["acceptance"], noiseRisk: "low" },
        enrichedPrompt: "STANDARD-PATH-MARKER: validate required fields (confirm via grep before anchoring).",
      },
      {
        // If critics ran (they must NOT — critics are heavy-only, see
        // message-processor.ts:762 `if (depth === "heavy")`), this DISTINCT
        // marker would replace the producer's brief in the final message.
        criticResponseJson: { verdict: "enriched", strippedBrief: "CRITIC-WAS-CALLED-MARKER" },
      },
    );

    handle.driver.type(rawPrompt);
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });
    await waitForFirstAgentCall(handle);
    await exitAndWaitForDump(handle);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const userText = userTextOf(agentCalls[0]);

    expect(userText).toContain("[PIL Gate brief]");
    expect(userText).toContain("STANDARD-PATH-MARKER");
    expect(userText).not.toContain("CRITIC-WAS-CALLED-MARKER");
  }, 120_000);

  it("quick + high-confidence prompt: assessor pre-filter skips, no assessor call fires", async () => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-pil-gate-quick-"));

    const rawPrompt = "Add input validation to the signup form handler";
    handle = await spawnGateHarness(
      workDir,
      {
        // Deliberately LOUD: if the assessor were called it would override depth
        // to heavy, write ASSESSMENT.md, and prepend this marker as the brief.
        // All three are asserted absent below, so this fixture is the negative
        // control — the test cannot pass by the assessor merely returning
        // something bland (that is case 2's shape, not this one).
        depth: "heavy",
        autoCouncil: false,
        rationale: "e2e: assessor MUST NOT run on quick + high confidence",
        quality: { verdict: "enriched", missing: ["target"], noiseRisk: "low" },
        enrichedPrompt: "ASSESSOR-WAS-CALLED-MARKER",
      },
      // Fifth classify word = the depth tier -> pilCtx.modelDepthTier = "quick".
      // llm-classify.ts:464 pins confidence at 0.75, above the 0.7
      // CONFIDENCE_FLOOR, and a first turn has no conversation digest so the
      // continuation floor (0.85) does not apply -> shouldAssess("quick", 0.75,
      // false) === false (complexity-assessor.ts:53-57).
      { classifyDepthWord: "quick" },
    );

    handle.driver.type(rawPrompt);
    handle.driver.press("Enter");
    await handle.driver.wait_for({ selector: "role=log", timeoutMs: 20_000 });
    await waitForFirstAgentCall(handle);
    await exitAndWaitForDump(handle);

    const agentCalls = loadDumpedRecordings(handle.dumpPath).filter(isAgentCall);
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    const userText = userTextOf(agentCalls[0]);

    // 1. The assessor never produced a verdict: it writes ASSESSMENT.md only on
    //    the non-skip path (complexity-assessor.ts:159 writeAssessment).
    expect(existsSync(planningFile(workDir, "ASSESSMENT.md"))).toBe(false);
    // 2. Its brief never reached the model, so no enrichment ran at all.
    expect(userText).not.toContain("ASSESSOR-WAS-CALLED-MARKER");
    expect(userText).not.toContain("[PIL Gate brief]");
    // 3. The depth the fast classifier chose survived to STATE.md unmodified —
    //    had the assessor run, its "heavy" verdict would be here instead.
    expect(readFileSync(planningFile(workDir, "STATE.md"), "utf8")).toMatch(/\|\s*Depth\s*\|\s*quick\s*\|/);
    // 4. The turn still ran normally on the raw prompt.
    expect(userText).toContain(rawPrompt);
  }, 120_000);
});
