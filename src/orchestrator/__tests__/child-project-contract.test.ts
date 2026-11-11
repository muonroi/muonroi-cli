import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getModelByTier, loadCatalog } from "../../models/registry.js";
import { buildSubagentPrompt } from "../prompts.js";

describe("child project contract", () => {
  it("preserves project boundaries and delegates workflow ownership to main", async () => {
    await loadCatalog();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-contract-"));
    fs.writeFileSync(
      path.join(dir, "AGENTS.md"),
      "CHILD_BOUNDARY_SENTINEL: preserve unrelated changes and report evidence.",
    );
    try {
      const model = getModelByTier("fast")!;
      const prompt = buildSubagentPrompt(
        { agent: "explore", description: "Assigned audit", prompt: "Inspect evidence" },
        dir,
        null,
        "off",
        [],
        {},
        model.provider,
      );
      expect(prompt).toContain("CHILD_BOUNDARY_SENTINEL");
      expect(prompt).toContain("parent owns workflow coordination");
      expect(prompt).toContain("instead of expanding scope");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
