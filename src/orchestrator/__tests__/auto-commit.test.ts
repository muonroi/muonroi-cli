import { describe, expect, it } from "vitest";
import {
  buildAutoCommitSubject,
  isAutoCommitEnabled,
  isCliArtifactPath,
  isExcludedPath,
  isSensitivePath,
  parsePorcelainPaths,
} from "../auto-commit.js";

describe("auto-commit pure helpers", () => {
  it("parses porcelain output incl. rename + quoted paths", () => {
    const out = ' M src/a.ts\n?? new file.txt\nR  old.ts -> src/b.ts\nA  "with space.ts"\n';
    const set = parsePorcelainPaths(out);
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("new file.txt")).toBe(true);
    // rename keeps ONLY the new path
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.has("old.ts")).toBe(false);
    // quoted path with a space is unquoted
    expect(set.has("with space.ts")).toBe(true);
  });

  it("flags sensitive paths and lets normal source through", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath("config/app.key")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath("src/db-secret.ts")).toBe(true);
    // .muonroi-cli/ is categorized as a CLI artifact (excluded), not a "secret".
    expect(isSensitivePath(".muonroi-cli/state.json")).toBe(false);
    expect(isExcludedPath(".muonroi-cli/state.json")).toBe(true);
    expect(isSensitivePath("src/index.ts")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
  });

  it("excludes CLI-generated artifacts + build junk (the 11-file-leak fix)", () => {
    expect(isCliArtifactPath(".muonroi-flow/state.md")).toBe(true);
    expect(isCliArtifactPath(".muonroi-flow/runs/abc/manifest.md")).toBe(true);
    expect(isCliArtifactPath(".muonroi-cli/session.db")).toBe(true);
    expect(isCliArtifactPath(".muonroi-harness-roots.json")).toBe(true);
    expect(isCliArtifactPath("node_modules/x/index.js")).toBe(true);
    expect(isCliArtifactPath("dist/bundle.js")).toBe(true);
    expect(isCliArtifactPath("debug.log")).toBe(true);
    expect(isCliArtifactPath("src/greeting.txt")).toBe(false);
    // isExcludedPath unions secrets + artifacts
    expect(isExcludedPath(".env")).toBe(true);
    expect(isExcludedPath(".muonroi-flow/state.md")).toBe(true);
    expect(isExcludedPath("greeting.txt")).toBe(false);
  });

  it("builds a bounded conventional subject", () => {
    expect(buildAutoCommitSubject("add a login form", 2)).toBe("chore: add a login form");
    expect(buildAutoCommitSubject("x".repeat(300), 1).length).toBeLessThanOrEqual(72);
    expect(buildAutoCommitSubject("", 3)).toContain("agent changes");
    // strips backticks/quotes that could break the -m argument intent
    expect(buildAutoCommitSubject('fix `foo` "bar"', 1)).not.toMatch(/[`"]/);
  });

  it("is disabled under the unit-test runner so the suite never commits", () => {
    // VITEST is set while this runs → must be false regardless of MUONROI_AUTO_COMMIT.
    expect(isAutoCommitEnabled()).toBe(false);
  });
});
