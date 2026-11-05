/**
 * tests/harness/plan-review-convergence.spec.ts
 *
 * E2E for the host-side plan-review settlement (src/workflow/plan-review-convergence.ts)
 * through the REAL orchestrator path the tcis-libraries audit measured
 * (sessions 8a5bd89c2be0 / 4edc02516a92): main writes a plan, starts a durable
 * BACKGROUND plan council (a real detached CLI child running the council under
 * --mock-llm), is woken when it finishes, reads the result + dossier, completes
 * it with per-finding decisions, revises the plan and asks again.
 *
 * The council fixture always returns `revise` with the same blocking finding F1
 * (every background child replays the same `responses` entry) — the
 * non-converging reviewer. With the round allowance set to 2, the second
 * completed review must END the loop: the host settles, admits the plan with F1
 * carried as an open item, emits a `toast` LiveEvent, and the SAME turn
 * continues (the model is called again with the settlement as its tool result)
 * instead of stopping and waiting for a human "retry".
 *
 * Runtime values a static fixture cannot know (background job id, result
 * digest) are threaded with `{{prior:jobId}}` / `{{prior:resultVersion}}`
 * (src/agent-harness/mock-model.ts resolvePriorPlaceholders) from the wake-up
 * notice "Background agent complete: `<id>` jobId=<id> resultVersion=<digest>".
 */
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../../src/__test-stubs__/cleanup";
import { spawnHarness } from "./helpers.js";
import { loadDumpedRecordings } from "./recording.js";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const toolRound = (id: string, toolName: string, input: Record<string, unknown>) => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(50, 20) },
];
const textRound = (text: string) => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(60, 4) },
];

// The stubborn reviewer: identical structured blocking finding every round.
const COUNCIL_VERDICT = `\`\`\`council-verdict\n${JSON.stringify({
  verdict: "revise",
  concerns: ["Secret-scanner gate cannot go red on the real corpus"],
  evidence: ["PLAN.md acceptance asserts zero redactions on the real docs"],
  findings: [
    {
      id: "F1",
      severity: "blocking",
      status: "open",
      claim: "Secret-scanner gate cannot go red on the real corpus",
      planReference: "PLAN.md Acceptance",
      evidenceKind: "plan-risk",
      evidence: ["PLAN.md acceptance asserts zero redactions on the real docs"],
      reproduction: ["Run the indexer on the corpus and count redactions"],
      closure: "Add a seeded positive fixture that must turn the gate red",
    },
  ],
})}\n\`\`\``;

const complete = (n: number) =>
  toolRound(`complete-${n}`, "flow_plan_review", {
    action: "complete",
    jobId: "{{prior:jobId}}",
    resultVersion: "{{prior:resultVersion}}",
    assessment: `Read the council result and findings dossier (round ${n}); F1 still describes the current plan.`,
    decisions: [
      {
        findingId: "F1",
        decision: "accept",
        rationale: "The plan's acceptance section still has no seeded positive for the gate.",
        evidence: ["PLAN.md Acceptance has no seeded-positive fixture"],
      },
    ],
  });
const readResult = (n: number) => [
  toolRound(`read-${n}`, "delegation_read", { id: "{{prior:jobId}}" }),
  toolRound(`dossier-${n}`, "delegation_read", {
    id: "{{prior:jobId}}",
    toolCallId: "report:findings.json",
    resultVersion: "{{prior:resultVersion}}",
  }),
];

const FINAL_TEXT = "PROCEEDING_WITH_OPEN_ITEMS: implementing the docs server; F1 goes to verification.";

