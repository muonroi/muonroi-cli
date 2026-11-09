import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream, toolCallStream } from "../../agent-harness/mock-model.js";
import { loadCatalog, MODELS } from "../../models/registry.js";
import * as settings from "../../utils/settings.js";
import { Agent } from "../orchestrator.js";

vi.mock("../../pil/pipeline.js", () => ({ runPipeline: () => new Promise(() => {}) }));

describe("actual root SDK role guidance", () => {
  it("keeps root reference, selected research stage and fast-tier steering within actual coordination grants", async () => {
    await loadCatalog();
    const chosen = MODELS.find((row) => row.tier === "fast" && row.provider && row.supportsClientTools !== false)!;
    vi.spyOn(settings, "isModelDisabled").mockImplementation((id) => id !== chosen.id);
    vi.spyOn(settings, "isProviderDisabled").mockReturnValue(false);
    const cwd = process.cwd();
    const home = mkdtempSync(join(tmpdir(), "root-guidance-"));
    const priorFlow = process.env.MUONROI_FLOW_NATIVE;
    process.env.MUONROI_FLOW_NATIVE = "0";
    process.chdir(home);
    const handle = installMockModel({
      fixture: {
        autoClassify: true,
        stream: [
          toolCallStream({
            toolName: "context_load",
            toolCallId: "root-stage",
            input: { stage: "research", handoff: "Retain exact worker evidence" },
          }),
          toolCallStream({ toolName: "context_load", toolCallId: "root-reference", input: { topic: "reference" } }),
          textOnlyStream("ROOT_COORDINATES_RUNTIME_AUDIT"),
        ],
      },
    });
    const root = new Agent("fixture-key", undefined, chosen.id, 5, {
      persistSession: true,
      executionRole: "orchestrator",
      permissionMode: "yolo",
    });
    try {
      const chunks = [];
      for await (const chunk of root.processMessage(
        "Audit the failed worker runtime and coordinate exact evidence without changing code",
      ))
        chunks.push(chunk);
      const calls = handle.model.doStreamCalls.filter((call) =>
        call.tools?.some((tool) => tool.type === "function" && tool.name === "context_load"),
      );
      expect(calls.length).toBeGreaterThanOrEqual(3);
      const payload = JSON.stringify(calls);
      const leaks = [
        "read_file ranges/max_chars",
        "TOOLS (call directly)",
        "[CRITICAL TOOL-USE RULES",
        "call read_file ONCE",
      ].filter((fragment) => payload.includes(fragment));
      console.info("actual root prepared guidance leaks", JSON.stringify(leaks));
      expect(leaks).toEqual([]);
      expect(payload).toContain("stage=research");
      expect(payload).toContain("Retain exact worker evidence");
      for (const call of calls) {
        const names = call.tools?.filter((tool) => tool.type === "function").map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(["read_file", "grep"]));
        for (const excluded of ["write_file", "edit_file", "bash"]) expect(names).not.toContain(excluded);
      }
      expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    } finally {
      await root.cleanup();
      handle.uninstall();
      process.chdir(cwd);
      if (priorFlow === undefined) delete process.env.MUONROI_FLOW_NATIVE;
      else process.env.MUONROI_FLOW_NATIVE = priorFlow;
      vi.restoreAllMocks();
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000);
});
