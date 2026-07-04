import { describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { createBuiltinTools } from "../registry.js";

describe("registry empty write_file guard", () => {
  it("blocks write_file with empty args", async () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent");
    const wf = tools.write_file as unknown as {
      execute: (input: Record<string, unknown>) => Promise<{ success: boolean; output: string }>;
    };
    const result = await wf.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty-write_file");
  });

  it("blocks edit_file with missing fields", async () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent");
    const ef = tools.edit_file as unknown as {
      execute: (input: Record<string, unknown>) => Promise<{ success: boolean; output: string }>;
    };
    const result = await ef.execute({ file_path: "x.ts" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty-edit_file");
  });
});
