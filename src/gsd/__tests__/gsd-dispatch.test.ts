import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePlanningWorkspace } from "../config-bridge.js";
import {
  dispatchConfigEnsure,
  dispatchLoopRenderHooks,
  resolveGsdToolsBin,
  resolveLoopHooksInProcess,
} from "../gsd-dispatch.js";

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
