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
 * Case NOT shipped as a real test (documented it.todo — see below):
 *   3. quick + high-confidence -> gate skipped entirely (assessComplexity's
 *      shouldAssess() pre-filter, src/gsd/complexity-assessor.ts:32-35,
 *      returns false and the assessor call never fires). This is already
 *      unit-covered (complexity-assessor.test.ts: shouldAssess("quick", 0.95)
 *      === false). It is NOT reachable deterministically through this E2E
 *      harness: `pilCtx.modelDepthTier` (the only source of a "quick"
 *      `priorDepth` — see message-processor.ts:722) is set ONLY by the
 *      model-first classify path in src/pil/layer1-intent.ts:792, which is
 *      OFF in every other harness spec (MUONROI_LLM_FIRST_CLASSIFY=0, per
 *      this repo's determinism convention — see gsd-hard-gate.spec.ts's own
 *      header: "the LLM classifier is off ... depth is ALWAYS standard").
 *      Turning it on to force "quick" would require additionally mocking an
 *      entirely separate, undocumented-in-any-harness-spec LLM call shape
 *      (`llmRes.taskType/depthTier/confidence/deliverableKind/ecosystemScope/
 *      replyLanguage`) with its own unverified prompt header — a second,
 *      independent nondeterministic LLM-call surface with no existing
 *      harness precedent. Per this task's explicit escape hatch (verify
 *      first, don't ship flake), this case is left as `it.todo` rather than
 *      risk a flaky or load-bearing-on-guesswork spec.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 *  - a minimal 2-round `model` fixture: round 0 absorbs PIL's Pass-4
 *    offline-cascade classify call (issued even with
 *    MUONROI_LLM_FIRST_CLASSIFY=0 — see gsd-hard-gate.spec.ts's identical
 *    comment), round 1 is the real main-agent turn (plain text reply, no
 *    tool call needed for this feature).
 */
async function spawnGateHarness(
  workDir: string,
  assessorResponseJson: Record<string, unknown>,
  opts: { criticResponseJson?: Record<string, unknown> } = {},
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
      stream: [
        // Round 0: absorber for PIL's Pass-4 offline-cascade LLM fallback
        // (src/pil/llm-classify.ts), which issues its own streamText call
        // ahead of the main agent even with MUONROI_LLM_FIRST_CLASSIFY=0.
        buildFinalTextRound("generate,concise,task,code,standard,local,english"),
        // Round 1: the real main-agent turn. Plain text reply — this feature
        // is about the INPUT the model sees, not tool orchestration.
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

  // Case 3 (quick + high-confidence -> gate skipped entirely) is NOT
  // harness-observable deterministically in this repo's mock setup — see the
  // file header comment for the full evidence trail (shouldAssess's only
  // "quick" input path is the model-first classify layer, which every other
  // harness spec keeps OFF for determinism). Already unit-covered:
  // src/gsd/__tests__/complexity-assessor.test.ts asserts
  // shouldAssess("quick", 0.95) === false.
  it.todo(
    "quick + high-confidence prompt: gate skipped, no assessor call fired — " +
      "not reachable via this harness without a second, unmocked LLM-call surface " +
      "(model-first classify); unit-covered by complexity-assessor.test.ts instead",
  );
});
