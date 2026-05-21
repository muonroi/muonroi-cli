// src/product-loop/discovery-detection.ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExistingProjectSignals, ManifestDetection } from "./types.js";

const MANIFEST_PATTERNS: Array<{ name: string; type: ManifestDetection["type"]; lang: string }> = [
  { name: "package.json", type: "package.json", lang: "TypeScript" },
  { name: "Cargo.toml", type: "Cargo.toml", lang: "Rust" },
  { name: "go.mod", type: "go.mod", lang: "Go" },
  { name: "pyproject.toml", type: "pyproject.toml", lang: "Python" },
  { name: "pom.xml", type: "pom.xml", lang: "Java" },
  { name: "build.gradle", type: "build.gradle", lang: "Java" },
];

const SRC_EXT_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".rs": "Rust",
  ".go": "Go",
  ".py": "Python",
  ".cs": "C#",
  ".java": "Java",
  ".kt": "Kotlin",
};

const _DOC_FILES = new Set(["README.md", "LICENSE", "LICENSE.md", "CONTRIBUTING.md", "CHANGELOG.md", ".gitignore"]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectManifest(cwd: string, name: string): Promise<ManifestDetection | null> {
  const file = path.join(cwd, name);
  if (!(await pathExists(file))) return null;
  const pattern = MANIFEST_PATTERNS.find((p) => p.name === name);
  if (!pattern) return null;
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { file, type: pattern.type, weight: 0, inferredLang: pattern.lang, inferredFrameworks: [] };
  }
  const frameworks = inferFrameworks(raw, pattern.type);
  const depCount = countDeps(raw, pattern.type);
  const weight = Math.min(1, depCount / 5);
  return { file, type: pattern.type, weight, inferredLang: pattern.lang, inferredFrameworks: frameworks };
}

function inferFrameworks(raw: string, type: ManifestDetection["type"]): string[] {
  const fws: string[] = [];
  const text = raw.toLowerCase();
  if (type === "package.json") {
    for (const fw of ["next", "react", "vue", "svelte", "nest", "express", "fastify", "vite"]) {
      if (text.includes(`"${fw}`)) fws.push(fw);
    }
  } else if (type === "Cargo.toml") {
    for (const fw of ["actix", "axum", "rocket", "tokio"]) {
      if (text.includes(`${fw} =`) || text.includes(`${fw}=`)) fws.push(fw);
    }
  } else if (type === "go.mod") {
    for (const fw of ["gin", "echo", "fiber", "chi"]) {
      if (text.includes(`/${fw}`)) fws.push(fw);
    }
  } else if (type === "pyproject.toml") {
    for (const fw of ["django", "fastapi", "flask", "pydantic"]) {
      if (text.includes(fw)) fws.push(fw);
    }
  }
  return Array.from(new Set(fws));
}

function countDeps(raw: string, type: ManifestDetection["type"]): number {
  try {
    if (type === "package.json") {
      const pkg = JSON.parse(raw);
      return Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    }
  } catch {
    return 0;
  }
  // Heuristic for non-JSON manifests: count "=" lines
  return raw.split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#")).length;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".next", "venv", "__pycache__"]);

async function countSrcFiles(cwd: string): Promise<{ count: number; langs: Set<string> }> {
  let count = 0;
  const langs = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".git") continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDir) {
        await walk(full, depth + 1);
      } else {
        const ext = path.extname(e.name);
        const lang = SRC_EXT_TO_LANG[ext];
        if (lang) {
          count += 1;
          langs.add(lang);
        }
      }
    }
  }
  await walk(cwd, 0);
  return { count, langs };
}

export async function detectExistingProject(cwd: string): Promise<ExistingProjectSignals> {
  const isGitRepo = await pathExists(path.join(cwd, ".git"));
  const hasCommitHistory = isGitRepo && (await pathExists(path.join(cwd, ".git", "HEAD")));

  const manifests: ManifestDetection[] = [];
  for (const pattern of MANIFEST_PATTERNS) {
    const m = await detectManifest(cwd, pattern.name);
    if (m) manifests.push(m);
  }

  const { count: srcFileCount, langs: detectedLangs } = await countSrcFiles(cwd);

  const languages = Array.from(new Set([...manifests.map((m) => m.inferredLang), ...detectedLangs]));
  const frameworks = Array.from(new Set(manifests.flatMap((m) => m.inferredFrameworks)));

  const classification = classify(cwd, manifests, srcFileCount);

  return { isGitRepo, hasCommitHistory, srcFileCount, manifests, languages, frameworks, classification };
}

function classify(
  _cwd: string,
  manifests: ManifestDetection[],
  srcFileCount: number,
): ExistingProjectSignals["classification"] {
  if (srcFileCount === 0 && manifests.length === 0) return "greenfield";
  // Polyglot (multiple manifests) = ambiguous — cannot confidently pick one stack
  if (manifests.length > 1) return "ambiguous";
  const singleManifest = manifests.length === 1 ? manifests[0] : null;
  // Empty manifest (no deps, weight=0) with src files = ambiguous (might be scaffold)
  if (!singleManifest || singleManifest.weight === 0) return "ambiguous";
  // Single manifest with any declared deps + enough src files = existing
  if (srcFileCount > 5) return "existing";
  return "ambiguous";
}
