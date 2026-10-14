/**
 * Real mounted TUI regression for the background-only PIL contract.
 * Legacy assessor/critic fixtures are deliberately loud negative controls:
 * neither may rewrite the leader prompt or override local workflow state.
 * Foreground streaming must complete with the original user request even
 * when server/model enrichment describes a heavy task. The real SDK unit
 * tests separately prove pending/failed/never responding PIL and stale cleanup.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
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

describe("Background PIL — E2E via real TUI turn pipeline", { retry: 0 }, () => {
  let handle: GateHarness | null = null;
  let workDir: string | undefined;

  afterEach(async () => {
    handle?.cleanup();
    handle = null;
    if (workDir) {
      bestEffortRemoveSync(workDir, "tests/harness/gsd-pil-gate.spec.ts");
      workDir = undefined;
    }
  });

  it("heavy enrichment cannot rewrite the leader prompt", async () => {
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
    expect(briefIdx).toBe(-1);
    expect(userText).not.toContain("confirm via grep");
    expect(existsSync(planningFile(workDir, "ASSESSMENT.md"))).toBe(false);

    const rawIdx = userText.indexOf(rawPrompt);
    expect(rawIdx).toBe(0);
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

  it("standard enrichment remains outside the initial leader prompt", async () => {
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

    expect(userText).not.toContain("[PIL Gate brief]");
    expect(userText).not.toContain("STANDARD-PATH-MARKER");
    expect(userText).not.toContain("CRITIC-WAS-CALLED-MARKER");
  }, 120_000);

  it("background quick classification cannot override local default depth", async () => {
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
    // 3. Background classification cannot replace the local default depth.
    expect(readFileSync(planningFile(workDir, "STATE.md"), "utf8")).toMatch(/\|\s*Depth\s*\|\s*standard\s*\|/);
    // 4. The turn still ran normally on the raw prompt.
    expect(userText).toContain(rawPrompt);
  }, 120_000);
});
