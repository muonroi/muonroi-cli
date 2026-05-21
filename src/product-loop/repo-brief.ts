/**
 * src/product-loop/repo-brief.ts
 *
 * Build a compact "what is this repo" brief that the discovery leader and
 * council can cite when recommending changes inside an EXISTING project.
 *
 * The vendor-default preamble (`buildEcosystemPreamble`) belongs to greenfield
 * scaffolding flows only. For existing repos we replace it with this brief —
 * grounded in the actual filesystem — so the leader's rationale can name real
 * files, packages, and scripts instead of inventing generic stack defaults.
 *
 * Output budget: ~1200 chars hard cap. Anything longer competes with the
 * prompt-specificity context + question + constraint + answers-so-far, and
 * the leader has limited maxTokens.
 *
 * The brief is intentionally markdown so the LLM can pattern-match section
 * headers; it is NEVER user-facing.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExistingProjectSignals } from "./types.js";

const HARD_CAP_CHARS = 1200;
const README_HEAD_CHARS = 480;
const MAX_TOP_LEVEL_DIRS = 12;
const MAX_NESTED_DIRS_PER_TOP = 6;
const MAX_DEPS_LISTED = 18;
const MAX_SCRIPTS_LISTED = 8;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "target",
  "out",
  ".turbo",
  ".cache",
  "coverage",
  "venv",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

/** Citable tokens extracted from the brief (file/dir names, package names,
 *  script names). Used by `discovery-recommender` to validate that the leader
 *  actually grounded its rationale in something concrete. */
export interface RepoBrief {
  markdown: string;
  citableTokens: string[];
}

async function safeReaddir(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

async function readTopLevelDirs(cwd: string): Promise<Array<{ name: string; children: string[] }>> {
  const top = await safeReaddir(cwd);
  const dirs = top
    .filter((e) => e.isDir && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .slice(0, MAX_TOP_LEVEL_DIRS)
    .map((e) => e.name);

  const out: Array<{ name: string; children: string[] }> = [];
  for (const d of dirs) {
    const sub = await safeReaddir(path.join(cwd, d));
    const children = sub
      .filter((e) => e.isDir && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
      .slice(0, MAX_NESTED_DIRS_PER_TOP)
      .map((e) => e.name);
    out.push({ name: d, children });
  }
  return out;
}

async function readReadmeHead(cwd: string): Promise<string | null> {
  for (const name of ["README.md", "README.MD", "readme.md", "Readme.md"]) {
    try {
      const raw = await fs.readFile(path.join(cwd, name), "utf8");
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      return trimmed.length > README_HEAD_CHARS ? `${trimmed.slice(0, README_HEAD_CHARS)}…` : trimmed;
    } catch {
      /* try next */
    }
  }
  return null;
}

interface PkgJsonSummary {
  name?: string;
  description?: string;
  scripts: string[];
  deps: string[];
}

async function readPackageJsonSummary(cwd: string): Promise<PkgJsonSummary | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scripts = Object.keys((parsed.scripts as Record<string, string>) ?? {}).slice(0, MAX_SCRIPTS_LISTED);
  const deps = [
    ...Object.keys((parsed.dependencies as Record<string, string>) ?? {}),
    ...Object.keys((parsed.devDependencies as Record<string, string>) ?? {}),
  ].slice(0, MAX_DEPS_LISTED);
  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    scripts,
    deps,
  };
}

function capMarkdown(s: string): string {
  if (s.length <= HARD_CAP_CHARS) return s;
  return `${s.slice(0, HARD_CAP_CHARS - 1)}…`;
}

/**
 * Build a markdown brief of the repo at `cwd`, grounded in `detection` plus
 * a shallow filesystem walk. Returns markdown + the list of citable tokens
 * so the caller can validate that leader rationales reference at least one.
 *
 * Never throws — partial brief is fine when individual probes fail.
 */
export async function buildRepoBrief(cwd: string, detection: ExistingProjectSignals): Promise<RepoBrief> {
  const tokens = new Set<string>();
  const lines: string[] = [];

  lines.push("## Repo brief (existing project — recommendations MUST cite these)");
  lines.push("");

  // 1) Identity from package.json or manifest list
  const pkg = await readPackageJsonSummary(cwd);
  if (pkg?.name) {
    lines.push(`Package name: \`${pkg.name}\``);
    tokens.add(pkg.name);
  }
  if (pkg?.description) {
    lines.push(`Description: ${pkg.description}`);
  }

  // 2) Detected stack signals — already cheap, reuse
  if (detection.languages.length > 0) {
    lines.push(`Languages: ${detection.languages.join(", ")}`);
    for (const l of detection.languages) tokens.add(l);
  }
  if (detection.frameworks.length > 0) {
    lines.push(`Frameworks: ${detection.frameworks.join(", ")}`);
    for (const f of detection.frameworks) tokens.add(f);
  }
  if (detection.manifests.length > 0) {
    const manifestNames = detection.manifests.map((m) => path.basename(m.file));
    lines.push(`Manifests: ${manifestNames.join(", ")}`);
    for (const m of manifestNames) tokens.add(m);
  }
  lines.push("");

  // 3) Top-level directory layout depth 2
  const dirs = await readTopLevelDirs(cwd);
  if (dirs.length > 0) {
    lines.push("Top-level layout:");
    for (const d of dirs) {
      tokens.add(d.name);
      if (d.children.length === 0) {
        lines.push(`- \`${d.name}/\``);
      } else {
        for (const c of d.children) tokens.add(`${d.name}/${c}`);
        lines.push(`- \`${d.name}/\` — ${d.children.map((c) => `\`${c}/\``).join(", ")}`);
      }
    }
    lines.push("");
  }

  // 4) Scripts + deps when package.json present
  if (pkg) {
    if (pkg.scripts.length > 0) {
      lines.push(`Scripts: ${pkg.scripts.map((s) => `\`${s}\``).join(", ")}`);
      for (const s of pkg.scripts) tokens.add(s);
    }
    if (pkg.deps.length > 0) {
      lines.push(`Key deps: ${pkg.deps.map((d) => `\`${d}\``).join(", ")}`);
      for (const d of pkg.deps) tokens.add(d);
    }
    if (pkg.scripts.length > 0 || pkg.deps.length > 0) lines.push("");
  }

  // 5) README head — usually the highest-signal section
  const readme = await readReadmeHead(cwd);
  if (readme) {
    lines.push("README head:");
    lines.push(readme);
    lines.push("");
  }

  lines.push(
    "Rationales for ANY recommendation MUST cite at least ONE of these tokens (file path, dir, dep, script, or manifest). Generic rationales without a citation are invalid for this project.",
  );

  const markdown = capMarkdown(lines.join("\n"));

  // Filter tokens to citable-quality (length >= 2, alphanumeric/path chars).
  const citableTokens = Array.from(tokens).filter((t) => t.length >= 2 && /^[\w./@-]+$/.test(t));

  return { markdown, citableTokens };
}

/**
 * Test whether `rationale` cites at least one citable token from `brief`.
 * Case-insensitive substring match. Empty/missing brief tokens → returns true
 * (no expectations to check against).
 */
export function rationaleCitesBrief(rationale: string, brief: RepoBrief | undefined): boolean {
  if (!brief || brief.citableTokens.length === 0) return true;
  const lower = rationale.toLowerCase();
  return brief.citableTokens.some((t) => lower.includes(t.toLowerCase()));
}
