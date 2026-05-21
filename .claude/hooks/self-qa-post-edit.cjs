#!/usr/bin/env node
/**
 * .claude/hooks/self-qa-post-edit.cjs
 *
 * PostToolUse hook: when the agent Edit/Write/MultiEdits a watched UI/harness
 * surface, fire `bun run src/index.ts self-verify` in the background and write
 * results to `.claude/self-qa-last.json`. The agent can read that file at any
 * time to see whether the change broke a Tier 1 scenario.
 *
 * Design notes:
 *  - Hook MUST exit fast (Claude hook timeout is 5-10s). We spawn the child
 *    detached + unref() so the bun process keeps running after we exit.
 *  - Throttle: if a run started < 60s ago we skip (avoids spam during rapid
 *    edits to the same file). Marker file: `.claude/self-qa-running.lock`.
 *  - Notification on stderr — Claude surfaces stderr as agent context.
 *  - Disable: SELF_QA_POST_EDIT=0 in env, or delete this file.
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WATCH_DIRS = ["src/ui/", "src/self-qa/", "src/agent-harness/", "packages/agent-harness-"];
const LOCK_FILE = path.join(REPO_ROOT, ".claude", "self-qa-running.lock");
const RESULT_FILE = path.join(REPO_ROOT, ".claude", "self-qa-last.json");
const STDERR_FILE = path.join(REPO_ROOT, ".claude", "self-qa-last.stderr");
const THROTTLE_MS = 60_000;

function bail(code) {
  process.exit(code);
}

if (process.env["SELF_QA_POST_EDIT"] === "0") bail(0);

let payload;
try {
  const raw = fs.readFileSync(0, "utf8"); // stdin
  payload = JSON.parse(raw || "{}");
} catch {
  bail(0);
}

const toolName = payload.tool_name || payload.toolName || "";
if (!["Edit", "Write", "MultiEdit"].includes(toolName)) bail(0);

const toolInput = payload.tool_input || payload.toolInput || {};
const filePath = String(toolInput.file_path || toolInput.filePath || "");
if (!filePath) bail(0);

// Normalize to repo-relative POSIX path for WATCH_DIRS comparison.
let rel = filePath.replace(/\\/g, "/");
const repoPosix = REPO_ROOT.replace(/\\/g, "/");
if (rel.toLowerCase().startsWith(repoPosix.toLowerCase())) {
  rel = rel.slice(repoPosix.length).replace(/^\/+/, "");
}
const watched = WATCH_DIRS.some((d) => rel.startsWith(d));
if (!watched) bail(0);

// Throttle: skip if a run is in-flight or completed within THROTTLE_MS.
try {
  const st = fs.statSync(LOCK_FILE);
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < THROTTLE_MS) {
    process.stderr.write(
      `[self-qa] watched edit (${rel}) — recent run still warm (${Math.round(ageMs / 1000)}s ago), skipping. Result: ${RESULT_FILE}\n`,
    );
    bail(0);
  }
} catch {
  // No lock file — proceed.
}

// Touch lock file BEFORE spawn so a fast-followup edit won't double-fire.
try {
  fs.writeFileSync(LOCK_FILE, String(Date.now()), "utf8");
} catch {
  /* best-effort */
}

const out = fs.openSync(RESULT_FILE, "w");
const err = fs.openSync(STDERR_FILE, "w");

const child = spawn(
  "bun",
  ["run", "src/index.ts", "self-verify", "--since", "HEAD", "--max", "2", "--no-emit", "--json"],
  {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    shell: process.platform === "win32",
  },
);
child.unref();

process.stderr.write(
  `[self-qa] watched edit (${rel}) — spawned background Tier 1 self-verify (pid ~${child.pid}). Check ${RESULT_FILE} in ~30s. Cancel: del .claude/self-qa-running.lock\n`,
);
bail(0);
