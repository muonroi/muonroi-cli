import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { findGitRoot } from "./git-root.js";
import { logger } from "./logger.js";

const REFRESH_TTL_MS = 30_000;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".flac",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".pyc",
  ".class",
  ".wasm",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.lastIndexOf(".");
  if (ext === -1) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(ext).toLowerCase());
}

async function collectFiles(cwd: string): Promise<string[]> {
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    try {
      return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: gitRoot,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 5000,
        stdio: "pipe",
        windowsHide: true,
      })
        .split("\0")
        .filter((file) => file.length > 0 && !isBinaryPath(file));
    } catch (error) {
      logger.file("warn", "ui", "[file-index] Git file listing failed", {
        cwd: gitRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
  // No shell: non-Git Windows directories do not require find/head in PATH.
  const files: string[] = [];
  const pending = [cwd];
  const ignored = new Set(["node_modules", ".git", "dist"]);
  let visitedFiles = 0,
    visitedDirectories = 0;
  const deadline = Date.now() + 5000;
  while (pending.length && visitedFiles < 5000 && visitedDirectories < 5000 && Date.now() < deadline) {
    const directory = pending.pop()!;
    visitedDirectories++;
    try {
      for await (const entry of await fs.opendir(directory)) {
        if (visitedFiles >= 5000 || Date.now() >= deadline) break;
        if (entry.isDirectory() && !ignored.has(entry.name)) {
          if (pending.length < 5000) pending.push(join(directory, entry.name));
        } else if (entry.isFile()) {
          visitedFiles++;
          const file = relative(cwd, join(directory, entry.name)).replace(/\\/g, "/");
          if (!isBinaryPath(file)) files.push(file);
        }
      }
    } catch (error) {
      logger.file("warn", "ui", "[file-index] Directory file listing failed", {
        cwd: directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return files;
}

function scoreMatch(filePath: string, query: string): number {
  const lowerPath = filePath.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerPath.includes(lowerQuery)) return -1;

  let score = 0;
  const name = basename(filePath).toLowerCase();

  if (name === lowerQuery) score += 100;
  else if (name.startsWith(lowerQuery)) score += 60;
  else if (name.includes(lowerQuery)) score += 30;

  if (lowerPath.startsWith(lowerQuery)) score += 20;

  const idx = lowerPath.indexOf(lowerQuery);
  score -= idx * 0.1;

  score -= filePath.length * 0.05;

  return score;
}

export class FileIndex {
  private files: string[] = [];
  private cwd: string;
  private baseDir: string;
  private lastRefresh = 0;
  private refreshing?: { cwd: string; promise: Promise<void> };

  constructor(cwd: string) {
    this.cwd = cwd;
    this.baseDir = findGitRoot(cwd) ?? cwd;
  }

  async refresh(): Promise<void> {
    if (this.refreshing?.cwd === this.cwd) return this.refreshing.promise;
    const cwd = this.cwd;
    const promise = collectFiles(cwd).then((files) => {
      if (cwd !== this.cwd) return;
      this.files = files;
      this.lastRefresh = Date.now();
    });
    this.refreshing = { cwd, promise };
    try {
      await promise;
    } finally {
      if (this.refreshing?.promise === promise) this.refreshing = undefined;
    }
  }

  updateCwd(cwd: string): void {
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      this.baseDir = findGitRoot(cwd) ?? cwd;
      this.lastRefresh = 0;
    }
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastRefresh > REFRESH_TTL_MS) {
      await this.refresh();
    }
  }

  async match(query: string, maxResults = 10): Promise<string[]> {
    await this.ensureFresh();
    if (!query) return this.files.slice(0, maxResults);

    const scored: { path: string; score: number }[] = [];
    for (const f of this.files) {
      const s = scoreMatch(f, query);
      if (s >= 0) scored.push({ path: f, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.path);
  }

  get size(): number {
    return this.files.length;
  }

  resolvePath(filePath: string): string {
    return resolve(this.baseDir, filePath);
  }
}
