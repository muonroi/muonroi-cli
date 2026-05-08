import * as path from "node:path";
import { promises as fs } from "node:fs";
import { execSync } from "node:child_process";

/**
 * Deeper repo audit beyond {@link discoverProject}. The latter only detects
 * stack/test-runner from manifest files; this one walks the repo to give the
 * loop enough context to know whether the user is on a greenfield project, an
 * upgrade-existing-source job, or a scratch directory — and provides excerpts
 * the clarifier/debate can quote so its analysis is grounded in real code, not
 * generic boilerplate ("Review the current source code in src/").
 */
export interface RepoAudit {
  hasProject: boolean;
  /**
   *  - greenfield: nothing of substance in cwd
   *  - upgrade-existing: src/ + tests + (README or docs) → established codebase
   *  - scratch-dir: some files but no src+tests+docs combo
   */
  mode: "greenfield" | "upgrade-existing" | "scratch-dir";
  topLevelDirs: string[];
  srcFileCount: number;
  testFileCount: number;
  testFramework?: string;
  hasCoverageConfig: boolean;
  hasDocs: boolean;
  readmeExcerpt?: string;
  readmeSections?: string[];
  packageMeta?: { name?: string; version?: string; description?: string };
  recentCommits: string[];
}

const SRC_GLOB_DIRS = ["src", "lib", "app", "packages"];
const TEST_DIR_HINTS = ["tests", "test", "__tests__", "spec"];
const DOC_DIR_HINTS = ["docs", "doc", "documentation"];
const COVERAGE_HINTS = [
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.ts",
  "jest.config.js",
  ".coveragerc",
  "pyproject.toml",
];

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php"]);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

export async function auditRepo(cwd: string | undefined): Promise<RepoAudit> {
  const audit: RepoAudit = {
    hasProject: false,
    mode: "greenfield",
    topLevelDirs: [],
    srcFileCount: 0,
    testFileCount: 0,
    hasCoverageConfig: false,
    hasDocs: false,
    recentCommits: [],
  };
  if (!cwd) return audit;

  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    audit.topLevelDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {
    return audit;
  }

  const lowerDirs = new Set(audit.topLevelDirs.map((d) => d.toLowerCase()));
  audit.hasDocs = DOC_DIR_HINTS.some((d) => lowerDirs.has(d));

  // Count src + test files (capped to avoid blowing up on huge repos)
  for (const dir of SRC_GLOB_DIRS) {
    if (!lowerDirs.has(dir)) continue;
    const counts = await countCodeFiles(path.join(cwd, dir), 0, 5000);
    audit.srcFileCount += counts.code;
    audit.testFileCount += counts.tests;
  }
  for (const dir of TEST_DIR_HINTS) {
    if (!lowerDirs.has(dir)) continue;
    const counts = await countCodeFiles(path.join(cwd, dir), 0, 5000);
    // Anything under tests/ counts as a test file regardless of naming.
    audit.testFileCount += counts.code + counts.tests;
  }

  // Detect test framework and coverage config
  for (const hint of COVERAGE_HINTS) {
    const exists = await fileExists(path.join(cwd, hint));
    if (!exists) continue;
    audit.hasCoverageConfig = true;
    if (/vitest/.test(hint)) audit.testFramework = "vitest";
    else if (/jest/.test(hint)) audit.testFramework = "jest";
    break;
  }
  const pkgRaw = await readIfExists(path.join(cwd, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      audit.packageMeta = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
      };
      if (!audit.testFramework) {
        const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        if (all.vitest) audit.testFramework = "vitest";
        else if (all.jest) audit.testFramework = "jest";
        else if (all.mocha) audit.testFramework = "mocha";
      }
    } catch {
      /* ignore */
    }
  }

  // README
  const readme = await findReadme(cwd);
  if (readme) {
    audit.readmeExcerpt = readme.excerpt;
    audit.readmeSections = readme.sections;
  }

  // Recent commits — best-effort, skip silently when not a git repo or no git
  try {
    const out = execSync("git log --oneline -n 5 --no-decorate", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    audit.recentCommits = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    /* ignore */
  }

  audit.hasProject = audit.srcFileCount > 0 || audit.testFileCount > 0 || !!audit.readmeExcerpt;

  if (
    audit.srcFileCount >= 3 &&
    audit.testFileCount >= 1 &&
    (audit.hasDocs || !!audit.readmeExcerpt)
  ) {
    audit.mode = "upgrade-existing";
  } else if (audit.hasProject) {
    audit.mode = "scratch-dir";
  } else {
    audit.mode = "greenfield";
  }

  return audit;
}

