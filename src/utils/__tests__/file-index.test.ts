import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileIndex } from "../file-index.js";
import { logger } from "../logger.js";

let root: string;
function write(file: string) {
  const p = path.join(root, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "fixture");
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "file-index-windows-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("file suggestions without shell stderr", () => {
  it("indexes a non-Git directory with Unicode/spaces and excludes dependency/build/binary paths", async () => {
    for (const file of [
      "read me.ts",
      "đường dẫn/file.ts",
      "nested/app.ts",
      "node_modules/pkg/hidden.ts",
      ".git/config",
      "dist/bundle.js",
      "image.png",
    ])
      write(file);
    // .git would select the git branch; this fixture represents a non-Git folder.
    fs.rmSync(path.join(root, ".git"), { recursive: true });
    const index = new FileIndex(root);
    expect((await index.match("", 20)).sort()).toEqual(["read me.ts", "đường dẫn/file.ts", "nested/app.ts"].sort());
    expect(index.resolvePath("nested/app.ts")).toBe(path.join(root, "nested", "app.ts"));
  });
  it("preserves Git tracked/untracked/ignored semantics and NUL-delimited Unicode names", async () => {
    execFileSync("git", ["init", "-q", root], { stdio: "pipe", windowsHide: true });
    for (const file of [
      "tracked.ts",
      "đường dẫn.ts",
      " leading file.ts",
      "untracked.ts",
      "ignored/file.ts",
      "image.png",
    ])
      write(file);
    write(".gitignore");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    execFileSync("git", ["add", "--", "tracked.ts", "đường dẫn.ts", " leading file.ts"], {
      cwd: root,
      stdio: "pipe",
      windowsHide: true,
    });
    const found = await new FileIndex(root).match("", 20);
    expect(found).toContain("tracked.ts");
    expect(found).toContain("untracked.ts");
    expect(found).toContain("đường dẫn.ts");
    expect(found).toContain(" leading file.ts");
    expect(found).not.toContain("ignored/file.ts");
    expect(found).not.toContain("image.png");
  });
  it("does not follow directory links out of the workspace", async () => {
    write("outside/secret.ts");
    fs.mkdirSync(path.join(root, "inside"));
    fs.symlinkSync(
      path.join(root, "outside"),
      path.join(root, "inside", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await new FileIndex(path.join(root, "inside")).match("", 20)).toEqual([]);
  });
  it("logs a failed native directory read only to the file sink", async () => {
    const log = vi.spyOn(logger, "file").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fsp, "opendir").mockRejectedValue(new Error("fixture unreadable directory"));
    expect(await new FileIndex(root).match("", 20)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "ui",
      expect.any(String),
      expect.objectContaining({ error: "fixture unreadable directory" }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("captures Git errors for file-only logging instead of inheriting child stderr", async () => {
    fs.mkdirSync(path.join(root, ".git"));
    const log = vi.spyOn(logger, "file").mockImplementation(() => {});
    expect(await new FileIndex(root).match("", 20)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "ui",
      "[file-index] Git file listing failed",
      expect.objectContaining({ cwd: root, error: expect.stringContaining("git") }),
    );
  });
  it("caps fallback work at 5000 files without a head subprocess", async () => {
    const entries = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 5100; i++) yield { name: `file-${i}.ts`, isDirectory: () => false, isFile: () => true };
      },
    };
    vi.spyOn(fsp, "opendir").mockResolvedValue(entries as unknown as fs.Dir);
    const index = new FileIndex(root);
    await index.refresh();
    expect(index.size).toBe(5000);
  });
  it("coalesces overlapping refreshes and retains the TTL cache", async () => {
    write("app.ts");
    const open = vi.spyOn(fsp, "opendir");
    const index = new FileIndex(root);
    await Promise.all([index.match("app"), index.match("app")]);
    await index.match("app");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("does not let an older cwd refresh replace results for the new cwd", async () => {
    fs.mkdirSync(path.join(root, "new"));
    fs.writeFileSync(path.join(root, "new", "new.ts"), "fixture");
    const original = fsp.opendir.bind(fsp);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fsp, "opendir").mockImplementationOnce(async (p) => {
      await gate;
      return original(p);
    });
    const index = new FileIndex(root);
    const stale = index.refresh();
    index.updateCwd(path.join(root, "new"));
    await index.refresh();
    release();
    await stale;
    expect(await index.match("", 10)).toEqual(["new.ts"]);
  });
});
