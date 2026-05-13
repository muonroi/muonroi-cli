import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendRoleMemory, readRoleMemory } from "../role-memory.js";

describe("role-memory management", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `gsd-test-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  it("appends and reads back small blocks", async () => {
    const runId = "run-123";
    const slot = "PO";

    await appendRoleMemory(tempDir, runId, slot, 1, "Initial requirements");
    await appendRoleMemory(tempDir, runId, slot, 2, "Refined requirements");

    const content = await readRoleMemory(tempDir, runId, slot);
    expect(content).toContain("### Sprint 1");
    expect(content).toContain("Initial requirements");
    expect(content).toContain("### Sprint 2");
    expect(content).toContain("Refined requirements");
  });

  it("truncates oldest blocks when exceeding 2KB", async () => {
    const runId = "run-cap";
    const slot = "Architect";

    // Each block is ~100 bytes
    const largeBlock = "X".repeat(100);

    for (let i = 1; i <= 30; i++) {
      await appendRoleMemory(tempDir, runId, slot, i, `Block ${i}: ${largeBlock}`);
    }

    const content = await readRoleMemory(tempDir, runId, slot);
    expect(content.length).toBeLessThanOrEqual(2048);

    // Sprint 1 should definitely be gone
    expect(content).not.toContain("### Sprint 1\n");
    // Latest sprint should be there
    expect(content).toContain("### Sprint 30\n");

    // Verify it starts with a "### Sprint" line (boundary preserved)
    expect(content.trim().startsWith("### Sprint")).toBe(true);
  });

  it("returns empty string for missing slot", async () => {
    const content = await readRoleMemory(tempDir, "none", "PO");
    expect(content).toBe("");
  });

  it("handles concurrent appends to different slots", async () => {
    const runId = "run-parallel";

    await Promise.all([
      appendRoleMemory(tempDir, runId, "PO", 1, "PO content"),
      appendRoleMemory(tempDir, runId, "Customer", 1, "Customer content"),
      appendRoleMemory(tempDir, runId, "Tester", 1, "Tester content"),
    ]);

    expect(await readRoleMemory(tempDir, runId, "PO")).toContain("PO content");
    expect(await readRoleMemory(tempDir, runId, "Customer")).toContain("Customer content");
    expect(await readRoleMemory(tempDir, runId, "Tester")).toContain("Tester content");
  });
});
