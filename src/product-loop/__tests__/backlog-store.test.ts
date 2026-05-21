/**
 * backlog-store.test.ts — P6 unit tests for read/write/update on backlog.json.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readBacklog, updateBacklogItem, writeBacklog } from "../backlog-store.js";
import type { Backlog, BacklogItem } from "../types.js";

function makeItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: "item-001",
    title: "Login feature",
    description: "Allow users to log in",
    acceptance_criteria: ["user can log in with email/password"],
    entities: [],
    endpoints: [],
    mvp_priority: "v1",
    status: "backlog",
    effortPoints: 3,
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    updatedAtUtc: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeBacklog(overrides: Partial<Backlog> = {}): Backlog {
  return {
    runId: "run-test",
    productSlug: "my-app",
    items: [makeItem()],
    derivedFromClarifyId: "abc123def456abcd",
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("backlog-store (P6)", () => {
  let flowDir: string;
  const runId = "run-test";

  beforeEach(async () => {
    flowDir = path.join(os.tmpdir(), `backlog-test-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(flowDir, { recursive: true });
  });

  it("returns null when backlog.json does not exist", async () => {
    const result = await readBacklog(flowDir, runId);
    expect(result).toBeNull();
  });

  it("write + read round-trip preserves all fields", async () => {
    const backlog = makeBacklog();
    await writeBacklog(flowDir, runId, backlog);

    const read = await readBacklog(flowDir, runId);
    expect(read).not.toBeNull();
    expect(read!.runId).toBe("run-test");
    expect(read!.productSlug).toBe("my-app");
    expect(read!.items).toHaveLength(1);
    expect(read!.items[0].title).toBe("Login feature");
    expect(read!.derivedFromClarifyId).toBe("abc123def456abcd");
  });

  it("writes to correct path: .planning/runs/<runId>/backlog.json", async () => {
    const backlog = makeBacklog();
    await writeBacklog(flowDir, runId, backlog);

    const expectedPath = path.join(flowDir, "runs", runId, "backlog.json");
    const stat = await fs.stat(expectedPath);
    expect(stat.isFile()).toBe(true);
  });

  it("updateBacklogItem patches the item and updates updatedAtUtc", async () => {
    const backlog = makeBacklog();
    const before = backlog.items[0].updatedAtUtc;

    await writeBacklog(flowDir, runId, backlog);

    // Slight delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updateBacklogItem(flowDir, runId, "item-001", {
      status: "in_sprint",
      assigned_sprint: "sprint-1",
    });

    expect(updated.items[0].status).toBe("in_sprint");
    expect(updated.items[0].assigned_sprint).toBe("sprint-1");
    // updatedAtUtc must be refreshed
    expect(updated.items[0].updatedAtUtc).not.toBe(before);
    // Other fields unchanged
    expect(updated.items[0].title).toBe("Login feature");
    expect(updated.items[0].effortPoints).toBe(3);
  });

  it("updateBacklogItem persists the patch to disk", async () => {
    await writeBacklog(flowDir, runId, makeBacklog());
    await updateBacklogItem(flowDir, runId, "item-001", { status: "done" });

    const read = await readBacklog(flowDir, runId);
    expect(read!.items[0].status).toBe("done");
  });

  it("updateBacklogItem throws when backlog.json is missing", async () => {
    await expect(updateBacklogItem(flowDir, runId, "item-001", { status: "done" })).rejects.toThrow(
      /backlog.json not found/,
    );
  });

  it("updateBacklogItem throws when item id is not found", async () => {
    await writeBacklog(flowDir, runId, makeBacklog());
    await expect(updateBacklogItem(flowDir, runId, "nonexistent-id", { status: "done" })).rejects.toThrow(
      /not found in backlog/,
    );
  });
});
