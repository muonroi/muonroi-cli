/**
 * Plan 23-fix — focused tests for installBBTemplates exit-code detection.
 *
 * Background: `dotnet new install` on some SDKs prints warnings about stale
 * template paths (Failed to scan D:\...) and exits non-zero EVEN WHEN the
 * install succeeded. The fix treats stdout containing "Success:" as success
 * regardless of exit status. Without this, the TUI claimed "template could
 * not be applied" + a misleading "requires SDK X.0+; you have Y.Y.YYY" line
 * — observed in production session 36798f9c33fd (machine had SDK 9.0.313,
 * template required 9.0).
 */
import { describe, expect, it, vi } from "vitest";

const stubResult = (over: Partial<{ status: number; stdout: string; stderr: string }>) => ({
  status: 0,
  stdout: "",
  stderr: "",
  pid: 0,
  output: [],
  signal: null,
  ...over,
});

let MOCK_INSTALL_RESULT: ReturnType<typeof stubResult> = stubResult({});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: (cmd: string, args: string[]) => {
      if (cmd === "dotnet" && args[0] === "new" && args[1] === "install") {
        return MOCK_INSTALL_RESULT;
      }
      return stubResult({ status: 1, stderr: "unhandled" });
    },
  };
});

import { installBBTemplates } from "../init-new.js";

describe("installBBTemplates — Plan 23-fix exit code detection", () => {
  it("returns true when status === 0 (normal success)", () => {
    MOCK_INSTALL_RESULT = stubResult({
      status: 0,
      stdout: "Success: Muonroi.BaseTemplate::1.0.0-alpha.3 installed the following templates:\n",
    });
    expect(installBBTemplates(["Muonroi.BaseTemplate"])).toBe(true);
  });

  it("returns true when status !== 0 but stdout has 'Success:' (stale scan-warning case)", () => {
    // This is the exact failure mode from session 36798f9c33fd — dotnet emits
    // "Warning: Failed to scan D:\Personal\Project\..." for stale template
    // references, returns status=1, but the install itself succeeded.
    MOCK_INSTALL_RESULT = stubResult({
      status: 1,
      stdout:
        "The following template packages will be installed:\n   Muonroi.BaseTemplate::1.0.0-alpha.3\n" +
        "Warning: Failed to scan D:\\Personal\\Project\\Muonroi.BaseTemplate.\n" +
        "Success: Muonroi.BaseTemplate::1.0.0-alpha.3 installed the following templates:\n",
      stderr: "stale scan warnings",
    });
    expect(installBBTemplates(["Muonroi.BaseTemplate"])).toBe(true);
  });

  it("returns true when stdout contains 'is already installed' (legacy idempotency)", () => {
    MOCK_INSTALL_RESULT = stubResult({
      status: 1,
      stdout: "Muonroi.BaseTemplate::1.0.0-alpha.3 is already installed.\n",
    });
    expect(installBBTemplates(["Muonroi.BaseTemplate"])).toBe(true);
  });

  it("returns true when status === 106 (legacy already-installed code)", () => {
    MOCK_INSTALL_RESULT = stubResult({ status: 106, stdout: "" });
    expect(installBBTemplates(["Muonroi.BaseTemplate"])).toBe(true);
  });

  it("returns false on genuine failure (non-zero status, no Success marker)", () => {
    MOCK_INSTALL_RESULT = stubResult({
      status: 1,
      stdout: "NU1101: Unable to find package Muonroi.BaseTemplate.\n",
      stderr: "package not found",
    });
    expect(installBBTemplates(["Muonroi.BaseTemplate"])).toBe(false);
  });
});
