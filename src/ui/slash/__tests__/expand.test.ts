import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SlashContext } from "../registry.js";

// Import to trigger self-registration
import "../expand.js";

import { dispatchSlash } from "../registry.js";

let tmpDir: string;

const makeCtx = (cwd: string): SlashContext => ({
  cwd,
  tenantId: "local",
  defaultProvider: "anthropic",
  defaultModel: "claude-3-5-sonnet-latest",
});

describe("handleExpandSlash", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "expand-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns message when no history files exist", async () => {
    // Create empty history dir
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    await fs.mkdir(path.join(flowDir, "history"), { recursive: true });

    const result = await dispatchSlash("expand", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result).toContain("Nothing to expand");
  });

  it("returns message when no flow dir exists", async () => {
    const result = await dispatchSlash("expand", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result).toContain("Nothing to expand");
  });

  it("restores from latest history file (sorted by filename)", async () => {
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    const historyDir = path.join(flowDir, "history");
    await fs.mkdir(historyDir, { recursive: true });

    // Create two snapshots — older and newer
    await fs.writeFile(
      path.join(historyDir, "2026-04-29T10-00-00-000Z.md"),
      "Old snapshot content",
      "utf8",
    );
    await fs.writeFile(
      path.join(historyDir, "2026-04-30T10-00-00-000Z.md"),
      "Latest snapshot content",
      "utf8",
    );

    const result = await dispatchSlash("expand", [], makeCtx(tmpDir));
    expect(result).toBeTypeOf("string");
    expect(result).toContain("__EXPAND__");
    expect(result).toContain("Latest snapshot content");
  });

  it("deletes snapshot file after restore (no double-expand)", async () => {
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    const historyDir = path.join(flowDir, "history");
    await fs.mkdir(historyDir, { recursive: true });

    await fs.writeFile(
      path.join(historyDir, "2026-04-30T12-00-00-000Z.md"),
      "Snapshot to delete",
      "utf8",
    );

    await dispatchSlash("expand", [], makeCtx(tmpDir));

    // Verify file was deleted
    const remaining = await fs.readdir(historyDir);
    expect(remaining).toHaveLength(0);
  });

  it("returns restored content length summary", async () => {
    const flowDir = path.join(tmpDir, ".muonroi-flow");
    const historyDir = path.join(flowDir, "history");
    await fs.mkdir(historyDir, { recursive: true });

    const content = "Restored content here";
    await fs.writeFile(
      path.join(historyDir, "2026-04-30T14-00-00-000Z.md"),
      content,
      "utf8",
    );

    const result = await dispatchSlash("expand", [], makeCtx(tmpDir));
    expect(result).toContain("Restored from");
  });
});
