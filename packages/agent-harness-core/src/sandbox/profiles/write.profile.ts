import type { PhaseSignal, SandboxProfile } from "../types.js";

/**
 * Write profile — allowlisted write paths.
 * Defaults to the working directory and temp directories.
 */
export const writeProfile: SandboxProfile = {
  type: "Write",
  allowlist: [{ prefix: process.cwd() }, { prefix: "/tmp" }, { prefix: "/var/tmp" }],
  deniedPaths: [
    { prefix: "/etc", exact: false },
    { prefix: "/usr", exact: false },
    { prefix: "/bin", exact: false },
    { prefix: "/sbin", exact: false },
    { prefix: "/root", exact: false },
  ],
  execOptions: null,
  match(phase: PhaseSignal) {
    return phase.value === "Write";
  },
};
