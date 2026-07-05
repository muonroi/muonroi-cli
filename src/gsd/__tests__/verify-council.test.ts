import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../council/leader.js", () => ({
  resolvePlanCouncilLeader: vi.fn(async () => ({ modelId: "leader-model" })),
}));

import { runVerifyCouncil } from "../verify-council.js";

function seed(cwd: string): void {
  const d = join(cwd, ".planning");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "PLAN.md"), "# Plan\n\n## Acceptance\n- returns a token\n", "utf8");
  writeFileSync(
    join(d, "STATE.md"),
    "# STATE\n\n| Field | Value |\n|---|---|\n| Phase | verify |\n| Depth | heavy |\n",
    "utf8",
  );
  writeFileSync(join(d, "PLAN-VERIFY.md"), "verdict: pass\n", "utf8");
}

describe("runVerifyCouncil", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "gsd-vc-"));
    seed(cwd);
  });

  it("returns pass and writes VERIFY-COUNCIL.md when every perspective approves", async () => {
    const runPerspectiveFn = vi.fn(
      async () =>
        '```council-verdict\n{"verdict":"approve","concerns":[],"evidence":["token at L3"],"rationale":"ok"}\n```',
    );
    const res = await runVerifyCouncil({
      cwd,
      sessionModelId: "sess-model",
      depth: "heavy",
      evidence: "42 passed",
      runPerspectiveFn,
    });
    expect(res.verdict).toBe("pass");
    expect(res.skipped).toBe(false);
    expect(existsSync(join(cwd, ".planning", "VERIFY-COUNCIL.md"))).toBe(true);
  });

  it("returns revise and collects concerns when a perspective flags a gap", async () => {
    const runPerspectiveFn = vi.fn(async (_p, p) =>
      p.id === "correctness"
        ? '```council-verdict\n{"verdict":"revise","concerns":["null token on empty password"],"evidence":[],"rationale":"gap"}\n```'
        : '```council-verdict\n{"verdict":"approve","concerns":[],"evidence":[],"rationale":"ok"}\n```',
    );
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "heavy", runPerspectiveFn });
    expect(res.verdict).toBe("revise");
    expect(res.concerns.join(" ")).toContain("null token");
  });

  it("skips (verdict pass, skipped true) at quick depth — deterministic floor only", async () => {
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "quick" });
    expect(res.skipped).toBe(true);
    expect(res.verdict).toBe("pass");
  });

  it("forces revise (never silently approves) when the debate emits no structured verdict", async () => {
    const runDebate = vi.fn(async () => "some prose with no fenced verdict block");
    const res = await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "heavy", runDebate });
    expect(res.verdict).toBe("revise");
    expect(res.verdictSource).toBe("parse-failed");
  });
});
