import { describe, expect, it } from "vitest";
import { probeRepoGrounding } from "../repo-grounding-probe.js";

const AUTH_SMALL = [
  { path: "src/auth/login.ts", lineCount: 80 },
  { path: "src/auth/session.ts", lineCount: 40 },
];

// 47 files, ~9k LOC, broad dir spread.
const AUTH_LARGE = Array.from({ length: 47 }, (_, i) => ({
  path: `src/${["auth", "ui", "orchestrator", "council", "pil"][i % 5]}/mod-${i}.ts`,
  lineCount: 191,
}));

describe("probeRepoGrounding", () => {
  it("does NOT run when the prompt has no repo target (generic prompt)", () => {
    const r = probeRepoGrounding("explain how oauth refresh works", AUTH_SMALL);
    expect(r.ran).toBe(false);
    expect(r.matchedFiles).toBe(0);
    expect(r.groundingUncertainty).toBe(false); // non-repo tasks never define a probe result
    expect(r.bucket).toBe("none");
  });

  it("auth-small: a small grounded target stays small (direct-eligible)", () => {
    const r = probeRepoGrounding("refactor src/auth/login.ts", AUTH_SMALL);
    expect(r.ran).toBe(true);
    expect(r.matchedFiles).toBe(1);
    expect(r.totalLoc).toBe(80);
    expect(r.groundingUncertainty).toBe(false);
    expect(r.bucket).toBe("small");
  });

  it("auth-large: many files / high LOC / broad spread → large + heavier", () => {
    const targets = AUTH_LARGE.map((h) => h.path).join(" ");
    const r = probeRepoGrounding(`refactor ${targets}`, AUTH_LARGE);
    expect(r.ran).toBe(true);
    expect(r.matchedFiles).toBe(47);
    expect(r.totalLoc).toBeGreaterThanOrEqual(8000);
    expect(r.matchedDirs).toBeGreaterThanOrEqual(4);
    expect(r.bucket).toBe("large");
  });

  it("auth-ghost: a named target that resolves to ZERO indexed files sets uncertainty", () => {
    const r = probeRepoGrounding("refactor src/auth/ghost.ts", AUTH_SMALL);
    expect(r.ran).toBe(true);
    expect(r.matchedFiles).toBe(0);
    expect(r.groundingUncertainty).toBe(true); // probe ran AND matchedFiles===0
    expect(r.bucket).toBe("none");
  });

  it("collision: a bare basename matching >1 indexed path sets uncertainty", () => {
    const hints = [
      { path: "src/auth/config.ts", lineCount: 50 },
      { path: "src/pil/config.ts", lineCount: 60 },
    ];
    const r = probeRepoGrounding("update config.ts everywhere", hints);
    expect(r.ran).toBe(true);
    expect(r.collision).toBe(true);
    expect(r.groundingUncertainty).toBe(true);
  });

  it("is monotonic: adding a matched large file never lowers the bucket", () => {
    const small = probeRepoGrounding("touch src/auth/login.ts", AUTH_SMALL);
    const bigger = probeRepoGrounding("touch src/auth/login.ts and src/ui/app.tsx", [
      ...AUTH_SMALL,
      { path: "src/ui/app.tsx", lineCount: 6200 },
    ]);
    const rank = { none: 0, small: 1, medium: 2, large: 3 } as const;
    expect(rank[bigger.bucket]).toBeGreaterThanOrEqual(rank[small.bucket]);
  });
});
