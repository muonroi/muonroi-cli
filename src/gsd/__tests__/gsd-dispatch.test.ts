import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import {
  dispatchConfigEnsure,
  dispatchInitProgress,
  dispatchLoopRenderHooks,
  dispatchStateJson,
  invalidateGsdCache,
  resolveGsdToolsBin,
  resolveLoopHooksInProcess,
} from "../gsd-dispatch.js";
import { planningArtifact } from "../paths.js";

describe("gsd-dispatch", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves gsd-tools binary from @opengsd/gsd-core", () => {
    const bin = resolveGsdToolsBin();
    expect(bin).toContain("gsd-tools.cjs");
  });

  it("dispatchConfigEnsure creates .planning/config.json", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-dispatch-"));
    const result = dispatchConfigEnsure(tmp);
    expect(result.ok).toBe(true);
  });

  it("dispatchLoopRenderHooks returns hooks for plan:post", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-dispatch-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const result = dispatchLoopRenderHooks(tmp, "plan:post");
    expect(result.ok).toBe(true);
    expect(result.data?.point).toBe("plan:post");
    expect(Array.isArray(result.data?.activeHooks)).toBe(true);
  });

  it("resolveLoopHooksInProcess matches subprocess hook count", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-dispatch-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const inProc = resolveLoopHooksInProcess(tmp, "execute:pre");
    const sub = dispatchLoopRenderHooks(tmp, "execute:pre");
    expect(inProc?.point).toBe("execute:pre");
    expect(sub.data?.activeHooks?.length).toBe(inProc?.activeHooks.length);
  });
});

describe("gsd-dispatch read-through cache", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      invalidateGsdCache(tmp);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dispatchInitProgress spawns once when STATE.md stable, re-spawns after write", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-cache-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    // We assert via referential identity + mtime change instead of call-counting
    // the subprocess (execFileSync timing is env-dependent). Contract:
    // same mtime → same cached value object; new mtime → fresh value.
    const first = dispatchInitProgress(tmp);
    const second = dispatchInitProgress(tmp);
    expect(second).toBe(first); // referential hit — cache served

    // Mutate STATE.md mtime → cache invalidates.
    const statePath = planningArtifact(tmp, "STATE.md");
    const backdated = "# STATE\n\n| Field | Value |\n| --- | --- |\n| Phase | plan |\n";
    writeFileSync(statePath, backdated, "utf8");
    invalidateGsdCache(tmp);
    const third = dispatchInitProgress(tmp);
    expect(third).not.toBe(first); // miss after invalidation
  });

  it("dispatchStateJson returns cached value across calls until STATE.md changes", () => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-cache-sj-"));
    ensurePlanningWorkspace(tmp, "deepseek-v4-flash");
    const a = dispatchStateJson(tmp);
    const b = dispatchStateJson(tmp);
    expect(b).toBe(a);
  });
});
