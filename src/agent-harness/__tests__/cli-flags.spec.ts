import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("--agent-mode CLI flag registration", () => {
  it("--help output contains --agent-mode flag", () => {
    // Use 'bun run' to run the TypeScript entry-point directly.
    const result = spawnSync("bun", ["run", "src/index.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("--agent-mode");
  });

  it("--help output contains --agent-cols flag", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("--agent-cols");
  });

  it("--help output contains --agent-idle-ms flag", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    expect(output).toContain("--agent-idle-ms");
  });
});