async function countCodeFiles(
  dir: string,
  depth: number,
  budget: number,
): Promise<{ code: number; tests: number }> {
  if (depth > 6 || budget <= 0) return { code: 0, tests: 0 };
  let code = 0;
  let tests = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { code: 0, tests: 0 };
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await countCodeFiles(full, depth + 1, budget - code - tests);
      code += sub.code;
      tests += sub.tests;
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) continue;
      if (TEST_FILE_RE.test(e.name)) tests++;
      else code++;
    }
    if (code + tests >= budget) break;
  }
  return { code, tests };
}

async function findReadme(
  cwd: string,
): Promise<{ excerpt: string; sections: string[] } | null> {
  const candidates = ["README.md", "Readme.md", "readme.md", "README", "README.txt"];
  for (const c of candidates) {
    const raw = await readIfExists(path.join(cwd, c));
    if (!raw) continue;
    const lines = raw.split("\n");
    // Excerpt: first 2 non-empty paragraphs (capped 500 chars)
    const paragraphs: string[] = [];
    let buf: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        if (buf.length > 0) {
          paragraphs.push(buf.join(" ").trim());
          buf = [];
          if (paragraphs.length >= 2) break;
        }
      } else if (!line.startsWith("#")) {
        buf.push(line.trim());
      }
    }
    if (buf.length > 0 && paragraphs.length < 2) paragraphs.push(buf.join(" ").trim());
    const excerpt = paragraphs.join("\n\n").slice(0, 500);
    const sections = lines
      .filter((l) => /^#{1,3}\s+/.test(l))
      .slice(0, 12)
      .map((l) => l.replace(/^#{1,3}\s+/, "").trim());
    return { excerpt, sections };
  }
  return null;
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce extra prefills for SEED_DIMENSIONS based on the audit. These layer
 * on top of {@link discoverProject}'s prefills — caller merges them with first
 * write wins so manifest-derived stack/test info is not overwritten.
 */
export function additionalPrefills(a: RepoAudit): Map<string, string> {
  const out = new Map<string, string>();
  if (!a.hasProject) return out;

  // persona — when the codebase has README + tests it is overwhelmingly a
  // developer-facing tool/library. Confidence is high enough to skip the Q.
  if ((a.readmeExcerpt || a.readmeSections?.length) && a.testFileCount > 0) {
    out.set("persona", "developers using this codebase");
  }

  // success-metric — refine when we know the test framework
  if (a.testFramework && a.hasCoverageConfig) {
    out.set(
      "success-metric",
      `100% test pass with >80% coverage (runner: ${a.testFramework})`,
    );
  }

  // core-features — for upgrade-existing mode the user's idea is "improve
  // existing src", so MVP = "match existing project surface area".
  if (a.mode === "upgrade-existing") {
    out.set("core-features", "match existing project surface area (upgrade in place)");
  }

  return out;
}

/**
 * Multi-line context block that the clarifier and debate stages should
 * receive as `conversationContext`. Grounds prompts in real repo state so
 * Clarified Spec / Research output reference actual files instead of
 * generic boilerplate.
 */
export function auditAsContextBlock(a: RepoAudit): string {
  if (!a.hasProject) return "Cwd appears to be a greenfield/empty directory.";
  const lines: string[] = ["## Repository audit"];
  lines.push(`Mode: ${a.mode}`);
  if (a.packageMeta?.name) {
    lines.push(`Package: ${a.packageMeta.name}${a.packageMeta.version ? `@${a.packageMeta.version}` : ""}`);
    if (a.packageMeta.description) lines.push(`Description: ${a.packageMeta.description}`);
  }
  lines.push(`Top-level dirs: ${a.topLevelDirs.join(", ")}`);
  lines.push(`Source files: ${a.srcFileCount}, test files: ${a.testFileCount}`);
  if (a.testFramework) lines.push(`Test runner: ${a.testFramework}${a.hasCoverageConfig ? " (coverage configured)" : ""}`);
  if (a.readmeExcerpt) {
    lines.push("");
    lines.push("README excerpt:");
    lines.push(a.readmeExcerpt);
  }
  if (a.readmeSections?.length) {
    lines.push("");
    lines.push(`README sections: ${a.readmeSections.slice(0, 8).join(" / ")}`);
  }
  if (a.recentCommits.length) {
    lines.push("");
    lines.push("Recent commits:");
    for (const c of a.recentCommits) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}

export function formatAuditSummary(a: RepoAudit): string | null {
  if (!a.hasProject) return null;
  const bits: string[] = [`mode=**${a.mode}**`];
  if (a.packageMeta?.name) bits.push(`pkg \`${a.packageMeta.name}\``);
  bits.push(`src=${a.srcFileCount}`);
  bits.push(`tests=${a.testFileCount}`);
  if (a.testFramework) bits.push(`runner=${a.testFramework}`);
  if (a.hasDocs) bits.push("docs ✓");
  return `**Repo audit:** ${bits.join(" · ")}`;
}
