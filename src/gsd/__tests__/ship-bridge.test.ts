import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planningArtifact } from "../paths.js";
import { runTaskShip } from "../ship-bridge.js";

describe("ship-bridge", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-ship-"));
    mkdirSync(join(tmp, ".planning"), { recursive: true });
    writeFileSync(planningArtifact(tmp, "PLAN.md"), "# Counter widget\n\n1. Build\n", "utf8");
    writeFileSync(planningArtifact(tmp, "VERIFY.md"), "verdict: pass\n\nbun test ok\n", "utf8");
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("runTaskShip writes SHIP.md with plan title", () => {
    const result = runTaskShip({ cwd: tmp, notes: ["done"] });
    expect(result.ok).toBe(true);
    expect(existsSync(planningArtifact(tmp, "SHIP.md"))).toBe(true);
    const ship = readFileSync(planningArtifact(tmp, "SHIP.md"), "utf8");
    expect(ship).toContain("Counter widget");
    expect(ship).toContain("bun test ok");
  });
});
