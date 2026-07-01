import { describe, expect, it } from "vitest";
import { allLoopHostPoints } from "../gsd-runtime.js";
import { createDefaultHostAdapter } from "../host-adapter.js";

describe("host-adapter", () => {
  it("registers core loop points from gsd-core contract", () => {
    const adapter = createDefaultHostAdapter();
    const contractPoints = allLoopHostPoints();
    for (const point of ["discuss:post", "plan:post", "execute:post", "verify:post"]) {
      expect(contractPoints).toContain(point);
      expect(adapter.registeredPoints()).toContain(point);
    }
    expect(adapter.registeredPoints()).toContain("plan-review:post");
  });

  it("contract has 12 loop host points", () => {
    expect(allLoopHostPoints().length).toBe(12);
  });
});
