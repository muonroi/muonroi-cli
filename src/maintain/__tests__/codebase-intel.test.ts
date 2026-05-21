/**
 * codebase-intel.test.ts — Unit tests for gatherCodebaseIntel + helpers.
 * Uses tmpdir for all fs operations — never touches the real workspace.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractKeywords, gatherCodebaseIntel } from "../codebase-intel.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-codebase-intel-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe("extractKeywords", () => {
  it("strips English stopwords", () => {
    const kws = extractKeywords("fix the login redirect bug in the auth module");
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("in");
    expect(kws).toContain("login");
    expect(kws).toContain("redirect");
    expect(kws).toContain("auth");
    expect(kws).toContain("module");
  });

  it("strips Vietnamese stopwords", () => {
    const kws = extractKeywords("sửa lỗi không redirect đúng trong module đăng nhập");
    expect(kws).not.toContain("không");
    expect(kws).not.toContain("trong");
    // meaningful words should survive
    expect(kws.length).toBeGreaterThan(0);
  });

  it("drops tokens shorter than 3 chars", () => {
    const kws = extractKeywords("fix ui db api bug");
    expect(kws).not.toContain("ui");
    expect(kws).not.toContain("db");
    // api is 3 chars — exactly at the threshold, should be kept
    expect(kws).toContain("api"); // length exactly 3 — not dropped
    // "fix" is 3 chars — kept (threshold is < 3, so 3 is allowed)
    expect(kws).toContain("fix");
  });

  it("drops pure numbers", () => {
    const kws = extractKeywords("issue 12345 on line 99 fix");
    expect(kws).not.toContain("12345");
    expect(kws).not.toContain("99");
  });

  it("deduplicates tokens", () => {
    const kws = extractKeywords("login login login redirect login");
    const loginCount = kws.filter((k) => k === "login").length;
    expect(loginCount).toBe(1);
  });

  it("caps at 10 keywords", () => {
    // 15 distinct meaningful words
    const text =
      "authentication redirect session cookie token header payload signature expiry validation middleware interceptor pipeline router controller";
    const kws = extractKeywords(text);
    expect(kws.length).toBeLessThanOrEqual(10);
  });

  it("sorts by length descending for determinism (longer first)", () => {
    const kws = extractKeywords("authentication redirect session");
    // "authentication" is longest — should come first
    expect(kws[0]).toBe("authentication");
  });
});

// ---------------------------------------------------------------------------
// gatherCodebaseIntel — candidate ranking
// ---------------------------------------------------------------------------

describe("gatherCodebaseIntel — candidate ranking", () => {
  it("prefers filename match over body match", async () => {
    // File whose name matches the keyword
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "auth.ts"),
      `export function noop() {}`, // no keyword in body
      "utf8",
    );
    // File with keyword only in body (not in name)
    await fs.writeFile(
      path.join(tmpDir, "src", "utils.ts"),
      `// auth logic here\nexport function auth() {}\n// auth auth auth auth auth auth auth`, // many body hits
      "utf8",
    );

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix auth bug", description: "the auth module is broken", kind: "bug" },
    });

    const paths = intel.candidateFiles.map((c) => c.path);
    expect(paths[0]).toContain("auth.ts"); // filename match wins
  });

  it("includes path-based match when keyword appears in directory name", async () => {
    await fs.mkdir(path.join(tmpDir, "src", "auth"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "auth", "handler.ts"), `export function handle() {}`, "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix auth handler", description: "fix auth", kind: "bug" },
    });

    const paths = intel.candidateFiles.map((c) => c.path);
    expect(paths.some((p) => p.includes("auth/handler.ts") || p.includes("auth\\handler.ts"))).toBe(true);
  });

  it("matchScore is between 0 and 1", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "login.ts"), `// login handler\nexport function login() {}`, "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix login redirect", description: "login page redirects incorrectly", kind: "bug" },
    });

    for (const cf of intel.candidateFiles) {
      expect(cf.matchScore).toBeGreaterThanOrEqual(0);
      expect(cf.matchScore).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty candidateFiles when keywords produce no matches", async () => {
    // Only a file with totally unrelated content
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "xyz.ts"), "export const x = 1;", "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "qwertyuiop zzz yyy xxx", description: "asdfghjkl", kind: "chore" },
    });

    expect(intel.candidateFiles.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Impact radius
// ---------------------------------------------------------------------------

describe("gatherCodebaseIntel — impact radius", () => {
  it("finds JS/TS files that import a candidate", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    // Candidate file — keyword in name so it scores highest
    await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export function auth() {}", "utf8");
    // Importer — neutral name, body only contains the import path (which has "auth")
    // Use maxCandidates:1 so only auth.ts is a candidate and bootstrapper.ts
    // is therefore eligible for impact radius detection.
    await fs.writeFile(
      path.join(tmpDir, "src", "bootstrapper.ts"),
      `import { auth } from './auth';\nexport const boot = auth;`,
      "utf8",
    );

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix auth bug", description: "auth module broken", kind: "bug" },
      maxCandidates: 1, // only auth.ts is a candidate; bootstrapper.ts goes to impact radius
    });

    // bootstrapper.ts imports auth.ts via from './auth' — should appear in impact radius
    expect(intel.impactRadius.some((f) => f.includes("bootstrapper"))).toBe(true);
    // The candidate itself must not be listed in impactRadius
    expect(intel.impactRadius.every((f) => !f.includes("auth.ts"))).toBe(true);
  });

  it("finds C# files that 'using' a candidate", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    // Candidate — keyword in name
    await fs.writeFile(path.join(tmpDir, "src", "AuthService.cs"), "public class AuthService {}", "utf8");
    // Importer — neutral name that won't match any task keyword
    // Note: must NOT contain "authservice" in its body beyond the using statement
    // to avoid becoming a candidate itself. The using statement alone scores low
    // but the file name "Bootstrapper" has no keyword overlap so it won't rank
    // as a candidate (maxCandidates=1 to ensure only AuthService is candidate).
    await fs.writeFile(
      path.join(tmpDir, "src", "Bootstrapper.cs"),
      `using MyApp.AuthService;\npublic class Bootstrapper {}`,
      "utf8",
    );

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix AuthService bug", description: "AuthService crashes on null input", kind: "bug" },
      maxCandidates: 1, // ensure only AuthService.cs is a candidate
    });

    expect(intel.impactRadius.some((f) => f.includes("Bootstrapper"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe("gatherCodebaseIntel — regression tests", () => {
  it("picks up .test.ts files that reference candidate basenames", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "tests"), { recursive: true });

    await fs.writeFile(path.join(tmpDir, "src", "auth.ts"), "export function auth() {}", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "tests", "auth.test.ts"),
      `import { auth } from '../src/auth';\nit('works', () => auth());`,
      "utf8",
    );

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix auth", description: "auth is broken", kind: "bug" },
    });

    expect(intel.regressionTests.some((f) => f.includes("auth.test.ts"))).toBe(true);
  });

  it("picks up .spec.ts files", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "__tests__"), { recursive: true });

    await fs.writeFile(path.join(tmpDir, "src", "session.ts"), "export function session() {}", "utf8");
    await fs.writeFile(
      path.join(tmpDir, "__tests__", "session.spec.ts"),
      `describe('session', () => { it('ok', () => session()) });`,
      "utf8",
    );

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix session expiry", description: "session does not expire correctly", kind: "bug" },
    });

    expect(intel.regressionTests.some((f) => f.includes("session.spec.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

describe("gatherCodebaseIntel — framework detection", () => {
  it("detects next + node from package.json with next dependency", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }),
      "utf8",
    );

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix page", description: "page load fails", kind: "bug" },
    });

    expect(intel.detectedFrameworks).toContain("next");
    expect(intel.detectedFrameworks).toContain("node");
    expect(intel.detectedFrameworks).toContain("react");
  });

  it("detects dotnet from .csproj file", async () => {
    await fs.writeFile(path.join(tmpDir, "MyApp.csproj"), '<Project Sdk="Microsoft.NET.Sdk" />', "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix null ref", description: "null reference exception in service", kind: "bug" },
    });

    expect(intel.detectedFrameworks).toContain("dotnet");
  });

  it("detects python from requirements.txt", async () => {
    await fs.writeFile(path.join(tmpDir, "requirements.txt"), "fastapi\nuvicorn\n", "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix endpoint", description: "api endpoint returns 500", kind: "bug" },
    });

    expect(intel.detectedFrameworks).toContain("python");
  });

  it("detects rust from Cargo.toml", async () => {
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), '[package]\nname = "myapp"\n', "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix panic", description: "unwrap panic in main", kind: "bug" },
    });

    expect(intel.detectedFrameworks).toContain("rust");
  });

  it("returns sorted framework list", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0" } }), "utf8");
    await fs.writeFile(path.join(tmpDir, "requirements.txt"), "flask\n", "utf8");

    const intel = await gatherCodebaseIntel({
      cwd: tmpDir,
      task: { title: "fix something", description: "something is broken", kind: "bug" },
    });

    // Result should be sorted
    const sorted = [...intel.detectedFrameworks].sort();
    expect(intel.detectedFrameworks).toEqual(sorted);
  });
});
