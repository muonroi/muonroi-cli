import fs from "node:fs";
import path from "node:path";
import { findGitRoot } from "../utils/git-root.js";
import { logger } from "../utils/logger.js";
import { isConcreteEEProject } from "./native-context.js";

export interface EERepositoryIdentity {
  root: string;
  project: string;
}
const markers = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "CMakeLists.txt",
];

/** Local filesystem evidence only. Does not bind task scope or change cwd. */
export function resolveEERepository(cwd: string): EERepositoryIdentity | undefined {
  try {
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return;
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      let gitDir = path.join(gitRoot, ".git");
      if (fs.statSync(gitDir).isFile()) {
        const match = fs.readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)\s*$/i);
        if (!match) throw new Error("Invalid git worktree metadata");
        gitDir = path.resolve(gitRoot, match[1]!.trim());
      }
      const common = path.join(gitDir, "commondir");
      if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, "utf8").trim());
      const configPath = path.join(gitDir, "config");
      let project: string | undefined;
      if (fs.existsSync(configPath)) {
        if (fs.statSync(configPath).size > 256 * 1024)
          throw new Error("Git config exceeds repository identity read limit");
        let origin = false;
        for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
          if (/^\s*\[/.test(line)) origin = /^\s*\[remote\s+"origin"\]\s*$/i.test(line);
          const url = origin ? line.match(/^\s*url\s*=\s*(.+?)\s*$/i)?.[1] : undefined;
          if (url) {
            const candidate = url
              .split(/[?#]/, 1)[0]!
              .replace(/[/\\]+$/, "")
              .split(/[/\\:]/)
              .at(-1)!
              .replace(/\.git$/i, "")
              .toLowerCase();
            if (isConcreteEEProject(candidate)) project = candidate;
            break;
          }
        }
      }
      project ??= path.basename(gitRoot).toLowerCase();
      if (isConcreteEEProject(project)) return { root: gitRoot, project };
      return;
    }
    let current = path.resolve(cwd);
    while (path.dirname(current) !== current) {
      if (
        markers.some((marker) => fs.existsSync(path.join(current, marker))) ||
        fs.readdirSync(current).some((name) => /\.(?:csproj|fsproj|sln|slnx)$/i.test(name))
      ) {
        const project = path.basename(current).toLowerCase();
        return isConcreteEEProject(project) ? { root: current, project } : undefined;
      }
      current = path.dirname(current);
    }
  } catch (error) {
    logger.file("warn", "ee", "Local repository identity could not be verified", {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return;
}
