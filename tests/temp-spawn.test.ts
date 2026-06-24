import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";

describe("temp spawn test", () => {
  it("spawn returns an object with a kill method", () => {
    const p = spawn("bun", ["--version"]);
    expect(typeof p.kill).toBe("function");
    p.kill();
  });
});
