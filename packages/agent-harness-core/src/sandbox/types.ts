// ---------------------------------------------------------------------------
// Sandbox gate types — Sprint 1 boundary + capability-mask dispatch
// ---------------------------------------------------------------------------

/** Phase signal emitted by the orchestrator SSOT for the current turn. */
export interface PhaseSignal {
  value: "Read" | "Write" | "Exec";
  source: "orchestrator-ssot";
  turnId: string;
}

/** Tool request shape the gate evaluates. */
export interface ToolRequest {
  kind: "fs" | "exec";
  path?: string;
  content?: string;
  command?: string[];
  env?: Record<string, string>;
}

/** Structured deny object — never a raw Error. */
export interface DenyObject {
  reason: string;
  code: "PATH_NOT_ALLOWLISTED" | "OP_NOT_PERMITTED" | "ENV_SCRUB_FAILED" | "ROOT_FORBIDDEN" | "PHASE_MISMATCH";
  retryable: boolean;
  phase: PhaseSignal;
}

/** Gate evaluation result. */
export interface GateResult {
  outcome: "ALLOW" | "DENY";
  result?: {
    content?: string;
    stdout?: string;
    stderr?: string;
  };
  deny?: DenyObject;
}

/** Path pattern used by profiles. */
export interface PathPattern {
  /** Absolute or glob-ish prefix. */
  prefix: string;
  /** Optional exact match flag. */
  exact?: boolean;
}

/** Exec-specific options for the Exec profile. */
export interface ExecProfileOptions {
  envScrub: string[];
  /** Optional env allowlist. When provided, environment is deny-by-default. */
  envAllow?: string[];
  runAsNonRoot: boolean;
}

/** Sandbox profile definition. */
export interface SandboxProfile {
  type: "Read" | "Write" | "Exec";
  allowlist: PathPattern[];
  deniedPaths: PathPattern[];
  execOptions: ExecProfileOptions | null;
  match(phase: PhaseSignal): boolean;
}

/** Capability mask resolved from a phase signal. */
export interface CapabilityMask {
  phase: PhaseSignal;
  allowedOps: Set<"read" | "write" | "spawn">;
}
