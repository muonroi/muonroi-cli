/**
 * M15 — the worker prompt is built from the tools the worker is actually
 * granted. Workers never hold task/delegate/convene_council/flow_*
 * (orchestration-policy.ts WORKER_FORBIDDEN), and a file-scoped worker has no
 * bash, so policy written for those tools must not be sent to them.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../../models/registry.js";
import { buildTaskContextCore } from "../../pil/context-modules.js";
import { buildAgentModePrompt, buildSubagentPrompt, MODE_PROMPTS, resetStaticPrefixCache } from "../prompts.js";

const GENERAL_WORKER = [
  "ask_user",
  "bash",
  "bash_output_get",
  "compact",
  "context_load",
  "edit_file",
  "git_commit",
  "grep",
  "lsp_query",
  "process_list",
  "process_logs",
  "process_stop",
  "read_file",
  "retrieve_tool_result",
  "todo_write",
  "verification_run",
  "write_file",
];
const SCOPED_WORKER = [
  "compact",
  "context_load",
  "edit_file",
  "grep",
  "read_file",
  "run_gate",
  "todo_write",
  "write_file",
];

function workerPrompt(granted: readonly string[] | undefined, provider = "anthropic"): string {
  resetStaticPrefixCache();
  return buildSubagentPrompt(
    { agent: "general", description: "d", prompt: "p" } as never,
    process.cwd(),
    null,
    "off",
    [],
    undefined,
    provider,
    granted,
  );
}

beforeAll(async () => {
  await loadCatalog();
});
beforeEach(() => resetStaticPrefixCache());

describe("worker prompt built from granted tools (M15)", () => {
  it("drops delegation policy, delegation-prompt guide, delegation examples and token-budget framing", () => {
    const p = workerPrompt(GENERAL_WORKER);
    expect(p).not.toContain("DEFAULT DELEGATION POLICY");
    expect(p).not.toContain("WRITING A GOOD DELEGATION PROMPT");
    expect(p).not.toContain("EXAMPLES:");
    expect(p).not.toContain("TOKEN BUDGET:");
    expect(p).not.toMatch(/^- task: Delegate/m);
    expect(p).not.toMatch(/^- delegate: /m);
    expect(p).not.toContain("schedule_create");
    // The worker's own tools are still described.
    expect(p).toMatch(/^- bash: Execute shell commands/m);
    expect(p).toMatch(/^- edit_file: /m);
    expect(p).toContain("Shell rules for the bash tool:");
  });

  it("a file-scoped worker without bash gets no shell rules and no bash workflow", () => {
    const p = workerPrompt(SCOPED_WORKER);
    expect(p).not.toContain("Shell rules for the bash tool:");
    expect(p).not.toMatch(/^- bash: /m);
    expect(p).not.toContain("Run tests or builds with bash");
    expect(p).not.toContain("BATCH BASH COMMANDS");
    expect(p).toContain("ENVIRONMENT:");
  });

  it("the native-capabilities block follows the same grant", () => {
    // Only the native block: repository CUSTOM INSTRUCTIONS may legitimately
    // name any tool.
    const full = workerPrompt(SCOPED_WORKER);
    const p = full.slice(full.indexOf("[NATIVE CAPABILITIES"), full.indexOf("[END NATIVE CAPABILITIES]"));
    expect(p.length).toBeGreaterThan(0);
    expect(p).not.toContain('task(agent="explore"');
    expect(p).not.toContain("bash output is cached");
    expect(p).not.toContain("selfverify_start");
    expect(p).not.toContain("Default to verification_run");
  });

  it("host-owned paragraphs are gone from every agent prompt (main included)", () => {
    for (const p of [MODE_PROMPTS.agent, workerPrompt(GENERAL_WORKER), workerPrompt(undefined)]) {
      expect(p).not.toContain("Long tasks never need to stop for context");
      expect(p).not.toContain("Use the experience brain actively");
      expect(p).not.toContain("Commit your own work as you go");
    }
  });

  it("with an unknown tool set (main) every tool section is kept", () => {
    const full = buildAgentModePrompt();
    expect(full).toBe(MODE_PROMPTS.agent);
    for (const section of [
      "DEFAULT DELEGATION POLICY",
      "WRITING A GOOD DELEGATION PROMPT",
      "EXAMPLES:",
      "TOKEN BUDGET:",
    ])
      expect(full).toContain(section);
    expect(full).toContain("Dependent calls");
  });

  it("is materially smaller for a worker than the full persona", () => {
    expect(buildAgentModePrompt((n) => GENERAL_WORKER.includes(n)).length).toBeLessThan(
      MODE_PROMPTS.agent.length - 3000,
    );
  });

  it("explore (ask mode) lists only granted tools", () => {
    resetStaticPrefixCache();
    const p = buildSubagentPrompt(
      { agent: "explore", description: "d", prompt: "p" } as never,
      process.cwd(),
      null,
      "off",
      [],
      undefined,
      "anthropic",
      ["read_file", "grep"],
    );
    expect(p).not.toMatch(/^- task: /m);
    expect(p).not.toMatch(/^- bash: /m);
    expect(p).toMatch(/^- read_file: /m);
    expect(p).toContain("NEVER create, modify, or delete files");
  });
});

describe("buildTaskContextCore", () => {
  it("never carries the muonroi-cli Zero Hardcode rule, EE prose or the working-ledger duplicate", () => {
    const all = buildTaskContextCore();
    expect(all).not.toMatch(/never hardcode IDs/i);
    expect(all).not.toContain("EE is native: recall before");
    expect(all).not.toContain("Context hygiene:");
    expect(all).not.toContain("For CLI self-analysis");
  });

  it("gates selfverify routing on the tool being present", () => {
    expect(buildTaskContextCore((n) => n !== "selfverify_start")).not.toContain("selfverify");
    expect(buildTaskContextCore()).toContain('selfverify_start(mode="tier1"');
  });
});
