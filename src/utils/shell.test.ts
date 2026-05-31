import { describe, expect, it } from "vitest";
import { _resetResolvedShellCache, classifyShellBinary, posixToNative, resolveShell } from "./shell";

describe("classifyShellBinary", () => {
  it("classifies pwsh.exe as PowerShell, NOT bash (regression: 'pwsh.exe' ends with 'sh.exe')", () => {
    // BUG: the bash branch matched `endsWith('sh.exe')`, which also matches
    // `pwsh.exe`. A user setting MUONROI_SHELL=.../pwsh.exe was misclassified
    // as POSIX bash, so the agent was told to use POSIX syntax while the tool
    // actually spawned PowerShell — every sed/grep/ls then failed.
    const r = classifyShellBinary("C:/Program Files/PowerShell/7/pwsh.exe");
    expect(r.kind).toBe("powershell");
    expect(r.isPosix).toBe(false);
  });

  it("classifies powershell.exe as PowerShell", () => {
    const r = classifyShellBinary("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(r.kind).toBe("powershell");
    expect(r.isPosix).toBe(false);
  });

  it("still classifies a genuine POSIX sh/bash correctly", () => {
    expect(classifyShellBinary("C:/Program Files/Git/bin/bash.exe").kind).toBe("bash");
    expect(classifyShellBinary("/bin/sh").kind).toBe("bash");
    expect(classifyShellBinary("/usr/bin/bash").kind).toBe("bash");
    expect(classifyShellBinary("C:/msys64/usr/bin/sh.exe").kind).toBe("bash");
  });

  it("classifies cmd.exe and wsl.exe", () => {
    expect(classifyShellBinary("C:/Windows/System32/cmd.exe").kind).toBe("cmd");
    expect(classifyShellBinary("C:/Windows/System32/wsl.exe").kind).toBe("wsl");
  });
});

describe("posixToNative", () => {
  it("translates /<letter>/path to <Letter>:\\path on Windows", () => {
    if (process.platform !== "win32") {
      expect(posixToNative("/d/sources/x")).toBe("/d/sources/x");
      return;
    }
    expect(posixToNative("/d/sources/eBerth")).toBe("D:\\sources\\eBerth");
    expect(posixToNative("/c/Users/x/y")).toBe("C:\\Users\\x\\y");
  });

  it("handles drive root", () => {
    if (process.platform !== "win32") return;
    expect(posixToNative("/d")).toBe("D:\\");
  });

  it("passes through native paths unchanged", () => {
    expect(posixToNative("D:\\sources\\eBerth")).toBe("D:\\sources\\eBerth");
    expect(posixToNative("./relative")).toBe("./relative");
    expect(posixToNative("relative")).toBe("relative");
  });
});

describe("resolveShell", () => {
  it("returns POSIX-capable shell on non-Windows", () => {
    if (process.platform === "win32") return;
    _resetResolvedShellCache();
    const result = resolveShell({});
    expect(result.isPosix).toBe(true);
  });

  it("detects bash on Windows when available, otherwise falls back gracefully", () => {
    if (process.platform !== "win32") return;
    _resetResolvedShellCache();
    const result = resolveShell({ kind: "auto" });
    // Either we found a POSIX shell (bash/wsl) — preferred — or we fell through to cmd.
    expect(["bash", "wsl", "powershell", "cmd"]).toContain(result.kind);
    if (result.kind === "bash" || result.kind === "wsl") {
      expect(result.isPosix).toBe(true);
      expect(result.binary).toBeDefined();
    }
  });

  it("respects MUONROI_SHELL env override", () => {
    const original = process.env.MUONROI_SHELL;
    try {
      // Use a path we know exists across platforms — node binary itself.
      process.env.MUONROI_SHELL = process.execPath;
      _resetResolvedShellCache();
      const result = resolveShell({});
      expect(result.binary).toBe(process.execPath);
    } finally {
      if (original === undefined) delete process.env.MUONROI_SHELL;
      else process.env.MUONROI_SHELL = original;
      _resetResolvedShellCache();
    }
  });

  it("respects explicit settings.path when it exists", () => {
    _resetResolvedShellCache();
    const result = resolveShell({ path: process.execPath });
    expect(result.binary).toBe(process.execPath);
  });

  it("ignores explicit settings.path that does not exist", () => {
    _resetResolvedShellCache();
    const result = resolveShell({ path: "/definitely/not/a/real/shell/binary" });
    expect(result.binary).not.toBe("/definitely/not/a/real/shell/binary");
  });
});
