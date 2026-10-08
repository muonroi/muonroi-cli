// src/product-loop/discovery-detection.ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger.js";
import { langForFile, type ManifestSpec, matchManifest } from "./language-registry.js";
import type { ExistingProjectSignals, ManifestDetection } from "./types.js";

const _DOC_FILES = new Set(["README.md", "LICENSE", "LICENSE.md", "CONTRIBUTING.md", "CHANGELOG.md", ".gitignore"]);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function describeManifest(file: string, spec: ManifestSpec): Promise<ManifestDetection> {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    // Unreadable (e.g. a directory carrying a manifest name) — still report it
    // at weight 0 so classify() treats the repo as ambiguous rather than
    // greenfield, which is the long-standing behaviour.
    console.error(
      `[discovery-detection] describeManifest: cannot read "${file}": ${(err as Error)?.message}`,
      (err as Error)?.stack?.split("\n").slice(0, 3),
    );
    return { file, type: spec.type, weight: 0, inferredLang: spec.lang, inferredFrameworks: [] };
  }
  const frameworks = inferFrameworks(raw, spec.type);
  const depCount = countDeps(raw, spec.type);
  const weight = Math.min(1, depCount / 5);
  return { file, type: spec.type, weight, inferredLang: spec.lang, inferredFrameworks: frameworks };
}

/**
 * Read a directory, returning null when it cannot be listed.
 *
 * A missing or unreadable directory is an ordinary "nothing here" answer for a
 * greenfield probe — `detectExistingProject` is called on paths that routinely
 * do not exist yet — so it must not throw or surface as an error. It is still
 * logged at debug level (No Silent Catch): when a repo is misread as empty,
 * this line is the only evidence of which directory the scanner could not see.
 */
async function readDirEntries(dir: string): Promise<import("node:fs").Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.debug("orchestrator", "[discovery-detection] readDirEntries: directory not listable", {
      dir,
      error: (err as Error)?.message,
    });
    return null;
  }
}

/**
 * Match already-listed directory entries against the manifest registry.
 *
 * Entry type is deliberately ignored: a *directory* named `package.json` is
 * still reported (its read fails → weight 0), matching the previous
 * `fs.access`-based probe exactly.
 */
async function manifestsFromEntries(dir: string, entries: import("node:fs").Dirent[]): Promise<ManifestDetection[]> {
  const found: ManifestDetection[] = [];
  for (const e of entries) {
    const spec = matchManifest(e.name);
    if (!spec) continue;
    found.push(await describeManifest(path.join(dir, e.name), spec));
  }
  return found;
}

/** Scan one directory for manifests, listing it first. */
async function scanDirForManifests(dir: string): Promise<ManifestDetection[]> {
  const entries = await readDirEntries(dir);
  return entries ? manifestsFromEntries(dir, entries) : [];
}

/**
 * Collapse to one manifest per language stack, keeping the highest-weight
 * candidate (ties keep the first encountered).
 *
 * A .NET repo proves itself with a `.sln` AND `Directory.Build.props` AND a
 * `.csproj` — all the same stack. Without this, `classify()`'s "more than one
 * manifest = polyglot = ambiguous" rule would misread every .NET repo as
 * ambiguous. Deduping by language keeps that rule meaningful (TypeScript +
 * Python is still polyglot) while letting one stack present several files.
 */
function dedupeByLanguage(manifests: ManifestDetection[]): ManifestDetection[] {
  const byLang = new Map<string, ManifestDetection>();
  for (const m of manifests) {
    const existing = byLang.get(m.inferredLang);
    if (!existing || m.weight > existing.weight) byLang.set(m.inferredLang, m);
  }
  return Array.from(byLang.values());
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

// `obj` is .NET build output — it regenerates more `.cs` files than the repo
// actually contains (630 vs 506 on tcis-libraries), so counting it would hand
// the planner a distorted repo rather than an invisible one.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  "venv",
  "__pycache__",
  "obj",
]);

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
        const lang = langForFile(e.name);
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

/**
 * Find the manifests that describe this repository.
 *
 * Root first. Only when the root proves nothing do we look one level down —
 * the real .NET layout that motivated this puts `TCISLibraries.sln` and
 * `Directory.Build.props` under `src/`, with a bare repo root
 * (verified on D:\sources\CompanyLibs\tcis-libraries).
 *
 * The fallback is gated on an empty root deliberately: every repo that already
 * has a root manifest keeps its previous answer exactly, so a stray nested
 * manifest can never flip an established repo to "polyglot / ambiguous".
 */
async function detectManifests(cwd: string): Promise<ManifestDetection[]> {
  // One listing of cwd serves both passes: matching manifests at the root, and
  // enumerating the subdirectories the fallback descends into.
  const entries = await readDirEntries(cwd);
  if (!entries) return [];

  const atRoot = await manifestsFromEntries(cwd, entries);
  if (atRoot.length > 0) return dedupeByLanguage(atRoot);

  const nested: ManifestDetection[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
    nested.push(...(await scanDirForManifests(path.join(cwd, e.name))));
  }
  return dedupeByLanguage(nested);
}

export async function detectExistingProject(cwd: string): Promise<ExistingProjectSignals> {
  const isGitRepo = await pathExists(path.join(cwd, ".git"));
  const hasCommitHistory = isGitRepo && (await pathExists(path.join(cwd, ".git", "HEAD")));

  const manifests = await detectManifests(cwd);

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
