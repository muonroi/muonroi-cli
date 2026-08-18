import { describe, expect, it } from "vitest";
import { quoteForCmd, resolveSpawnTarget } from "./spawn-target.js";

const WIN = "win32" as NodeJS.Platform;
const NIX = "linux" as NodeJS.Platform;

describe("resolveSpawnTarget", () => {
  it("passes a real executable straight through on Windows", () => {
    expect(resolveSpawnTarget("node.exe", ["--version"], WIN)).toEqual({
      command: "node.exe",
      args: ["--version"],
      verbatim: false,
    });
  });

  // A POSIX host has no .cmd shims and no Node spawn guard to work around.
  it("never wraps on a non-Windows platform, even for a .cmd name", () => {
    expect(resolveSpawnTarget("weird.cmd", ["--stdio"], NIX)).toEqual({
      command: "weird.cmd",
      args: ["--stdio"],
      verbatim: false,
    });
  });

  // The actual bug: spawn() throws EINVAL on a .cmd since CVE-2024-27980.
  it("routes a .cmd shim through cmd.exe", () => {
    const t = resolveSpawnTarget("typescript-language-server.cmd", ["--stdio"], WIN, "C:\\Windows\\cmd.exe");
    expect(t.command).toBe("C:\\Windows\\cmd.exe");
    expect(t.verbatim).toBe(true);
    expect(t.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(t.args[3]).toBe('"typescript-language-server.cmd --stdio"');
  });

  it("routes a .bat shim too, case-insensitively", () => {
    expect(resolveSpawnTarget("server.BAT", [], WIN).verbatim).toBe(true);
  });

  it("reads ComSpec when no shell is passed", () => {
    const prev = process.env.ComSpec;
    process.env.ComSpec = "D:\\alt\\cmd.exe";
    try {
      expect(resolveSpawnTarget("x.cmd", [], WIN).command).toBe("D:\\alt\\cmd.exe");
    } finally {
      if (prev === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = prev;
    }
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    const prev = process.env.ComSpec;
    delete process.env.ComSpec;
    try {
      expect(resolveSpawnTarget("x.cmd", [], WIN).command).toBe("cmd.exe");
    } finally {
      if (prev !== undefined) process.env.ComSpec = prev;
    }
  });

  // The reason we quote at all: cmd.exe /c takes ONE string, so an unquoted
  // "C:\Program Files\..." would split into two tokens and fail to launch.
  it("quotes a command path containing spaces", () => {
    const t = resolveSpawnTarget("C:\\Program Files\\ls\\server.cmd", ["--stdio"], WIN);
    expect(t.args[3]).toBe('""C:\\Program Files\\ls\\server.cmd" --stdio"');
  });

  it("quotes an argument containing spaces or shell metacharacters", () => {
    const t = resolveSpawnTarget("s.cmd", ["--root", "C:\\a b", "--flag=x&y"], WIN);
    expect(t.args[3]).toBe('"s.cmd --root "C:\\a b" "--flag=x&y""');
  });

  it("defaults args to empty", () => {
    expect(resolveSpawnTarget("node", undefined, NIX).args).toEqual([]);
  });
});

describe("quoteForCmd", () => {
  it("leaves a plain token unquoted so process listings stay readable", () => {
    expect(quoteForCmd("--stdio")).toBe("--stdio");
    expect(quoteForCmd("C:\\tools\\server.cmd")).toBe("C:\\tools\\server.cmd");
  });

  it("quotes whitespace and every cmd.exe metacharacter", () => {
    expect(quoteForCmd("a b")).toBe('"a b"');
    for (const ch of ["&", "|", "<", ">", "^", "(", ")", "%", "!"]) {
      expect(quoteForCmd(`x${ch}y`)).toBe(`"x${ch}y"`);
    }
  });

  it("doubles an embedded quote, the cmd.exe escape", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  // An empty arg must survive as an empty token, not disappear.
  it("renders an empty token as an explicit empty pair", () => {
    expect(quoteForCmd("")).toBe('""');
  });
});
