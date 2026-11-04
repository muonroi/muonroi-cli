import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import * as leader from "../../council/leader.js";
import { loadCatalog, MODELS } from "../../models/registry.js";
import type { ProviderId } from "../../providers/types.js";
import { closeDatabase, getDatabasePath } from "../../storage/db.js";
import * as settings from "../../utils/settings.js";
import { planReviewBinding } from "../../workflow/async-plan-review.js";
import { planningArtifact, planningRoot } from "../../workflow/paths.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));

describe("actual root SDK plan review loop", () => {
  it("caps background review dispatch while permitting exact-result completion without an inline council", async () => {
    const home = mkdtempSync(join(tmpdir(), "root-review-budget-")),
      cwd = process.cwd();
    const env = {
      NODE_ENV: "test",
      HOME: home,
      USERPROFILE: home,
      MUONROI_CLI_HOME: join(home, ".muonroi-cli"),
      MUONROI_AUTH_DIR: join(home, "auth"),
      MUONROI_ENV_FILE: join(home, ".env"),
      MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      MUONROI_FLOW_NATIVE: "1",
      MUONROI_FLOW_PLAN_REVIEW_MAX_ATTEMPTS: "3",
    };
    const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    process.chdir(home);
    closeDatabase();
    mkdirSync(join(home, ".planning"));
    let root: Agent | undefined, handle: ReturnType<typeof installMockModel> | undefined;
    try {
      expect(getDatabasePath().startsWith(home)).toBe(true);
      expect(planningRoot(home)).toBe(join(home, ".planning"));
      await loadCatalog();
      const model = MODELS.find((row) => row.tier === "fast" && row.provider && row.supportsClientTools !== false)!;
      vi.spyOn(settings, "isModelDisabled").mockImplementation((id) => id !== model.id);
      vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
      vi.spyOn(leader, "resolvePlanCouncilLeader").mockResolvedValue({ modelId: model.id });
      settings.saveUserSettings({
        defaultProvider: model.provider as ProviderId,
        peakHourPolicy: { enabled: false },
        mcp: { servers: [] },
      });
      const streams = [
        ...[1, 2, 3].flatMap((i) => [
          toolCallStream({
            toolCallId: `plan-${i}`,
            toolName: "flow_plan",
            input: { body: `# Plan revision${i}\n1. Gather exact evidence\n2. Verify` },
          }),
          toolCallStream({ toolCallId: `review-${i}`, toolName: "flow_plan_review", input: {} }),
          ...(i < 3
            ? [
                toolCallStream({
                  toolCallId: `complete-${i}`,
                  toolName: "flow_plan_review",
                  input: {
                    action: "complete",
                    jobId: `review-${i}`,
                    resultVersion: `version-${i}`,
                    assessment: "Checked the bound reviewer evidence; concern remains unresolved",
                    decisions: [
                      {
                        findingId: "acceptance-evidence",
                        decision: "accept",
                        rationale: "Independent plan inspection confirms missing acceptance criteria",
                        evidence: ["PLAN.md has steps only, with no acceptance assertion"],
                      },
                    ],
                  },
                }),
              ]
            : []),
        ]),
        textOnlyStream("UNRESOLVED_REVIEW: stop and report the remaining acceptance concern."),
      ];
      handle = installMockModel({ fixture: { autoClassify: true, stream: streams } });
      root = new Agent("offline-fixture-key", undefined, model.id, 20, {
        executionRole: "orchestrator",
        persistSession: true,
        permissionMode: "yolo",
      });
      const council = vi.spyOn(root, "runCouncilV2");
      const requests: Array<{ depth: string; revisionCycle: number }> = [];
      const dispatch = vi.spyOn(root, "startPlanReview").mockImplementation(async (input) => {
        requests.push(input);
        return { success: true, output: `Pending bounded review ${input.revisionCycle}` };
      });
      const collect = vi.spyOn(root, "readPlanReview").mockImplementation(async (input) => ({
        synthesis:
          "```council-verdict\n" +
          JSON.stringify({
            verdict: "revise",
            concerns: ["Missing acceptance evidence"],
            evidence: ["PLAN.md"],
            findings: [
              {
                id: "acceptance-evidence",
                severity: "blocking",
                status: "open",
                claim: "Missing acceptance evidence",
                planReference: "PLAN.md steps 1-2",
                evidenceKind: "plan-risk",
                evidence: ["PLAN.md has no measurable assertion"],
                reproduction: ["Inspect the acceptance section"],
                closure: "Add a measurable acceptance assertion",
              },
            ],
          }) +
          "\n```",
        requiresAdjudication: true,
        binding: planReviewBinding(home, requests[Number(input.jobId.split("-")[1]) - 1]!),
        assertCurrent: () => {},
      }));
      const chunks = [];
      for await (const chunk of root.processMessage(
        "Review and revise the current bounded plan; preserve unresolved review gates",
      ))
        chunks.push(chunk);
      expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([]);
      expect(chunks.map((chunk) => chunk.content ?? "").join("")).toContain("UNRESOLVED_REVIEW");
      expect(council).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(collect).toHaveBeenCalledTimes(2);
      const final = handle.model.doStreamCalls.at(-1)!;
      expect(final.tools ?? []).toHaveLength(0);
      expect(JSON.stringify(final.prompt)).toContain("await_background_result");
      expect(readFileSync(planningArtifact(home, "PLAN-REVIEW.md"), "utf8")).toContain("Revision cycle: 1");
      expect(readFileSync(planningArtifact(home, "PLAN-VERIFY.md"), "utf8")).toContain("verdict: revise");
      streams.push(
        toolCallStream({ toolCallId: "review-on-background-wake", toolName: "flow_plan_review", input: {} }),
        textOnlyStream("BACKGROUND_ALLOWANCE_RETAINED"),
      );
      for await (const _chunk of root.processMessage(
        "Process the background result; this is an internal wake",
        undefined,
        undefined,
        { internalActivity: true },
      )) {
        /* drain */
      }
      expect(dispatch).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(handle.model.doStreamCalls.at(-1)!.prompt)).toContain("plan_review_budget_exhausted");
      streams.push(textOnlyStream("NEW_EXPLICIT_USER_REQUEST"));
      for await (const _chunk of root.processMessage("A new user request starts a new allowance")) {
        /* drain */
      }
      expect((root as any).requestPlanReviewBudget().used).toBe(0);
    } finally {
      await root?.cleanup();
      handle?.uninstall();
      closeDatabase();
      vi.restoreAllMocks();
      process.chdir(cwd);
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);
});
