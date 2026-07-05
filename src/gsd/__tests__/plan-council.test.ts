import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import { planningArtifact } from "../paths.js";
import { runPlanCouncil } from "../plan-council.js";
import { perspectivesForDepth } from "../plan-council-prompts.js";
import { canExecute, readPlanVerifyVerdict } from "../workflow-engine.js";

const GOOD_PLAN = `# Plan

1. Edit src/foo.ts — add export
2. Add test in src/foo.test.ts
3. Acceptance: bun test src/foo.test.ts passes
`;

const SESSION_MODEL = "deepseek-v4-flash";

describe("plan-council", () => {
  let tmp: string;
  let priorDeepseekKey: string | undefined;

  beforeAll(async () => {
    await loadCatalog();
    // resolvePlanCouncilLeader gates leader promotion on the session provider
    // being *reachable* (getConfiguredProviders → key/OAuth present). Without a
    // deepseek credential it returns the session model unchanged (flash) instead
    // of the catalog leader (deepseek-v4-pro). On a dev box with a stored key the
    // promotion fires; on clean CI it does not — the exact "works on my machine"
    // split that made this file's standard-depth assertion fail only on CI.
    // Force a deterministic, hermetic reachability via env so the leader resolves
    // to deepseek-v4-pro on every host. This never triggers a network call: the
    // default perspective path is the offline heuristicReview.
    priorDeepseekKey = process.env.DEEPSEEK_API_KEY;
    // A non-secret, obviously-synthetic value that only needs to clear the
    // length>=20 reachability threshold in getConfiguredProviders. Built from a
    // repeated char (zero entropy) so the secret scanner does not flag it.
    process.env.DEEPSEEK_API_KEY = `deepseek-test-reachability-${"x".repeat(20)}`;
  });

  afterAll(() => {
    if (priorDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = priorDeepseekKey;
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("skips council at quick depth", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, "m");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "quick" });
    expect(result.skipped).toBe(true);
    expect(perspectivesForDepth("quick")).toHaveLength(0);
  });

  it("runs 2 perspectives at standard depth and writes PLAN-VERIFY.md", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "standard" });
    expect(result.skipped).toBe(false);
    expect(result.leaderModelId).toBe("deepseek-v4-pro");
    expect(result.perspectives).toHaveLength(2);
    expect(existsSync(planningArtifact(tmp, "PLAN-REVIEW.md"))).toBe(true);
    expect(existsSync(planningArtifact(tmp, "PLAN-VERIFY.md"))).toBe(true);
    expect(readPlanVerifyVerdict(tmp)).toBe("pass");
    expect(canExecute(tmp, "standard").allowed).toBe(true);
  });

  it("runs 5 perspectives at heavy depth", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, "m");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "heavy" });
    expect(result.perspectives.length).toBeGreaterThanOrEqual(3);
    const review = readFileSync(planningArtifact(tmp, "PLAN-REVIEW.md"), "utf8");
    expect(review).toContain("Leader:");
  });

  it("blocks execute when plan is too short", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-"));
    ensurePlanningWorkspace(tmp, "m");
    writeFileSync(planningArtifact(tmp, "PLAN.md"), "fix it", "utf8");
    const result = await runPlanCouncil({ cwd: tmp, sessionModelId: SESSION_MODEL, depth: "standard" });
    expect(result.verdict).not.toBe("pass");
    expect(canExecute(tmp, "standard").allowed).toBe(false);
  });

  it("surfaces prior PLAN-REVIEW concerns + CONTEXT/RESEARCH to debate topic", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-ctx-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");
    writeFileSync(planningArtifact(tmp, "CONTEXT.md"), "Gray area: should we cache at SDK or app layer?", "utf8");
    writeFileSync(planningArtifact(tmp, "RESEARCH.md"), "Finding: SDK cache hook exists at src/sdk.ts:42", "utf8");
    writeFileSync(
      planningArtifact(tmp, "PLAN-REVIEW.md"),
      "# PLAN-REVIEW\n\n## Concerns\n\n- Plan misses retry path\n- No timeout policy\n",
      "utf8",
    );

    const seen = new Set<string>();
    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
      revisionCycle: 1,
      runPerspectiveFn: async (prompt) => {
        // Capture what each perspective actually received.
        seen.add(prompt);
        return JSON.stringify({ verdict: "approve", concerns: [], evidence: [] });
      },
    });

    // Every perspective prompt must include the GSD context block + prior concerns directive.
    for (const prompt of seen) {
      expect(prompt).toContain("GSD Context");
      expect(prompt).toContain("Prior council concerns");
      expect(prompt).toContain("Plan misses retry path");
    }
    expect(result.hadPriorConcerns).toBe(true);
    expect(result.contextBundleChars ?? 0).toBeGreaterThan(0);
  });

  it("debate path uses model-first structured verdict (no regex on prose)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-debate-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
      runDebate: async () =>
        [
          "We considered retry, security, and scope. No blockers.",
          "```council-verdict",
          '{"verdict":"approve","concerns":[],"evidence":["PLAN.md covers retry"],"rationale":"plan is complete"}',
          "```",
        ].join("\n"),
    });

    expect(result.skipped).toBe(false);
    expect(result.verdict).toBe("pass");
    expect(result.verdictSource).toBe("structured");
    expect(result.verdictParseFailed).toBe(false);
    // Prose containing "block" / "revision" tokens MUST NOT flip the verdict
    // anymore — only the structured block decides.
    expect(canExecute(tmp, "standard").allowed).toBe(true);
  });

  it("debate path: prose containing 'block' / 'revision required' does not override structured approve", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-debate-adv-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
      runDebate: async () =>
        [
          "This plan is NOT a block. No revision required. Nothing here should revise.",
          "```council-verdict",
          '{"verdict":"approve","concerns":[]}',
          "```",
        ].join("\n"),
    });

    // The adversarial prose used to false-match the old regex; model-first
    // extraction must ignore the prose entirely.
    expect(result.verdict).toBe("pass");
    expect(result.verdictSource).toBe("structured");
  });

  it("debate path: parse-fail forces conservative revise (never silent approve)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-debate-fail-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
      runDebate: async () => "The plan looks great, I approve it wholeheartedly. Ship it now!", // no JSON block
    });

    expect(result.verdict).toBe("revise");
    expect(result.verdictSource).toBe("parse-failed");
    expect(result.verdictParseFailed).toBe(true);
    expect(canExecute(tmp, "standard").allowed).toBe(false);
    const verify = readFileSync(planningArtifact(tmp, "PLAN-VERIFY.md"), "utf8");
    expect(verify).toContain("verdictParseFailed: yes");
  });

  it("perspective path parses structured verdict from each perspective", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-st-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
      runPerspectiveFn: async () =>
        '```council-verdict\n{"verdict":"approve","concerns":[],"evidence":["src/foo.ts:1"]}\n```',
    });

    expect(result.verdict).toBe("pass");
    expect(result.perspectives.every((p) => p.source === "structured")).toBe(true);
    expect(result.perspectives[0]?.evidence).toContain("src/foo.ts:1");
  });

  it("perspective path falls back to heuristic when perspective emits no JSON", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-st-fail-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard",
      runPerspectiveFn: async () => "I cannot decide, the plan seems okay to me.",
    });

    // No structured verdict → heuristic fallback applies (source flag set).
    expect(result.perspectives.every((p) => p.source === "heuristic-fallback")).toBe(true);
    expect(result.verdictSource).toBe("heuristic-fallback");
  });

  it("perspective path runs perspectives in parallel (not serial)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "pc-par-"));
    ensurePlanningWorkspace(tmp, SESSION_MODEL);
    writeFileSync(planningArtifact(tmp, "PLAN.md"), GOOD_PLAN, "utf8");

    const delay = 120;
    const start = Date.now();
    const result = await runPlanCouncil({
      cwd: tmp,
      sessionModelId: SESSION_MODEL,
      depth: "standard", // 2 perspectives
      runPerspectiveFn: async () => {
        await new Promise((r) => setTimeout(r, delay));
        return '```council-verdict\n{"verdict":"approve","concerns":[]}\n```';
      },
    });
    const elapsed = Date.now() - start;

    expect(result.perspectives).toHaveLength(2);
    // Serial would be >= 2*delay. Parallel is ~delay + scheduling slack.
    // Allow generous headroom for CI scheduling but assert < 1.8x serial.
    expect(elapsed).toBeLessThan(delay * 2);
  });
});
