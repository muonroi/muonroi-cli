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
  // Phase 5 BUG-F+G: verification commands now return `verify:` sentinel
  // hashes with a per-call nonce so they NEVER collide with each other (each
  // re-run of typecheck is a fresh progress marker, not a loop signal).
  // We pick a non-verification cosmetic-variant set (npm-style install) to
  // assert the original collapse behaviour still works.
  it("collapses cosmetic bash variations to one hash (non-verification)", () => {
    const variants = [
      { command: "bun add zod | tail -20" },
      { command: "bun add zod 2>&1" },
      { command: "bun add zod > /tmp/out.log" },
      { command: "cd /d/Personal/Core/muonroi-cli && bun add zod" },
    ];
    const hashes = new Set(variants.map((v) => hashToolArgs("bash", v)));
    expect(hashes.size).toBe(1);
  });

  // Verification commands NEVER collide — every call must return a unique hash
  // so the pattern detector skips them (edit→typecheck→fix is normal work).
  it("verification commands produce unique hashes per call", () => {
    const a = hashToolArgs("bash", { command: "bunx vitest run | tail -20" });
    const b = hashToolArgs("bash", { command: "bunx vitest run | head -10" });
    expect(a).not.toBe(b);
    expect(a.startsWith("verify:")).toBe(true);
    expect(b.startsWith("verify:")).toBe(true);
  });

  it("distinguishes substantively different non-verify bash commands", () => {
    const a = hashToolArgs("bash", { command: "git status" });
    const b = hashToolArgs("bash", { command: "git log -5" });
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

  it("collapses edit_file calls on same file regardless of old/new string", () => {
    // Real session 39884b072b5f scenario — agent edited the same file 7 times
    // with different old_string each attempt. Generic JSON hash kept them
    // distinct; the dedicated file_path hash now collapses them.
    const variants = [
      { file_path: "src/ee/export.ts", old_string: "@ts-expect-error", new_string: "@ts-ignore" },
      { file_path: "src/ee/export.ts", old_string: "  @ts-expect-error", new_string: "// @ts-ignore" },
      { file_path: "src/ee/export.ts", old_string: "    const mod", new_string: "// @ts-ignore\n    const mod" },
    ];
    const hashes = new Set(variants.map((v) => hashToolArgs("edit_file", v)));
    expect(hashes.size).toBe(1);
  });

  it("distinguishes edit_file on different files", () => {
    const a = hashToolArgs("edit_file", { file_path: "src/a.ts", old_string: "x", new_string: "y" });
    const b = hashToolArgs("edit_file", { file_path: "src/b.ts", old_string: "x", new_string: "y" });
    expect(a).not.toBe(b);
  });

  it("normalizes path separators (D:\\foo vs D:/foo collapse)", () => {
    const win = hashToolArgs("edit_file", { file_path: "D:\\Personal\\Core\\file.ts", old_string: "x" });
    const posix = hashToolArgs("edit_file", { file_path: "D:/Personal/Core/file.ts", old_string: "x" });
    expect(win).toBe(posix);
  });

  it("write_file uses same file-path hash as edit_file (cross-tool overwrite loops collapse separately)", () => {
    const e = hashToolArgs("edit_file", { file_path: "a.ts" });
    const w = hashToolArgs("write_file", { file_path: "a.ts" });
    // Same file, but namespaced by tool — overwrite-loop and edit-loop are
    // tracked separately so a legitimate "edit then verify-via-write" doesn't
    // trip the guard, but 5 repeated write_file does.
    expect(e).not.toBe(w);
    expect(e.startsWith("edit_file:")).toBe(true);
    expect(w.startsWith("write_file:")).toBe(true);
  });
});
