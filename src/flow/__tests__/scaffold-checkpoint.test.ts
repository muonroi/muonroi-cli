/**
 * Plan 23-fix — unit tests for scaffold-checkpoint persistence.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listResumableScaffoldCheckpoints,
  readScaffoldCheckpoint,
  type ScaffoldCheckpoint,
  writeScaffoldCheckpoint,
} from "../scaffold-checkpoint.js";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-checkpoint-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const baseInputs: ScaffoldCheckpoint["inputs"] = {
  projectName: "todo-app",
  feStack: "react",
  bbTemplate: {
    shortName: "mr-base-sln",
    nugetId: "Muonroi.BaseTemplate",
    version: "1.0.0-alpha.3",
  },
  eePackages: ["Muonroi.AspNetCore"],
  commercial: false,
};

describe("scaffold-checkpoint", () => {
  it("writes and reads a checkpoint round-trip", async () => {
    const filePath = await writeScaffoldCheckpoint(cwd, "run-abc", {
      status: "submitted",
      inputs: baseInputs,
      originalPrompt: "tạo todo app",
    });
    expect(filePath).toMatch(/run-abc.*scaffold-checkpoint\.json$/);

    const loaded = await readScaffoldCheckpoint(cwd, "run-abc");
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe("submitted");
    expect(loaded?.inputs.projectName).toBe("todo-app");
    expect(loaded?.inputs.bbTemplate?.nugetId).toBe("Muonroi.BaseTemplate");
    expect(loaded?.runId).toBe("run-abc");
    expect(loaded?.schemaVersion).toBe(1);
  });

  it("preserves createdAt across status updates", async () => {
    await writeScaffoldCheckpoint(cwd, "run-xyz", { status: "submitted", inputs: baseInputs });
    const first = await readScaffoldCheckpoint(cwd, "run-xyz");
    await new Promise((r) => setTimeout(r, 10));
    await writeScaffoldCheckpoint(cwd, "run-xyz", {
      status: "error",
      inputs: baseInputs,
      errorMessage: "template not installed",
    });
    const second = await readScaffoldCheckpoint(cwd, "run-xyz");
    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
    expect(second?.status).toBe("error");
    expect(second?.errorMessage).toBe("template not installed");
  });

  it("returns null for missing checkpoint", async () => {
    expect(await readScaffoldCheckpoint(cwd, "nonexistent")).toBeNull();
  });

  it("returns null for corrupted JSON", async () => {
    const dir = path.join(cwd, ".muonroi-flow", "runs", "run-bad");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "scaffold-checkpoint.json"), "{not valid json", "utf8");
    expect(await readScaffoldCheckpoint(cwd, "run-bad")).toBeNull();
  });

  it("returns null for unknown schemaVersion (forward compat)", async () => {
    const dir = path.join(cwd, ".muonroi-flow", "runs", "run-fut");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "scaffold-checkpoint.json"),
      JSON.stringify({ schemaVersion: 99, runId: "run-fut", inputs: baseInputs }),
      "utf8",
    );
    expect(await readScaffoldCheckpoint(cwd, "run-fut")).toBeNull();
  });

  it("lists only non-done checkpoints, newest first", async () => {
    await writeScaffoldCheckpoint(cwd, "run-1", { status: "submitted", inputs: baseInputs });
    await new Promise((r) => setTimeout(r, 10));
    await writeScaffoldCheckpoint(cwd, "run-2", { status: "error", inputs: baseInputs, errorMessage: "x" });
    await new Promise((r) => setTimeout(r, 10));
    await writeScaffoldCheckpoint(cwd, "run-3", {
      status: "done",
      inputs: baseInputs,
      projectDir: "/tmp/todo-app",
    });
    const list = await listResumableScaffoldCheckpoints(cwd);
    expect(list.length).toBe(2);
    expect(list.map((c) => c.runId)).toEqual(["run-2", "run-1"]); // newest non-done first
  });

  it("listResumable returns empty array when flow dir missing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-empty-"));
    expect(await listResumableScaffoldCheckpoints(empty)).toEqual([]);
    await fs.rm(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});
