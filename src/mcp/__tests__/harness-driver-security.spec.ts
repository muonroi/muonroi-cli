import { homedir } from "node:os";
import {
  buildChildEnv,
  sanitizeEnv,
  validateCwd,
  validateMockLlmPath,
  validateStartArgs,
} from "@muonroi/agent-harness-core/mcp-server";
import { describe, expect, it } from "vitest";

describe("validateStartArgs (argv allowlist)", () => {
  it("accepts --agent-* flags", () => {
    expect(validateStartArgs(["--agent-mode", "--agent-cols=80"])).toEqual({ ok: true });
  });
  it("accepts --mock-llm", () => {
    expect(validateStartArgs(["--mock-llm=fix/"])).toEqual({ ok: true });
  });
  it("rejects --require", () => {
    expect(validateStartArgs(["--require", "evil.js"])).toMatchObject({ ok: false });
  });
  it("rejects --preload", () => {
    expect(validateStartArgs(["--preload=evil"])).toMatchObject({ ok: false });
  });
  it("rejects --eval", () => {
    expect(validateStartArgs(["--eval", "x"])).toMatchObject({ ok: false });
  });
});

describe("sanitizeEnv", () => {
  it("strips NODE_OPTIONS / BUN_OPTIONS / LD_PRELOAD", () => {
    const e = sanitizeEnv({ NODE_OPTIONS: "x", BUN_OPTIONS: "y", LD_PRELOAD: "z", FOO: "ok" });
    expect(e).toEqual({ FOO: "ok" });
  });
  it("strips LD_AUDIT / DYLD_FRAMEWORK_PATH / NODE_PATH (v1.1 expansion)", () => {
    const e = sanitizeEnv({ LD_AUDIT: "a", DYLD_FRAMEWORK_PATH: "b", NODE_PATH: "c", KEEP: "ok" });
    expect(e).toEqual({ KEEP: "ok" });
  });
  it("rejects keys with bad chars", () => {
    const e = sanitizeEnv({ "ok=A": "x", "BAD-KEY": "y", GOOD: "z" });
    expect(e).toEqual({ GOOD: "z" });
  });
});

describe("buildChildEnv (tui.start child env)", () => {
  // Regression: a child spawned with a partial env that lacks PATH makes bun
  // drop the fd 3/4 stdio channels → null inWrite → driver spawn crash. The
  // child env MUST retain PATH from the driver's process env even when the
  // caller passes only its own keys.
  it("retains PATH from the base env when the caller passes a partial env", () => {
    const base = { PATH: "/usr/bin:/bin", HOME: "/home/x" };
    const e = buildChildEnv({ MUONROI_HARNESS_EVENT_LOG: "/tmp/e.jsonl" }, base);
    expect(e.PATH).toBe("/usr/bin:/bin");
    expect(e.MUONROI_HARNESS_EVENT_LOG).toBe("/tmp/e.jsonl");
  });
  it("still strips dangerous vars inherited from the base env", () => {
    const base = { PATH: "/bin", NODE_OPTIONS: "--require evil", LD_PRELOAD: "x.so" };
    const e = buildChildEnv({}, base);
    expect(e.PATH).toBe("/bin");
    expect(e.NODE_OPTIONS).toBeUndefined();
    expect(e.LD_PRELOAD).toBeUndefined();
  });
  it("lets the caller override a base key", () => {
    const e = buildChildEnv({ FOO: "caller" }, { PATH: "/bin", FOO: "base" });
    expect(e.FOO).toBe("caller");
  });
});

describe("validateCwd", () => {
  it("accepts home directory", () => {
    expect(validateCwd(homedir())).toEqual({ ok: true });
  });
  it("accepts current repo root", () => {
    expect(validateCwd(process.cwd())).toEqual({ ok: true });
  });
  it("rejects path outside home and repo", () => {
    // Pick a path guaranteed to be outside home + repo. Use the OS root.
    const root = process.platform === "win32" ? "C:\\" : "/";
    const v = validateCwd(root);
    expect(v.ok).toBe(false);
  });
});

describe("validateMockLlmPath", () => {
  it("accepts a path inside repo root", () => {
    expect(validateMockLlmPath("tests/harness/fixtures/llm")).toBe(true);
  });
  it("rejects path escaping repo root with ..", () => {
    expect(validateMockLlmPath("../../etc")).toBe(false);
  });
  it("rejects absolute path outside repo", () => {
    const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
    expect(validateMockLlmPath(outside)).toBe(false);
  });
});
