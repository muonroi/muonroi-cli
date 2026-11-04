import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getModelByTier, loadCatalog } from "../../models/registry.js";
import type { PermissionMode } from "../../utils/permission-mode.js";
import { buildSystemPromptParts, resetStaticPrefixCache } from "../prompts.js";

afterEach(resetStaticPrefixCache);
beforeAll(async () => {
  await loadCatalog();
});

function parts(permissionMode?: PermissionMode, toolTurn = false) {
  const model = getModelByTier("fast");
  if (!model) throw new Error("The runtime context fixture requires a catalog fast-tier model");
  return buildSystemPromptParts(process.cwd(), "agent", "off", undefined, [], undefined, model.provider, undefined, {
    permissionMode,
    toolTurn,
  });
}

describe("runtime permission context", () => {
  it("refreshes permission snapshots outside the shared static prefix", () => {
    const safe = parts("safe");
    const yolo = parts("yolo");
    expect(safe.dynamicSuffix).toContain("permission mode: safe");
    expect(yolo.dynamicSuffix).toContain("permission mode: yolo");
    expect(yolo.dynamicSuffix).not.toContain("permission mode: safe");
    expect(safe.staticPrefix).toBe(yolo.staticPrefix);
    expect(safe.staticPrefix).not.toContain("permission mode: safe");
  });

  it("retains explicit auto-edit and actual sandbox state on reduced tool turns", () => {
    const reduced = parts("auto-edit", true);
    expect(reduced.dynamicSuffix).toContain("permission mode: auto-edit");
    expect(reduced.dynamicSuffix).toContain("sandbox mode: off");
  });

  it("does not invent safe mode when a caller lacks permission information", () => {
    const child = parts();
    expect(child.dynamicSuffix).toContain("permission mode: unavailable");
    expect(child.dynamicSuffix).not.toMatch(/permission mode: (safe|yolo|auto-edit)/);
  });
});
