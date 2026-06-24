import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { DelegationManager } from "../delegations.js";

function getProjectId(cwd: string): string {
  const base =
    path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

async function getDelegationsDir(cwd: string): Promise<string> {
  const projectId = getProjectId(cwd);
  return path.join(os.homedir(), ".muonroi-cli", "delegations", projectId);
}

describe("DelegationManager.kill", () => {
  it("terminates a running delegation and updates its status to error", async () => {
    const tempCwd = path.join(os.tmpdir(), "muonroi-test-" + Math.random().toString(36).slice(2));
    const manager = new DelegationManager(() => tempCwd);

    const dir = await getDelegationsDir(tempCwd);
    await fs.mkdir(dir, { recursive: true });

    const id = "test-amber-panda";
    const jobPath = path.join(dir, `${id}.json`);
    const outputPath = path.join(dir, `${id}.md`);

    // Create a mock running delegation
    const record = {
      id,
      agent: "explore" as const,
      description: "test delegation",
      prompt: "noop",
      cwd: tempCwd,
      model: "grok-4",
      sandboxMode: "off" as const,
      maxToolRounds: 10,
      maxTokens: 4000,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      outputPath,
      pid: 99999, // dummy PID
    };

    await fs.writeFile(jobPath, JSON.stringify(record, null, 2), "utf8");

    // Call cancel
    const result = await manager.kill(id);
    expect(result.success).toBe(true);
    expect(result.output).toContain(`Delegation "${id}" (PID: 99999) has been terminated.`);

    // Verify the record was updated
    const updatedRaw = await fs.readFile(jobPath, "utf8");
    const updated = JSON.parse(updatedRaw);
    expect(updated.status).toBe("error");
    expect(updated.error).toBe("Cancelled by user.");

    // Cleanup
    await fs.rm(jobPath, { force: true });
    await fs.rm(outputPath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns failure if the delegation ID is not found", async () => {
    const tempCwd = path.join(os.tmpdir(), "muonroi-test-" + Math.random().toString(36).slice(2));
    const manager = new DelegationManager(() => tempCwd);

    const result = await manager.kill("non-existent-id");
    expect(result.success).toBe(false);
    expect(result.output).toContain('Delegation "non-existent-id" not found.');
  });

  it("returns failure if the delegation is already finished", async () => {
    const tempCwd = path.join(os.tmpdir(), "muonroi-test-" + Math.random().toString(36).slice(2));
    const manager = new DelegationManager(() => tempCwd);

    const dir = await getDelegationsDir(tempCwd);
    await fs.mkdir(dir, { recursive: true });

    const id = "test-steady-owl";
    const jobPath = path.join(dir, `${id}.json`);

    const record = {
      id,
      agent: "explore" as const,
      description: "test delegation",
      prompt: "noop",
      cwd: tempCwd,
      model: "grok-4",
      sandboxMode: "off" as const,
      maxToolRounds: 10,
      maxTokens: 4000,
      status: "complete" as const,
      startedAt: new Date().toISOString(),
      outputPath: path.join(dir, `${id}.md`),
    };

    await fs.writeFile(jobPath, JSON.stringify(record, null, 2), "utf8");

    const result = await manager.kill(id);
    expect(result.success).toBe(false);
    expect(result.output).toContain(`Delegation "${id}" is not running (status: complete).`);

    // Cleanup
    await fs.rm(jobPath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
