/**
 * Permission mode controls which tool calls require manual approval before execution.
 *
 * safe      - Every tool call prompts the user for approval.
 * auto-edit - File operation tools (read/write/edit/grep/list) auto-approve;
 *             shell execution auto-approves for non-dangerous commands;
 *             computer tools still require confirmation.
 * yolo      - All tool calls auto-approve without any prompting.
 */
import { appendDecisionLog } from "../usage/decision-log.js";

export type PermissionMode = "safe" | "auto-edit" | "yolo";

/**
 * Set of tool names that are auto-approved in auto-edit mode.
 * These are read/write file operations that are considered safe to run
 * without manual confirmation when the user has opted into auto-edit mode.
 */
export const AUTO_EDIT_ALLOWED: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "list_directory",
]);

/**
 * Catastrophic commands: unrecoverable operations that are ALWAYS hard-blocked
 * at the tool layer regardless of permission mode (safe/auto-edit/yolo).
 *
 * These are patterns where the potential for irreversible damage to the host
 * system is high enough that no user approval dialog is sufficient — they must
 * never execute. This list intentionally errs on the side of caution.
 *
 * Override: set MUONROI_ALLOW_CATASTROPHIC=1 to bypass (not recommended;
 * intended only for explicit test harness scenarios).
 */
const CATASTROPHIC_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Disk / filesystem destruction
  {
    pattern: /\bdd\b[^|&;\n]*\bof=\/dev\//i,
    reason: "dd writing to a raw device can destroy disk contents irreversibly.",
  },
  {
    pattern: /\bmkfs\b/i,
    reason: "mkfs formats a filesystem, destroying all data on the target device.",
  },
  // Fork bomb — classic bash pattern: :(){ :|:& };:
  // Match the defining signature: a function named `:` that calls itself recursively.
  // This is tight enough to avoid false positives on URLs containing `:/`.
  {
    pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/,
    reason: "Fork bomb pattern detected — would exhaust host process table.",
  },
  // Remote code execution via piped shell
  {
    pattern: /\bcurl\b[^|&;\n]*\|\s*(?:ba)?sh\b/i,
    reason: "curl piped to a shell executes arbitrary remote code without inspection.",
  },
  {
    pattern: /\bwget\b[^|&;\n]*\|\s*(?:ba)?sh\b/i,
    reason: "wget piped to a shell executes arbitrary remote code without inspection.",
  },
  // Privilege escalation
  {
    pattern: /\bsudo\s+/i,
    reason: "sudo privilege escalation is not permitted from the agent shell.",
  },
  {
    pattern: /\bsu\s+-\s*/i,
    reason: "su to root is not permitted from the agent shell.",
  },
  // Persistence mechanisms — block crontab edits/writes; allow only -l (list, read-only)
  // crontab <file>, crontab -, crontab -e all create/modify the crontab.
  {
    pattern: /\bcrontab\b(?!\s+-l\b)/i,
    reason: "crontab write/edit commands create persistent execution outside the session.",
  },
  {
    pattern: /\/etc\/(?:rc\.d|init\.d|systemd|cron)/i,
    reason: "Writing to system init or cron directories would create persistence.",
  },
  // Reverse shells
  {
    pattern: /\bnc\b[^|&;\n]*(?:-e|-c)\s+/i,
    reason: "nc with -e/-c flag can open a reverse shell.",
  },
  {
    pattern: /\bsocat\b[^|&;\n]*(?:EXEC|SYSTEM):/i,
    reason: "socat with EXEC/SYSTEM can open a reverse shell.",
  },
  {
    pattern: /\/dev\/tcp\//i,
    reason: "Bash /dev/tcp redirect can open a covert reverse shell connection.",
  },
  // Exfiltration of credentials / secrets directories
  {
    pattern: /(?:tar|zip|gzip|rsync|scp|sftp|ftp)\b[^|&;\n]*\.(?:muonroi-cli|ssh|gnupg|aws|kube)/i,
    reason: "Archiving or uploading credential directories is not permitted.",
  },
];

/**
 * Structured block result returned by safety checks.
 * `null` means the command is safe to proceed.
 */
export interface SafetyBlockResult {
  /** Machine-readable kind for routing to the right askcard layout. */
  kind: "catastrophic" | "dangerous" | "git-safety" | "empty-bash";
  /** Human-readable reason explaining why it was blocked. */
  reason: string;
  /** The original command text that was blocked. */
  command: string;
}

/**
 * Returns a SafetyBlockResult if `command` matches a catastrophic
 * pattern, or `null` if the command is safe to proceed.
 *
 * This is checked at the tool layer (BashTool.prepareCommand) and is
 * independent of the UI-layer permission approval system — it applies even
 * in yolo mode.
 */
