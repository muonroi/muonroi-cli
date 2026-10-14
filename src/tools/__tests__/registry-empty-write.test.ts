/**
 * Mutating tools must never run on missing/blank arguments.
 *
 * Two layers cover this and both are pinned here:
 *  1. The generic executor guard (`src/tools/arg-guard.ts`), installed over
 *     every builtin, catches MISSING keys — it now answers `{}` before the
 *     tool's own check ever runs.
 *  2. The per-tool checks inside `write_file` / `edit_file` still own
 *     BLANK-string semantics, which the generic layer deliberately does not
 *     touch (an empty `content` is a legal way to create an empty file).
 */

import { describe, expect, it } from "vitest";
import { BashTool } from "../bash.js";
import { createBuiltinTools } from "../registry.js";

interface Exec {
  execute: (input: Record<string, unknown>) => Promise<{ success: boolean; output: string }>;
}

describe("registry empty write_file guard", () => {
  it("blocks write_file with empty args", async () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent");
    const wf = tools.write_file as unknown as Exec;
    const result = await wf.execute({});
    expect(result.success).toBe(false);
    expect(result.output).toContain("BLOCKED (missing-required-args)");
    expect(result.output).toContain("file_path");
    expect(result.output).toContain("content");
  });

  it("blocks edit_file with missing fields", async () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent");
    const ef = tools.edit_file as unknown as Exec;
    const result = await ef.execute({ file_path: "x.ts" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("BLOCKED (missing-required-args)");
    expect(result.output).toContain("old_string");
    expect(result.output).toContain("new_string");
  });

  it("still blocks a blank-string file_path via the per-tool guard", async () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent");
    const wf = tools.write_file as unknown as Exec;
    // Every key is PRESENT, so the generic presence guard passes and the
    // tool's own emptiness check is what must stop this.
    const result = await wf.execute({ file_path: "   ", content: "x" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty-write_file");
  });

  it("still blocks a blank-string file_path in edit_file via the per-tool guard", async () => {
    process.env.MUONROI_GSD_NATIVE = "0";
    const tools = createBuiltinTools(new BashTool(process.cwd()), "agent");
    const ef = tools.edit_file as unknown as Exec;
    const result = await ef.execute({ file_path: "  ", old_string: "a", new_string: "b" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("empty-edit_file");
  });
});
