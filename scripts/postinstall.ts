/**
 * postinstall.ts — Bun workspace link helper.
 *
 * Bun v1.3.x on Windows does not always create node_modules symlinks for
 * workspace packages. This script creates them manually after `bun install`
 * so that runtime imports (and tests spawning sub-processes) can resolve
 * `@muonroi/*` packages.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = import.meta.dir ? resolve(import.meta.dir, "..") : process.cwd();

const workspaceLinks: Array<{ name: string; pkg: string }> = [
  { name: "@muonroi/agent-harness-core", pkg: "packages/agent-harness-core" },
];

for (const { name, pkg } of workspaceLinks) {
  const [scope, shortName] = name.split("/") as [string, string];
  const scopeDir = resolve(ROOT, "node_modules", scope);
  const linkPath = resolve(scopeDir, shortName);
  const target = resolve(ROOT, pkg);

  if (!existsSync(scopeDir)) {
    mkdirSync(scopeDir, { recursive: true });
  }

  if (existsSync(linkPath)) {
    // Already linked — skip.
    console.log(`  [ok] ${name} already linked`);
    continue;
  }

  // Create a relative symlink (junction on Windows).
  const rel = `../../${pkg}`;
  try {
    symlinkSync(rel, linkPath, "junction");
    console.log(`  [linked] ${name} → ${rel}`);
  } catch (e) {
    // If symlink fails (e.g., permissions), try absolute.
    try {
      symlinkSync(target, linkPath, "junction");
      console.log(`  [linked-abs] ${name} → ${target}`);
    } catch (e2) {
      console.warn(`  [warn] Could not link ${name}: ${e2}`);
    }
  }
}
