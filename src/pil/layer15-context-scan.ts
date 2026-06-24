import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoundedContext, ProjectContext, RelevantModule } from "./discovery-types.js";

type ExistsFn = (p: string) => boolean;

export function detectLanguage(cwd: string, exists: ExistsFn = (p) => existsSync(p)): string | null {
  if (exists(join(cwd, "tsconfig.json"))) return "typescript";
  if (exists(join(cwd, "Cargo.toml"))) return "rust";
  if (exists(join(cwd, "go.mod"))) return "go";
  if (exists(join(cwd, "pyproject.toml")) || exists(join(cwd, "requirements.txt"))) return "python";
  if (exists(join(cwd, "package.json"))) return "javascript";
  const slnFiles = safeReaddir(cwd).filter((f) => f.endsWith(".sln"));
  if (slnFiles.length > 0) return "csharp";
  if (exists(join(cwd, "pom.xml")) || exists(join(cwd, "build.gradle"))) return "java";
  return null;
}

export function detectFramework(
  cwd: string,
  exists: ExistsFn = (p) => existsSync(p),
  deps: Record<string, string> = {},
): string | null {
  if (
    exists(join(cwd, "next.config.js")) ||
    exists(join(cwd, "next.config.mjs")) ||
    exists(join(cwd, "next.config.ts"))
  )
    return "next";
  if (exists(join(cwd, "angular.json"))) return "angular";
  if (
    (exists(join(cwd, "vite.config.ts")) || exists(join(cwd, "vite.config.js"))) &&
    !exists(join(cwd, "next.config.js"))
  )
    return "vite";
  if (exists(join(cwd, "Directory.Build.props"))) {
    const hasSln = safeReaddir(cwd).some((f) => f.endsWith(".sln"));
    const hasMuonroi = safeReaddir(join(cwd, "src")).some((f) => f.startsWith("Muonroi."));
    if (hasSln && hasMuonroi) return "muonroi-building-block";
    if (hasSln) return "dotnet";
  }
  if (deps.express) return "express";
  if (deps.django || deps.flask) return deps.django ? "django" : "flask";
  if (exists(join(cwd, "Cargo.toml"))) return "rust";
  if (exists(join(cwd, "go.mod"))) return "go";
  return null;
}

export function detectPackageManager(cwd: string, exists: ExistsFn = (p) => existsSync(p)): string | null {
  if (exists(join(cwd, "bun.lockb")) || exists(join(cwd, "bun.lock"))) return "bun";
  if (exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(cwd, "yarn.lock"))) return "yarn";
  if (exists(join(cwd, "package-lock.json"))) return "npm";
  if (exists(join(cwd, "Cargo.lock"))) return "cargo";
  if (exists(join(cwd, "go.sum"))) return "go";
  return null;
}

export function scanBoundedContexts(cwd: string): BoundedContext[] {
  const srcDir = join(cwd, "src");
  const dirs = safeReaddir(srcDir).filter((d) => {
    try {
      return readdirSync(join(srcDir, d)).length > 0;
    } catch {
      return false;
    }
  });
  return dirs.slice(0, 20).map((d) => {
    const dirPath = join("src", d);
    const entryNames = ["index.ts", "index.tsx", "index.js", "mod.rs", "__init__.py"];
    const entryFiles = entryNames.map((e) => join(dirPath, e)).filter((e) => existsSync(join(cwd, e)));
    const exportedSymbols = extractExports(cwd, entryFiles).slice(0, 20);
    return { path: `${dirPath}/`, name: d, entryFiles, exportedSymbols };
  });
}

function extractExports(cwd: string, entryFiles: string[]): string[] {
  const symbols: string[] = [];
  for (const f of entryFiles) {
    try {
      const content = readFileSync(join(cwd, f), "utf-8");
      const matches = content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|type|interface|enum)\s+(\w+)/g);
      for (const m of matches) symbols.push(m[1]!);
    } catch {
      /* ignore */
    }
  }
  return symbols;
}

export function findRelevantModules(raw: string, boundedContexts: BoundedContext[]): RelevantModule[] {
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const results: RelevantModule[] = [];
  for (const bc of boundedContexts) {
    const name = bc.name.toLowerCase();
    const match = words.find((w) => name.includes(w) || w.includes(name));
    if (match) {
      results.push({ path: bc.path, relevance: `keyword "${match}" matches module "${bc.name}"`, exists: true });
    }
  }
  return results.slice(0, 5);
}

function readDeps(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

export async function scanProjectContext(raw: string, cwd: string): Promise<ProjectContext> {
  const exists: ExistsFn = (p) => existsSync(p);
  const deps = readDeps(cwd);
  const language = detectLanguage(cwd, exists);
  const framework = detectFramework(cwd, exists, deps);
  const packageManager = detectPackageManager(cwd, exists);
  const boundedContexts = scanBoundedContexts(cwd);
  const relevantModules = findRelevantModules(raw, boundedContexts);

  let eePatterns: string[] = [];
  try {
    const { searchByText } = await import("../ee/bridge.js");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 500);
    const hits = await searchByText(raw, ["experience-behavioral"], 5, ac.signal);
    clearTimeout(timer);
    eePatterns = hits
      .map((h) => (h.payload?.text as string) ?? "")
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, 5);
  } catch {
    /* EE unavailable */
  }

  return {
    language,
    framework,
    packageManager,
    domain: language,
    boundedContexts,
    eePatterns,
    relevantModules,
    scannedAt: Date.now(),
    cwd,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
