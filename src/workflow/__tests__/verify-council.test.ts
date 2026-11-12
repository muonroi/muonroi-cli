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
    cwd = mkdtempSync(join(tmpdir(), "flow-vc-"));
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

  it("every perspective prompt carries the fidelity and concern-scope rules", async () => {
    const prompts: string[] = [];
    const runPerspectiveFn = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return '```council-verdict\n{"verdict":"approve","concerns":[],"evidence":[],"rationale":"ok"}\n```';
    });
    await runVerifyCouncil({ cwd, sessionModelId: "sess-model", depth: "heavy", runPerspectiveFn });
    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      expect(prompt).toContain("sampled passages of the SOURCE appear in the OUTPUT with equivalent normalized text");
      expect(prompt).toContain("outside the deliverable and the done-criteria");
    }
  });

  it("an out-of-scope advisory finding does not block, a false-claim blocker still does", async () => {
    const advisory =
      '```council-verdict\n{"verdict":"approve","concerns":["notes file has no generating script"],"evidence":["deliverable sample matches source"],"rationale":"ok","findings":[{"id":"F1","severity":"advisory","status":"open","claim":"notes file not script-generated","planReference":"PLAN.md notes","evidenceKind":"observed","evidence":["notes/inventory.md"],"reproduction":[],"closure":"optional"}]}\n```';
    const ok = await runVerifyCouncil({
      cwd,
      sessionModelId: "sess-model",
      depth: "standard",
      runDebate: vi.fn(async () => advisory),
    });
    expect(ok.verdict).toBe("pass");

    const falseClaim =
      '```council-verdict\n{"verdict":"revise","concerns":["evidence claims 72 code fences, measured 70"],"evidence":[],"rationale":"false claim"}\n```';
    const bad = await runVerifyCouncil({
      cwd,
      sessionModelId: "sess-model",
      depth: "standard",
      runDebate: vi.fn(async () => falseClaim),
    });
    expect(bad.verdict).toBe("revise");
    expect(bad.concerns.join(" ")).toContain("72 code fences");
  });
});
