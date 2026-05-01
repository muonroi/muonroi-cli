/**
 * Tests for warning-persist.ts — persistWarning appends EE hook warnings
 * to run state.md Experience Snapshot section.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InterceptMatch } from "../../ee/types.js";
import { getSection } from "../parser.js";
import { createRun, loadRun, setActiveRunId } from "../run-manager.js";
import { ensureFlowDir } from "../scaffold.js";
import { persistWarning } from "../warning-persist.js";

let tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

function makeMatch(overrides?: Partial<InterceptMatch>): InterceptMatch {
  return {
    principle_uuid: "test-uuid",
    embedding_model_version: "v1",
    confidence: 0.85,
    why: "Test reason",
    message: "Test warning message",
    scope_label: "repo:test",
    last_matched_at: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

describe("persistWarning", () => {
  it("appends rendered warning to state.md Experience Snapshot section", async () => {
    const cwd = await makeTempDir("warn-persist-");
    const flowDir = await ensureFlowDir(cwd);
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const match = makeMatch({ message: "Do not force push", why: "Destroys history" });
    await persistWarning(cwd, match);

    const restored = await loadRun(flowDir, run.id);
    expect(restored).not.toBeNull();
    const snapshot = getSection(restored!.state, "Experience Snapshot");
    expect(snapshot).toContain("Do not force push");
    expect(snapshot).toContain("Destroys history");
  });

  it("is a no-op when no active run exists (does not throw)", async () => {
    const cwd = await makeTempDir("warn-no-run-");
    await ensureFlowDir(cwd);
    // No active run set
    await expect(persistWarning(cwd, makeMatch())).resolves.toBeUndefined();
  });

  it("is a no-op when .muonroi-flow/ does not exist", async () => {
    const cwd = await makeTempDir("warn-no-flow-");
    await expect(persistWarning(cwd, makeMatch())).resolves.toBeUndefined();
  });

  it("accumulates multiple warnings (not overwrite)", async () => {
    const cwd = await makeTempDir("warn-accum-");
    const flowDir = await ensureFlowDir(cwd);
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    await persistWarning(cwd, makeMatch({ message: "Warning A", principle_uuid: "uuid-a" }));
    await persistWarning(cwd, makeMatch({ message: "Warning B", principle_uuid: "uuid-b" }));
    await persistWarning(cwd, makeMatch({ message: "Warning C", principle_uuid: "uuid-c" }));

    const restored = await loadRun(flowDir, run.id);
    const snapshot = getSection(restored!.state, "Experience Snapshot");
    expect(snapshot).toContain("Warning A");
    expect(snapshot).toContain("Warning B");
    expect(snapshot).toContain("Warning C");
  });

  it("uses renderInterceptWarning format", async () => {
    const cwd = await makeTempDir("warn-format-");
    const flowDir = await ensureFlowDir(cwd);
    const run = await createRun(flowDir);
    await setActiveRunId(flowDir, run.id);

    const match = makeMatch({
      confidence: 0.92,
      message: "Avoid rm -rf",
      why: "Dangerous command",
      scope_label: "global",
    });
    await persistWarning(cwd, match);

    const restored = await loadRun(flowDir, run.id);
    const snapshot = getSection(restored!.state, "Experience Snapshot");
    // renderInterceptWarning format: boxed 5-line warning with percentage confidence
    expect(snapshot).toContain("92%");
    expect(snapshot).toContain("Avoid rm -rf");
    expect(snapshot).toContain("Dangerous command");
    expect(snapshot).toContain("global");
  });
});
