import type { PhaseSignal, SandboxProfile } from "../types.js";

/**
 * Read profile — allowlisted read-only paths.
 * Defaults to the working directory and common read-safe system paths.
 */
export const readProfile: SandboxProfile = {
  type: "Read",
  allowlist: [
    { prefix: process.cwd() },
    { prefix: "/tmp" },
    { prefix: "/var/tmp" },
    { prefix: "/etc/os-release", exact: true },
  ],
  deniedPaths: [{ prefix: "/etc/shadow", exact: true }],
  execOptions: null,
  match(phase: PhaseSignal) {
    return phase.value === "Read";
  },
};