export function checkCatastrophicCommand(command: string): SafetyBlockResult | null {
  if (process.env.MUONROI_ALLOW_CATASTROPHIC === "1") return null;
  for (const { pattern, reason } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(command)) {
      return { kind: "catastrophic", reason, command };
    }
  }
  return null;
}

/**
 * Check a command against the "dangerous" patterns used by `toolNeedsApproval`.
 * These are less severe than catastrophic but should still prompt for approval
 * in safe / auto-edit modes.
 *
 * Returns a SafetyBlockResult or null if safe.
 */
export function checkDangerousCommand(command: string): SafetyBlockResult | null {
  const dangerousPatterns: RegExp[] = [
    // Filesystem destruction
    /rm\s+-rf?\s+\/(?!tmp|var\/tmp)/i,
    // Unrestricted chmod
    /chmod\s+(?:777|a\+[rwx])/i,
    // Code injection
    /eval\s*\(/i,
    /exec\s*\(/i,
    // External network fetches (non-local)
    /curl\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
    /wget\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
    // Process substitution with external commands
    /\$\([^)]*(?:curl|wget|nc|socat)[^)]*\)/i,
    // Writing to /etc (besides allowed subdirs)
    /\bchown\s+root/i,
  ];
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      return {
        kind: "dangerous",
        reason: `Command matched dangerous pattern: ${pattern.source}`,
        command,
      };
    }
  }
  return null;
}

/**
 * Check if a command is a safety-blocked git operation (push-on-red, broad staging).
 */
export function checkGitSafetyCommand(command: string, gitSafetyKey: string): SafetyBlockResult | null {
  // Lazy import to avoid circular deps at module level
  const { analyzeGitCommand, checkPushGate, checkSensitiveStaging } = require_inline_safety_deps();
  const gt = analyzeGitCommand(command);
  if (gt.isPush) {
    const gate = checkPushGate(gitSafetyKey);
    if (gate.blocked) {
      return {
        kind: "git-safety",
        reason: `git push blocked: ${gate.failed.join(", ")}`,
        command,
      };
    }
  }
  return null;
}

// Inline require to avoid circular dependency at module load.
function require_inline_safety_deps() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../tools/git-safety.js") as typeof import("../tools/git-safety.js");
  return mod;
}

/**
 * Returns true if the given tool call requires manual user approval
 * under the specified permission mode.
 *
 * @param toolName - The name of the tool being invoked.
 * @param mode     - The active PermissionMode.
 * @param context  - Optional context (command string for bash, path, isNetwork).
 *                   Backward compatible: old callers passing 2 args unchanged.
 * @returns true if the tool needs user approval, false if it should auto-approve.
 */
export function toolNeedsApproval(
  toolName: string,
  mode: PermissionMode,
  context?: { command?: string; path?: string; isNetwork?: boolean },
): boolean {
  const dangerous = (cmd?: string): boolean => {
    if (!cmd) return false;
    const patterns: RegExp[] = [
      // Filesystem destruction
      /rm\s+-rf?\s+\/(?!tmp|var\/tmp)/i,
      // Unrestricted chmod
      /chmod\s+(?:777|a\+[rwx])/i,
      // Code injection
      /eval\s*\(/i,
      /exec\s*\(/i,
      // External network fetches (non-local)
      /curl\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
      /wget\s+https?:\/\/(?!127\.0\.0\.1|localhost)/i,
      // Process substitution with external commands
      /\$\([^)]*(?:curl|wget|nc|socat)[^)]*\)/i,
      // Writing to /etc (besides allowed subdirs)
      /\bchown\s+root/i,
    ];
    return patterns.some((p) => p.test(cmd));
  };

  if (mode === "yolo") {
    if (dangerous(context?.command)) {
      appendAudit({
        kind: "yolo-override",
        tool: toolName,
        mode,
        context,
        ts: Date.now(),
      });
    }
    return false;
  }
  if (mode === "auto-edit") {
    // bash auto-approves when non-dangerous; only dangerous bash needs approval
    if (toolName === "bash") return dangerous(context?.command);
    return !AUTO_EDIT_ALLOWED.has(toolName);
  }
  // "safe" — always confirm; dangerous patterns explicitly require (no bypass)
  if (dangerous(context?.command)) return true;
  return true;
}

type AuditEvent = {
  kind: "permission-override" | "yolo-override";
  tool: string;
  mode: PermissionMode;
  context?: any;
  ts: number;
};

export function appendAudit(event: AuditEvent): void {
  // fire-and-forget; must not block sync approval decision path
  appendDecisionLog({
    ts: event.ts,
    kind: event.kind as any,
    taken: true,
    reason: `${event.kind} for ${event.tool} under ${event.mode}`,
    meta: { context: event.context },
  }).catch(() => {
    // swallow per decision-log contract
  });
}
