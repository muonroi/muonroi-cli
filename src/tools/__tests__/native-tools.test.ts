import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import { getSelfVerifyJobManager } from "../../mcp/self-verify-runner.js";
import { SEMANTIC_HARNESS_PACKAGE } from "../../utils/semantic-harness.js";
import { NATIVE_MUONROI_TOOL_NAMES, registerNativeMuonroiTools } from "../native-tools.js";

const SELFVERIFY_TOOLS = NATIVE_MUONROI_TOOL_NAMES.filter((n) => n.startsWith("selfverify_"));

/** A throwaway repo-root workspace: bare, declaring the harness package, or vendoring it. */
function harnessWorkspace(kind: "none" | "dependency" | "vendored"): string {
  const dir = mkdtempSync(join(tmpdir(), "m13-harness-"));
  // A VCS root marker so detection stops here instead of walking into tmpdir's parents.
  mkdirSync(join(dir, ".git"));
  if (kind === "dependency")
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { [SEMANTIC_HARNESS_PACKAGE]: "^0.1.0" } }),
    );
  if (kind === "vendored") {
    mkdirSync(join(dir, "packages", "agent-harness-opentui"), { recursive: true });
    writeFileSync(join(dir, "packages", "agent-harness-opentui", "package.json"), "{}");
  }
  return dir;
}

async function exec(tools: ToolSet, name: string, args: unknown): Promise<string> {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return (await tool.execute(args, {})) as string;
}

describe("registerNativeMuonroiTools", () => {
  it.each(["", "none"])("rejects invalid tier1 fixture %j before starting a job", async (mockLlmDir) => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const start = vi.spyOn(getSelfVerifyJobManager(), "start").mockReturnValue("must-not-start");
    try {
      expect(await exec(tools, "selfverify_start", { mode: "tier1", mockLlmDir })).toContain("invalid_args");
      expect(start).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
    }
  });

  it("forwards the task workspace and exact file selection without widening the diff", async () => {
    const tools: ToolSet = {};
    const workspace = harnessWorkspace("dependency");
    registerNativeMuonroiTools(tools, { cwd: workspace });
    const start = vi.spyOn(getSelfVerifyJobManager(), "start").mockReturnValue("fixture-run");
    try {
      await exec(tools, "selfverify_start", { mode: "tier1", files: ["owned.ts"], emit: false });
      expect(start).toHaveBeenLastCalledWith(
        expect.objectContaining({ cwd: workspace, files: ["owned.ts"], emit: false }),
      );
      await exec(tools, "selfverify_start", { mode: "tier1", cwd: "/explicit/target", files: [] });
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/explicit/target", files: [] }));
    } finally {
      start.mockRestore();
    }
  });

  it("registers every muonroi-tools capability as a native builtin", () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    for (const name of NATIVE_MUONROI_TOOL_NAMES) {
      expect(tools[name], `missing native tool ${name}`).toBeDefined();
      expect(typeof (tools[name] as { execute?: unknown }).execute).toBe("function");
    }
    // ee_query stays the registry's own native tool — not duplicated here.
    expect(tools.ee_query).toBeUndefined();
  });

  it("registers selfverify_* only where a Semantic harness is detectable (M13)", () => {
    const bare: ToolSet = {};
    registerNativeMuonroiTools(bare, { cwd: harnessWorkspace("none") });
    for (const name of SELFVERIFY_TOOLS) expect(bare[name], name).toBeUndefined();
    // Every other native capability is unaffected by the gate.
    expect(bare.verification_run).toBeDefined();
    expect(bare.usage_forensics).toBeDefined();

    for (const kind of ["dependency", "vendored"] as const) {
      const tools: ToolSet = {};
      const nested = join(harnessWorkspace(kind), "src", "ui");
      mkdirSync(nested, { recursive: true });
      // Detection walks up from a nested cwd to the repository root.
      registerNativeMuonroiTools(tools, { cwd: nested });
      for (const name of SELFVERIFY_TOOLS) expect(tools[name], `${kind}: ${name}`).toBeDefined();
    }
  });

  it("setup_guide returns the shared guide text (no MCP round-trip)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const out = await exec(tools, "setup_guide", {});
    expect(out).toContain("muonroi-cli Setup Guide");
    expect(out).toContain("muonroi-cli doctor");
  });

  it("ee_feedback rejects a noise verdict with no reason (no network call)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const out = await exec(tools, "ee_feedback", { id: "abc", collection: "experience-behavioral", verdict: "noise" });
    expect(out).toMatch(/reason_required/);
  });

  it("ee_feedback validates required args", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "ee_feedback", { verdict: "followed" })).toMatch(/invalid_args/);
  });

  it("ee_write rejects a too-short lesson (no network call)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "ee_write", { lesson: "oops" })).toMatch(/invalid_args/);
    expect(await exec(tools, "ee_write", {})).toMatch(/invalid_args/);
  });

  it("selfverify_status returns not_found for an unknown runId (shared JobManager)", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    const out = await exec(tools, "selfverify_status", { runId: "does-not-exist" });
    expect(out).toMatch(/not_found/);
  });

  it("selfverify_start rejects agentic mode without goal+llm", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "selfverify_start", { mode: "agentic" })).toMatch(/invalid_args/);
  });

  it("usage_forensics rejects an empty prefix without touching the DB", async () => {
    const tools: ToolSet = {};
    registerNativeMuonroiTools(tools);
    expect(await exec(tools, "usage_forensics", { prefix: "  " })).toMatch(/invalid_args/);
    expect(await exec(tools, "usage_forensics", { prefix: "fixture", until: "invalid-date" })).toMatch(/invalid_args/);
    expect(await exec(tools, "usage_forensics", { prefix: "fixture", error_offset: -1 })).toMatch(/invalid_args/);
  });
});
