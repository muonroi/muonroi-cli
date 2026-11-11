import { describe, expect, it } from "vitest";
import { resolveRoutingPolicy } from "./policy.js";

describe("main routing policy ownership", () => {
  it("preserves a project model pin even when user settings enable auto", () => {
    expect(resolveRoutingPolicy({ model: "fixture-model" }, "auto")).toEqual({
      mode: "fixed",
      source: "project-model-pin",
    });
  });
  it("lets an explicit project mode use the project model as its baseline", () => {
    expect(resolveRoutingPolicy({ model: "fixture-model", routingMode: "auto" }, "fixed")).toEqual({
      mode: "auto",
      source: "project",
    });
  });
  it("defaults unpinned sessions to auto and honors user suggest", () => {
    expect(resolveRoutingPolicy({})).toEqual({ mode: "auto", source: "default" });
    expect(resolveRoutingPolicy({}, "suggest")).toEqual({ mode: "suggest", source: "user" });
  });
  it("does not unlock a pin for an invalid persisted mode", () => {
    expect(resolveRoutingPolicy({ model: "fixture-model", routingMode: "bad" as never }, "auto").mode).toBe("fixed");
  });
});