describe("plan review stops at the round allowance and the turn proceeds", { retry: 0 }, () => {
  let proc: ChildProcess;
  let driver: Driver;
  let cleanup: () => void;
  let work: string;
  let dumpPath: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "plan-review-convergence-"));
    const fixDir = join(work, "fix");
    mkdirSync(fixDir, { recursive: true });
    dumpPath = join(work, "calls.json");
    writeFileSync(
      join(fixDir, "fixture.json"),
      JSON.stringify({
        // Every council LLM call in every background child gets the same verdict.
        responses: [{ match: "*", text: COUNCIL_VERDICT }],
        model: {
          stream: [
            // Turn 1 (user): plan v1, start council #1, end the turn.
            toolRound("plan-1", "flow_plan", {
              body: "# Docs MCP server\n1. Index docs\n2. Redact secrets\n## Acceptance\n- zero redactions on real docs",
            }),
            toolRound("start-1", "flow_plan_review", { action: "start" }),
            textRound("Plan council 1 is running in the background."),
            // Wake 1: read + complete council #1 (revise F1), revise plan, start council #2.
            ...readResult(1),
            complete(1),
            toolRound("plan-2", "flow_plan", {
              body: "# Docs MCP server v2\n1. Index docs\n2. Redact secrets with value-context rules\n## Acceptance\n- zero redactions on real docs",
            }),
            toolRound("start-2", "flow_plan_review", { action: "start" }),
            textRound("Plan council 2 is running in the background."),
            // Wake 2: read + complete council #2 → allowance spent, same F1 → host settles.
            ...readResult(2),
            complete(2),
            textRound(FINAL_TEXT),
          ],
        },
      }),
      "utf8",
    );
    const ctx = await spawnHarness({
      cwd: work,
      fixturesDir: fixDir,
      extraArgs: ["-k", "FAKE_KEY_FOR_TESTS", "-m", "deepseek-v4-flash"],
      env: {
        MUONROI_CLI_HOME: join(work, ".muonroi-cli"),
        MUONROI_MOCK_MODEL_DUMP: dumpPath,
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
        MUONROI_FLOW_NATIVE: "1",
        MUONROI_FLOW_ASSESSOR: "0",
        MUONROI_PIL_DISCOVERY: "0",
        MUONROI_LLM_FIRST_CLASSIFY: "0",
        MUONROI_NO_SHELL_HOLD: "1",
        MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS: "2",
        MUONROI_FLOW_PLAN_REVIEW_ON_EXHAUSTION: "proceed",
      },
    });
    proc = ctx.proc;
    driver = ctx.driver;
    cleanup = ctx.cleanup;
    await driver.wait_for({ event: "input-ready", timeoutMs: 60_000 });
    await driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });
  }, 120_000);

  afterAll(() => {
    try {
      proc?.kill();
    } catch (err) {
      console.error(`[plan-review-convergence.spec] kill failed: ${(err as Error).message}`);
    }
    cleanup?.();
    if (work) bestEffortRemoveSync(work, "tests/harness/plan-review-convergence.spec.ts");
  });

  it("settles after the second non-converging council, carries F1, and the same turn continues", async () => {
    driver.type("build the TCIS docs MCP server");
    driver.press("Enter");

    // EVENT evidence: the host announces the settlement on the LiveEvent stream.
    await driver.wait_for({
      event: "toast",
      match: (e) => e.kind === "toast" && /Plan review settled/.test(e.text),
      timeoutMs: 180_000,
    });
    const toast = driver.last_event("toast");
    // Two councils, same F1, revised plan in between, allowance 2 → the
    // persistent-blocker rule fires (it is checked before plain exhaustion).
    expect(toast?.kind === "toast" && toast.text).toMatch(/Plan review settled \(persistent_blocker\).*F1/);

    // RENDER evidence: the turn reached the model's post-settlement reply.
    await driver.wait_for({ selector: `role=listitem name~="PROCEEDING_WITH_OPEN_ITEMS"`, timeoutMs: 60_000 });
    expect(driver.render_text()).toContain("PROCEEDING_WITH_OPEN_ITEMS");

    // Exactly two councils were bought — no third, and nobody had to say "retry".
    const delegationsRoot = join(work, ".muonroi-cli", "delegations");
    const councils = readdirSync(delegationsRoot).flatMap((d) =>
      readdirSync(join(delegationsRoot, d))
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(delegationsRoot, d, f), "utf8")) as { kind?: string })
        .filter((j) => j.kind === "council"),
    );
    expect(councils).toHaveLength(2);

    // Durable state: admitted by host settlement, F1 carried as an OPEN item.
    const planning = join(work, ".planning");
    const planningDir = existsSync(planning) ? planning : join(work, ".muonroi-flow", "planning");
    const verify = readFileSync(join(planningDir, "PLAN-VERIFY.md"), "utf8");
    expect(verify).toContain("verdict: pass");
    expect(verify).toContain("admissionMethod: convergence-settlement");
    expect(verify).toContain("[OPEN ITEM F1]");
    const ledger = JSON.parse(readFileSync(join(planningDir, "PLAN-FINDINGS.json"), "utf8")) as {
      entries: Array<{ finding: { id: string }; state: string }>;
    };
    expect(ledger.entries.find((e) => e.finding.id === "F1")?.state).toBe("open");
    const rounds = JSON.parse(readFileSync(join(planningDir, "PLAN-REVIEW-ROUNDS.json"), "utf8")) as {
      rounds: Array<{ openBlocking: Array<{ id: string }>; settled?: { reason: string } }>;
    };
    expect(rounds.rounds).toHaveLength(2);
    expect(rounds.rounds.every((r) => r.openBlocking.some((f) => f.id === "F1"))).toBe(true);
    expect(rounds.rounds.at(-1)?.settled?.reason).toBe("persistent_blocker");

    // The model call that produced FINAL_TEXT was fed the settlement as the
    // completion's tool result — i.e. the turn proceeded instead of stopping.
    driver.type("/exit");
    driver.press("Enter");
    await new Promise<void>((resolveExit) => {
      if (proc.exitCode !== null) return resolveExit();
      proc.once("exit", () => resolveExit());
      setTimeout(resolveExit, 20_000);
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !existsSync(dumpPath)) await new Promise((r) => setTimeout(r, 100));
    const calls = loadDumpedRecordings(dumpPath);
    const settledCall = calls.find((c) => JSON.stringify(c.options?.prompt ?? "").includes("execute_with_open_items"));
    expect(settledCall, "no model call received the settlement tool result").toBeDefined();
  }, 300_000);
});
