import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RepoStructureHint {
  path: string;
  lineCount: number;
}

const MAP_FILE = "REPO_DEEP_MAP.md";
const MAP_LINE_RE = /`([^`]+)`[^\n]*?\(~(\d+)\s+lines\b/gi;
const cache = new Map<string, RepoStructureHint[]>();

export function parseRepoStructureHints(markdown: string): RepoStructureHint[] {
  const hints: RepoStructureHint[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(MAP_LINE_RE)) {
    const path = match[1]?.trim();
    const lineCount = Number.parseInt(match[2] ?? "", 10);
    if (!path || !Number.isFinite(lineCount)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({ path, lineCount });
  }
  return hints;
}

export function getRepoStructureHints(cwd: string): RepoStructureHint[] {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const mapPath = join(cwd, MAP_FILE);
  if (!existsSync(mapPath)) {
    cache.set(cwd, []);
    return [];
  }
  try {
    const raw = readFileSync(mapPath, "utf8");
    const hints = parseRepoStructureHints(raw);
    cache.set(cwd, hints);
    return hints;
  } catch {
    cache.set(cwd, []);
    return [];
  }
}

export function clearRepoStructureHintsCache(): void {
  cache.clear();
}
