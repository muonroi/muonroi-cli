import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog, MODELS } from "../../models/registry.js";
import { closeDatabase } from "../../storage/db.js";
import { sessionUsedFlowWorkflow } from "../../storage/index.js";
import * as settings from "../../utils/settings.js";
import { ensurePlanningWorkspace } from "../../workflow/config-bridge.js";
import { planningArtifact } from "../../workflow/paths.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));

describe("actual main completion scope", () => {
  it.each([
    [true, "yolo", "read_file"],
    [false, "yolo", "read_file"],
    [false, "auto-edit", "read_file"],
    [false, "safe", "read_file"],
    [false, "safe", "grep"],
  ] as const)(
    "binds reads and completion evidence to permissions and the workflow's conversation: owns=%s permission=%s first=%s",
    async (owns, permissionMode, firstRead) => {
      await loadCatalog();
      const chosen = MODELS.find((row) => row.tier === "fast" && row.provider && row.supportsClientTools !== false)!;
      vi.spyOn(settings, "isModelDisabled").mockImplementation((id) => id !== chosen.id);
      vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
      vi.spyOn(settings, "isAutoCouncilEnabled").mockReturnValue(false);
      const previousCwd = process.cwd();
      const home = mkdtempSync(join(tmpdir(), "completion-main-"));
      const env = Object.fromEntries(
        [
          "HOME",
          "USERPROFILE",
          "MUONROI_CLI_HOME",
          "MUONROI_FLOW_NATIVE",
          "MUONROI_FLOW_ASSESSOR",
          "MUONROI_EE_BASE_URL",
          "MUONROI_DISABLE_GROUNDING_CHECK",
        ].map((key) => [key, process.env[key]]),
      );
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.MUONROI_CLI_HOME = join(home, ".muonroi-cli");
      process.env.MUONROI_FLOW_NATIVE = "1";
      process.env.MUONROI_FLOW_ASSESSOR = "0";
      process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
      process.env.MUONROI_DISABLE_GROUNDING_CHECK = "1";
      closeDatabase();
      process.chdir(home);
      ensurePlanningWorkspace(home, chosen.id);
      writeFileSync(
        planningArtifact(home, "PLAN.md"),
        "# Deliver the complete MCP server\n\nScanner preflight, server implementation and executable tests.",
      );
      writeFileSync(planningArtifact(home, "PLAN-VERIFY.md"), "verdict: pass\n");
      writeFileSync(
        planningArtifact(home, "STATE.md"),
        "# STATE\n\n| Field | Value |\n| --- | --- |\n| Phase | execute |\n| Depth | standard |\n| Plan Verified | yes |\n",
      );
      writeFileSync(
        join(home, "progress.md"),
        "DONE: scanner preflight\nTODO: server implementation\nTODO: executable acceptance\n",
      );
      const reads = [
        toolCallStream({
          toolName: "read_file",
          toolCallId: "scope-plan-read",
          input: { file_path: planningArtifact(home, "PLAN.md"), start_line: 1, end_line: 3, max_chars: 2000 },
        }),
        toolCallStream({
          toolName: "grep",
          toolCallId: "scope-progress-search",
          input: { pattern: "TODO:", path: "progress.md" },
        }),
      ];
      const handle = installMockModel({
        fixture: {
          autoClassify: true,
          stream: [
            ...(firstRead === "grep" ? reads.reverse() : reads),
            ...(owns ? [toolCallStream({ toolName: "flow_status", toolCallId: "scope-status", input: {} })] : []),
            textOnlyStream(owns ? "All requested work is complete." : "The current question is answered."),
          ],
        },
      });
      const root = new Agent("fixture-key", undefined, chosen.id, 7, {
        persistSession: true,
        executionRole: "orchestrator",
        permissionMode,
      });
      try {
        const chunks = [];
        for await (const chunk of root.processMessage("Report progress and evidence for the current work"))
          chunks.push(chunk);
        expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
        const output = chunks
          .filter((chunk) => chunk.type === "content")
          .map((chunk) => chunk.content)
          .join("");
        const prompts = JSON.stringify(handle.model.doStreamCalls);
        if (permissionMode === "safe") {
          // Safe mode asks inside the read's execute (tool-approval.ts). This
          // headless Agent has no approval handler, so each read is answered
          // with a denial tool-result — never run, never left without a result.
          expect(prompts).toContain("no approval decision could be obtained");
          expect(prompts).not.toContain("TODO: server implementation");
          expect(prompts).not.toContain("TODO: executable acceptance");
          expect(output).not.toContain("Native Flow evidence");
          return;
        }
        expect(prompts).toContain("TODO: server implementation");
        expect(prompts).toContain("TODO: executable acceptance");
        const history = JSON.stringify((root as any).messages);
        expect(history).toContain("scope-plan-read");
        expect(history).toContain("scope-progress-search");
        expect(history).not.toContain("ERROR:");
        if (owns) {
          expect(sessionUsedFlowWorkflow(root.getSessionId()!)).toBe(true);
          expect(prompts).toContain("Native completion scope");
          expect(prompts).toContain("Deliver the complete MCP server");
          expect(output).toContain("All requested work is complete.");
          expect(prompts).toContain("implementationVerification");
          expect(prompts).toContain("wholeTaskCompletion");
          expect(output).not.toContain("Native Flow evidence");
          expect(JSON.stringify((root as any).messages)).not.toContain("Native Flow evidence");
          const previousRequests = handle.model.doStreamCalls.length;
          for await (const _chunk of root.processMessage(
            "Continue with the remaining deliverables; report only verified progress",
          )) {
            /* drain actual next turn */
          }
          const nextPrompts = JSON.stringify(handle.model.doStreamCalls.slice(previousRequests));
          expect(nextPrompts).toContain("Native completion scope");
          expect(nextPrompts).toContain("Deliver the complete MCP server");
        } else {
          expect(prompts).not.toContain("Native completion scope");
          expect(output).not.toContain("Native Flow evidence");
        }
      } finally {
        await root.cleanup();
        handle.uninstall();
        closeDatabase();
        process.chdir(previousCwd);
        for (const [key, value] of Object.entries(env)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        vi.restoreAllMocks();
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
    30000,
  );
});
