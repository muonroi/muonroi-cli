import { describe, expect, it } from "vitest";
import { canonicalizeBashCommand, hashToolArgs } from "./tool-args-hash.js";

describe("canonicalizeBashCommand", () => {
  it("strips trailing pipe + tail/head/grep", () => {
    expect(canonicalizeBashCommand("bunx vitest run | tail -20")).toBe("bunx vitest run");
    expect(canonicalizeBashCommand("bunx vitest run | head -10")).toBe("bunx vitest run");
    expect(canonicalizeBashCommand("bunx vitest run | grep FAIL")).toBe("bunx vitest run");
  });

  it("strips stderr merge + redirect", () => {
    expect(canonicalizeBashCommand("bunx vitest run 2>&1 | tail -5")).toBe("bunx vitest run");
    expect(canonicalizeBashCommand("bunx vitest run > /tmp/out.log")).toBe("bunx vitest run");
    expect(canonicalizeBashCommand("bunx vitest run >> /tmp/out.log")).toBe("bunx vitest run");
  });

  it("strips leading cd && prefix", () => {
    expect(canonicalizeBashCommand("cd /d/Personal/Core/muonroi-cli && bunx vitest run | tail -5")).toBe(
      "bunx vitest run",
    );
    expect(canonicalizeBashCommand('cd "D:/Personal/Core/muonroi-cli" && bunx vitest')).toBe("bunx vitest");
  });

  it("collapses whitespace", () => {
    expect(canonicalizeBashCommand("bunx    vitest   run")).toBe("bunx vitest run");
  });

  it("does not strip when no redirection present", () => {
    expect(canonicalizeBashCommand("git status")).toBe("git status");
  });
});

describe("hashToolArgs", () => {
  it("collapses cosmetic bash variations to one hash", () => {
    const variants = [
      { command: "bunx vitest run | tail -20" },
      { command: "bunx vitest run | head -10" },
      { command: "bunx vitest run 2>&1 | grep FAIL" },
      { command: "bunx vitest run > /tmp/out.log" },
      { command: "cd /d/Personal/Core/muonroi-cli && bunx vitest run | tail -5" },
    ];
    const hashes = new Set(variants.map((v) => hashToolArgs("bash", v)));
    expect(hashes.size).toBe(1);
  });

  it("distinguishes substantively different bash commands", () => {
    const a = hashToolArgs("bash", { command: "bunx vitest run" });
    const b = hashToolArgs("bash", { command: "bunx tsc --noEmit" });
    expect(a).not.toBe(b);
  });

  it("hashes non-bash tools by stable JSON of args", () => {
    const a = hashToolArgs("read_file", { file_path: "a.ts", start_line: 1 });
    const b = hashToolArgs("read_file", { start_line: 1, file_path: "a.ts" });
    expect(a).toBe(b);
  });

  it("different args produce different hashes for same tool", () => {
    const a = hashToolArgs("read_file", { file_path: "a.ts" });
    const b = hashToolArgs("read_file", { file_path: "b.ts" });
    expect(a).not.toBe(b);
  });

  it("hash is namespaced by tool name", () => {
    const a = hashToolArgs("bash", { command: "x" });
    const b = hashToolArgs("read_file", { command: "x" });
    expect(a.startsWith("bash:")).toBe(true);
    expect(b.startsWith("read_file:")).toBe(true);
    expect(a).not.toBe(b);
  });
});
