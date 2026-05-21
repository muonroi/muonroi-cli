/**
 * src/product-loop/__tests__/sprint-self-verify.test.ts
 *
 * Tier 3 sprint-self-verify gate unit tests. Focus: gating logic (env flag,
 * watched-surface detection, summary parse). Does NOT actually spawn bun —
 * those paths are covered by the larger self-qa harness suite.
 */

import { describe, expect, it } from "vitest";
import { runSprintSelfVerify } from "../sprint-self-verify.js";

describe("runSprintSelfVerify", () => {
  const ORIG_CI = process.env["CI"];
  const ORIG_NODE_ENV = process.env["NODE_ENV"];

  function clearEnv() {
    delete process.env["MUONROI_SPRINT_SELF_VERIFY"];
    delete process.env["CI"];
    delete process.env["NODE_ENV"];
  }

  function restoreEnv() {
    if (ORIG_CI === undefined) delete process.env["CI"];
    else process.env["CI"] = ORIG_CI;
    if (ORIG_NODE_ENV === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = ORIG_NODE_ENV;
  }

  it("default ON when no env flag set — fires past the gate", async () => {
    clearEnv();
    // baseRef=HEAD → empty diff → returns no-watched-changes (proves gate was passed).
    const r = await runSprintSelfVerify({ repoRoot: process.cwd(), baseRef: "HEAD" });
    expect(r.skipReason).not.toBe("disabled");
    restoreEnv();
  });

  it("returns skipReason='disabled' when MUONROI_SPRINT_SELF_VERIFY=0", async () => {
    clearEnv();
    process.env["MUONROI_SPRINT_SELF_VERIFY"] = "0";
    const r = await runSprintSelfVerify({ repoRoot: process.cwd() });
    expect(r.ran).toBe(false);
    expect(r.skipReason).toBe("disabled");
    restoreEnv();
  });

  it("returns skipReason='disabled' when CI=true", async () => {
    clearEnv();
    process.env["CI"] = "true";
    const r = await runSprintSelfVerify({ repoRoot: process.cwd() });
    expect(r.ran).toBe(false);
    expect(r.skipReason).toBe("disabled");
    restoreEnv();
  });

  it("returns skipReason='no-watched-changes' when enabled and diff has no watched files", async () => {
    clearEnv();
    const r = await runSprintSelfVerify({
      repoRoot: process.cwd(),
      baseRef: "HEAD",
    });
    expect(r.ran).toBe(false);
    expect(r.skipReason).toBe("no-watched-changes");
    restoreEnv();
  });

  it("forceEnable overrides CI=true", async () => {
    clearEnv();
    process.env["CI"] = "true";
    const r = await runSprintSelfVerify({
      repoRoot: process.cwd(),
      baseRef: "HEAD",
      forceEnable: true,
    });
    expect(r.skipReason).not.toBe("disabled");
    restoreEnv();
  });
});
