import type { PhaseSignal, SandboxProfile } from "../types.js";

/**
 * Exec profile — allowlisted spawn commands with env scrubbing + non-root enforcement.
 */
export const execProfile: SandboxProfile = {
  type: "Exec",
  allowlist: [{ prefix: process.cwd() }, { prefix: "/tmp" }, { prefix: "/var/tmp" }],
  deniedPaths: [
    { prefix: "/etc", exact: false },
    { prefix: "/root", exact: false },
  ],
  execOptions: {
    // Deny-by-default env: strip everything, re-add only minimal allowlist.
    envScrub: [],
    envAllow: ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TZ"],
    runAsNonRoot: true,
  },
  match(phase: PhaseSignal) {
    return phase.value === "Exec";
  },
};

/**
 * Exec profile allowlisted command basenames.
 * Kept separate from path allowlist so the gate can check both path and command.
 */
export const execCommandAllowlist = new Set([
  "git",
  "node",
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "sh",
  "bash",
  "python3",
  "python",
  "ruby",
  "go",
  "rustc",
  "cargo",
  "deno",
  "printenv",
]);
