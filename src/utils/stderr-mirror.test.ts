/**
 * B5 (G4) — the TUI stderr tee.
 *
 * The load-bearing property is NOT "it captures everything" (it cannot: a
 * native V8/JSC fatal never passes through `process.stderr.write` — see the
 * module header). It is that the tee is TRANSPARENT: the bytes reaching the
 * terminal must be byte-identical with the mirror installed, because the reason
 * stderr is off-limits under OpenTUI is framebuffer corruption.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bestEffortRemoveSync } from "../__test-stubs__/cleanup";
import {
  __resetStderrMirrorForTests,
  installStderrMirror,
  isStderrMirrorEnabled,
  isStderrMirrorInstalled,
  restoreStderrMirror,
  setStderrMirrorFailureSink,
  stderrMirrorPath,
} from "./stderr-mirror.js";

let tmpDir: string;
let mirrorFile: string;
let seenByTerminal: string[];
let realWrite: typeof process.stderr.write;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-stderr-mirror-"));
  mirrorFile = path.join(tmpDir, "tui-stderr.log");
  process.env.MUONROI_TUI_STDERR_MIRROR_FILE = mirrorFile;
  delete process.env.MUONROI_TUI_STDERR_MIRROR;
  __resetStderrMirrorForTests();

  // Stand in for the terminal so the suite's own output is not polluted.
  seenByTerminal = [];
  realWrite = process.stderr.write;
  // biome-ignore lint/suspicious/noExplicitAny: test stub for Writable.write
  (process.stderr as any).write = (chunk: any): boolean => {
    seenByTerminal.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
});

afterEach(() => {
  __resetStderrMirrorForTests();
  // biome-ignore lint/suspicious/noExplicitAny: restoring the real writer
  (process.stderr as any).write = realWrite;
  delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
  delete process.env.MUONROI_TUI_STDERR_MIRROR;
  bestEffortRemoveSync(tmpDir, "src/utils/stderr-mirror.test.ts");
});

describe("stderr mirror", () => {
  it("is transparent: every byte still reaches the terminal, unchanged", () => {
    installStderrMirror();
    process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed\n");
    process.stderr.write(Buffer.from("second line\n", "utf8"));
    restoreStderrMirror();

    expect(seenByTerminal).toEqual(["FATAL ERROR: Reached heap limit Allocation failed\n", "second line\n"]);
  });

  it("captures what the alt-screen would have eaten", () => {
    installStderrMirror();
    process.stderr.write("[retry] rate-limited (429) — waiting 2s\n");
    restoreStderrMirror();

    const captured = fs.readFileSync(mirrorFile, "utf8");
    expect(captured).toContain("[retry] rate-limited (429)");
    // Each mirrored write is timestamped so a capture can be aligned with debug.log.
    expect(captured).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /);
  });

  it("restores the original writer, so nothing is mirrored once the TUI unmounts", () => {
    installStderrMirror();
    expect(isStderrMirrorInstalled()).toBe(true);
    restoreStderrMirror();
    expect(isStderrMirrorInstalled()).toBe(false);

    process.stderr.write("after unmount\n");
    const captured = fs.existsSync(mirrorFile) ? fs.readFileSync(mirrorFile, "utf8") : "";
    expect(captured).not.toContain("after unmount");
    expect(seenByTerminal).toContain("after unmount\n");
  });

  it("install is idempotent", () => {
    installStderrMirror();
    installStderrMirror();
    process.stderr.write("once\n");
    restoreStderrMirror();

    const lines = fs.readFileSync(mirrorFile, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    // and the terminal saw it exactly once too — no doubled output
    expect(seenByTerminal.filter((s) => s === "once\n")).toHaveLength(1);
  });

  it("fails open: an unwritable mirror mutes itself and still forwards to the terminal", () => {
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    process.env.MUONROI_TUI_STDERR_MIRROR_FILE = path.join(blocker, "nested", "tui-stderr.log");
    const failures: string[] = [];
    setStderrMirrorFailureSink((m) => failures.push(m));

    installStderrMirror();
    expect(() => process.stderr.write("still must reach the terminal\n")).not.toThrow();
    restoreStderrMirror();

    expect(seenByTerminal).toContain("still must reach the terminal\n");
    // No Silent Catch — routed to the sink, not to console.* (which would recurse).
    expect(failures.some((m) => m.includes("[stderr-mirror]"))).toBe(true);
  });

  it("honours the kill switch", () => {
    process.env.MUONROI_TUI_STDERR_MIRROR = "0";
    expect(isStderrMirrorEnabled()).toBe(false);
    installStderrMirror();
    expect(isStderrMirrorInstalled()).toBe(false);
    process.stderr.write("not mirrored\n");
    expect(fs.existsSync(mirrorFile)).toBe(false);
    expect(seenByTerminal).toContain("not mirrored\n");
  });

  it("defaults to <muonroi home>/tui-stderr.log, honouring MUONROI_CLI_HOME", () => {
    delete process.env.MUONROI_TUI_STDERR_MIRROR_FILE;
    // The resolver follows the repo-wide `MUONROI_CLI_HOME ?? homedir() +
    // "/.muonroi-cli"` convention. This test used to assert the raw
    // `os.homedir()` form with no mock, so it silently named the developer's
    // REAL log file — and would have gone red the moment the suite-wide pin
    // reached this module. Assert the convention instead, both branches.
    const saved = process.env.MUONROI_CLI_HOME;
    const pinned = path.join(os.tmpdir(), "stderr-mirror-home-probe");
    process.env.MUONROI_CLI_HOME = pinned;
    try {
      expect(stderrMirrorPath()).toBe(path.join(pinned, "tui-stderr.log"));
      delete process.env.MUONROI_CLI_HOME;
      expect(stderrMirrorPath()).toBe(path.join(os.homedir(), ".muonroi-cli", "tui-stderr.log"));
    } finally {
      if (saved === undefined) delete process.env.MUONROI_CLI_HOME;
      else process.env.MUONROI_CLI_HOME = saved;
    }
  });
});
