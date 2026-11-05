import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ORCHESTRATOR_CONTRACT, withOrchestratorContract } from "../orchestration-policy.js";
import { buildSystemPromptParts, resetStaticPrefixCache } from "../prompts.js";

const cwd = mkdtempSync(join(tmpdir(), "orchestrator-contract-"));
afterAll(() => {
  resetStaticPrefixCache();
  rmSync(cwd, { recursive: true, force: true });
});

const occurrences = (haystack: string) => haystack.split(ORCHESTRATOR_CONTRACT).length - 1;

describe("orchestrator contract assembly", () => {
  it("is sent exactly once per orchestrator call (the static prefix already carries it)", () => {
    resetStaticPrefixCache();
    // Same assembly as tool-engine / batch-turn-runner: static prefix + dynamic suffix, then the helper.
    const parts = buildSystemPromptParts(cwd, "agent", "off", null, [], undefined, "deepseek", null, {
      permissionMode: "safe",
      executionRole: "orchestrator",
    });
    const system = withOrchestratorContract(`${parts.staticPrefix}${parts.dynamicSuffix}`, "orchestrator");
    expect(occurrences(system)).toBe(1);
  });

  it("is appended once for an orchestrator chitchat turn, whose static prefix omits it", () => {
    resetStaticPrefixCache();
    const parts = buildSystemPromptParts(cwd, "agent", "off", null, [], undefined, "deepseek", null, {
      chitchat: true,
      permissionMode: "safe",
      executionRole: "orchestrator",
    });
    const base = `${parts.staticPrefix}${parts.dynamicSuffix}`;
    expect(occurrences(base)).toBe(0);
    const system = withOrchestratorContract(base, "orchestrator");
    expect(occurrences(system)).toBe(1);
    expect(withOrchestratorContract(system, "orchestrator")).toBe(system);
  });

  it("never reaches workers or infrastructure", () => {
    expect(withOrchestratorContract("worker system", "worker")).toBe("worker system");
    expect(withOrchestratorContract("infra system", "infrastructure")).toBe("infra system");
    expect(withOrchestratorContract("default", undefined)).toBe("default");
  });
});

/**
 * The contract keeps only rules the host cannot enforce. These assert that each
 * such behavior is still stated (and the pointers to host tools still exist),
 * without pinning exact wording; the size cap stops it from regrowing into the
 * 10.3k-char version that every model step re-sent.
 */
describe("orchestrator contract content", () => {
  const has = (re: RegExp) => expect(ORCHESTRATOR_CONTRACT).toMatch(re);

  it("stays compact", () => {
    expect(ORCHESTRATOR_CONTRACT.length).toBeLessThanOrEqual(5_200);
  });

  it("states role, reading vs delegation and independent acceptance", () => {
    has(/main orchestrator/);
    has(/read_file and grep/);
    has(/delegate[^.]*implementation, commands, tests and independent review/);
    has(/own reading is never independent acceptance/i);
    has(/Only the tools supplied in this call exist/);
  });

  it("points at host-enforced worker boundaries instead of restating them", () => {
    has(/worker_models[^.]*call it once/);
    has(/writeScope/);
    has(/run_gate/);
    has(/never describe either as sandboxed/);
    has(/delegation_send writeScope/);
    has(/never claim rollback/);
  });

  it("describes inline completion delivery, ACK and no polling", () => {
    has(/completion notice carries the saved result inline/i);
    has(/delegation_read only for that remainder/);
    has(/delegation_ack[^.]*jobId and resultVersion/);
    has(/ACK records handling, not acceptance/);
    has(/never poll or sleep/);
    has(/without replyTo/);
  });

  it("keeps whole-goal completion honesty, which the host cannot gate in free text", () => {
    has(/root goal distinct from the current wave/);
    has(/does not finish the whole task/);
    has(/every deliverable and acceptance criterion/);
    has(/context_load/);
  });

  it("keeps evidence, council and failure-diagnosis judgment rules", () => {
    has(/static review is not executed tests/);
    has(/reviewOf/);
    has(/distinct opaque IDs/);
    has(/retrieve_tool_result/);
    has(/never ask the user for internal IDs/);
    has(/verdicts are advice/);
    has(/never accept a blocker only because several roles agree/);
    has(/reset the council allowance/);
    has(/clean-corpus true-negative expects zero detections/);
    has(/ModelMessage schema refusal is not context overflow/);
    has(/Access denied does not identify a lock owner/);
    has(/never replay an applied edit/);
    has(/output-limit stop/);
  });

  it("keeps user-facing privacy and language rules", () => {
    has(/keep coordination private/);
    has(/Reply in the user's language/);
  });
});
