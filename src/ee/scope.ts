/**
 * Scope builder — derives EE scope from session cwd by reading .git/HEAD + .git/config.
 *
 * Pitfall 6 (CONTEXT.md): scope is cached at session boot, NOT re-computed per call.
 * Never uses child_process — reads git files directly via fs.
 *
 * EE-05: Scope payload is one of {global | ecosystem:muonroi | repo:<remote> | branch:<remote+branch>}.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Scope } from "./types.js";

let cached: Scope | null = null;
let cachedFor: string | null = null;

function parseGitConfig(text: string): { remote?: string } {
  // Find [remote "origin"]\n  url = X
  const m = text.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/);
  if (!m) return {};
  const url = m[1].match(/^\s*url\s*=\s*(.+)$/m);
  return { remote: url ? url[1].trim() : undefined };
}

function parseHEAD(text: string): { branch?: string; detached?: boolean } {
  const t = text.trim();
  if (t.startsWith("ref: refs/heads/"))
    return { branch: t.slice("ref: refs/heads/".length) };
  return { detached: true };
}

async function findGitRoot(start: string): Promise<string | null> {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    try {
      await fs.access(path.join(dir, ".git", "HEAD"));
      return dir;
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export async function buildScope(opts: { cwd: string }): Promise<Scope> {
  if (cached && cachedFor === opts.cwd) return cached;
  const root = await findGitRoot(opts.cwd);
  if (!root) {
    cached = { kind: "global" };
    cachedFor = opts.cwd;
    return cached;
  }
  const head = await fs
    .readFile(path.join(root, ".git", "HEAD"), "utf8")
    .catch(() => "");
  const cfg = await fs
    .readFile(path.join(root, ".git", "config"), "utf8")
    .catch(() => "");
  const { remote } = parseGitConfig(cfg);
  const { branch } = parseHEAD(head);
  if (remote && branch) cached = { kind: "branch", remote, branch };
  else if (remote) cached = { kind: "repo", remote };
  else cached = { kind: "global" };
  cachedFor = opts.cwd;
  return cached;
}

export function scopeLabel(s: Scope): string {
  switch (s.kind) {
    case "global":
      return "global";
    case "ecosystem":
      return `ecosystem:${s.name}`;
    case "repo":
      return `repo:${s.remote}`;
    case "branch":
      return `branch:${s.remote}#${s.branch}`;
  }
}

export function resetScopeCache(): void {
  cached = null;
  cachedFor = null;
}
