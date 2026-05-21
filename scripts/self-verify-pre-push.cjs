#!/usr/bin/env node
/**
 * scripts/self-verify-pre-push.cjs
 *
 * Runs `bun run src/index.ts self-verify` BEFORE `git push` only when the
 * commits being pushed touch UI / harness surfaces — files where vitest
 * unit tests cannot catch lifecycle, modal, askcard, or focus bugs.
 *
 * Skip with:  git push --no-verify
 * Opt out:    SELF_VERIFY_PRE_PUSH=0 git push
 *
 * Cost: ~30s + ~$0.005-0.01 per run when a watched surface changed,
 * zero cost otherwise.
 */
"use strict";

const { execSync, spawnSync } = require("node:child_process");

const WATCH_DIRS = ["src/ui/", "src/self-qa/", "src/agent-harness/", "packages/agent-harness-"];

function log(msg) {
  process.stderr.write(`[self-verify-pre-push] ${msg}\n`);
}

function exitWith(code) {
  process.exit(code);
}

if (process.env["SELF_VERIFY_PRE_PUSH"] === "0") {
  log("disabled via SELF_VERIFY_PRE_PUSH=0 — skipping");
  exitWith(0);
}

// Discover the base ref the push is going to. Default: origin/master.
let baseRef = "origin/master";
try {
  const remote =
    process.env["PRE_PUSH_REMOTE"] ||
    execSync("git remote", { encoding: "utf8" })
      .split(/\r?\n/)
      .find((l) => l.trim()) ||
    "origin";
  baseRef = `${remote.trim()}/master`;
} catch {
  // fallback already set
}

let changed = "";
try {
  changed = execSync(`git diff --name-only ${baseRef}...HEAD`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  log(`could not diff against ${baseRef} — skipping self-verify (push will proceed)`);
  exitWith(0);
}

const touched = changed
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((f) => WATCH_DIRS.some((d) => f.startsWith(d)));

if (touched.length === 0) {
  log("no UI/harness/self-qa changes detected — skipping");
  exitWith(0);
}

log(`watched surface changed (${touched.length} file(s)) — running self-verify`);
for (const f of touched.slice(0, 5)) log(`  · ${f}`);
if (touched.length > 5) log(`  · …and ${touched.length - 5} more`);

const result = spawnSync("bun", ["run", "src/index.ts", "self-verify", "--since", baseRef, "--max", "4", "--no-emit"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status === 0) {
  log("self-verify PASSED — proceeding with push");
  exitWith(0);
}

log(`self-verify FAILED (exit ${result.status}) — blocking push`);
log("override with: git push --no-verify");
exitWith(1);
