import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLinkFreeBelow } from "../link-free-path.js";

// Directory links need no privilege anywhere: a junction on Windows, a symlink
// elsewhere. This reproduces macOS's /var -> /private/var tmpdir on every OS.
const linkDir = (target: string, link: string) =>
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "link-free-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("isLinkFreeBelow", () => {
  it("accepts a real path reached through a linked ANCESTOR of the anchor", () => {
    const real = join(base, "real");
    mkdirSync(join(real, "jobs", "job.review", "evidence"), { recursive: true });
    writeFileSync(join(real, "jobs", "job.review", "evidence", "a.json"), "{}");
    linkDir(real, join(base, "alias"));
    const anchor = join(base, "alias", "jobs");
    expect(isLinkFreeBelow(anchor, join(anchor, "job.review"))).toBe(true);
    expect(isLinkFreeBelow(anchor, join(anchor, "job.review", "evidence", "a.json"))).toBe(true);
    expect(isLinkFreeBelow(anchor, anchor)).toBe(true);
  });

  it("refuses a link at or below the anchor even when the ancestor is linked too", () => {
    const real = join(base, "real");
    const outside = join(base, "outside");
    mkdirSync(join(real, "jobs"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "a.json"), "{}");
    linkDir(outside, join(real, "jobs", "job.review"));
    linkDir(real, join(base, "alias"));
    for (const anchor of [join(real, "jobs"), join(base, "alias", "jobs")]) {
      expect(isLinkFreeBelow(anchor, join(anchor, "job.review"))).toBe(false);
      expect(isLinkFreeBelow(anchor, join(anchor, "job.review", "a.json"))).toBe(false);
    }
  });

  it("refuses targets outside the anchor and throws for a missing target", () => {
    mkdirSync(join(base, "jobs"));
    mkdirSync(join(base, "other"));
    expect(isLinkFreeBelow(join(base, "jobs"), join(base, "other"))).toBe(false);
    expect(isLinkFreeBelow(join(base, "jobs"), join(base, "jobs", "..", "other"))).toBe(false);
    expect(() => isLinkFreeBelow(join(base, "jobs"), join(base, "jobs", "missing"))).toThrow();
  });
});
