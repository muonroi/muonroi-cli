/**
 * src/orchestrator/safety-askcard.ts
 *
 * Plans an askcard layout when a tool call is blocked by the safety filter
 * (catastrophic, dangerous, git-safety, empty-bash).
 *
 * The askcard gives the user a choice: allow the block once, or confirm the block.
 *
 * Pure — no React, no side effects. Unit-testable in isolation.
 */

export type SafetyBlockKind = "catastrophic" | "destructive-revert" | "dangerous" | "git-safety" | "empty-bash";

export interface SafetyBlockInfo {
  kind: SafetyBlockKind;
  /** The blocked command or tool call description */
  blockedItem: string;
  /** Human-readable reason from the filter */
  reason: string;
  /** Suggested "safe" alternative, if any */
  alternative?: string;
}

export interface SafetyAskcardLayout {
  /** Question shown in the dialog title */
  question: string;
  /** Detail text shown below the question */
  detail: string;
  /** Options in render order. First = default (Enter applies). */
  options: SafetyAskcardOption[];
  /** Index of the default-selected option (0 = first). */
  defaultIndex: number;
}

export interface SafetyAskcardOption {
  label: string;
  value: SafetyAskResult;
  description?: string;
}

export type SafetyAskResult = "allow-once" | "allow-session" | "block";

const CATEGORY_LABELS: Record<SafetyBlockKind, string> = {
  catastrophic: "Lỗi bảo mật nghiêm trọng",
  "destructive-revert": "Hủy thay đổi chưa lưu (không thể hoàn tác)",
  dangerous: "Lệnh nguy hiểm",
  "git-safety": "Git safety gate",
  "empty-bash": "Bash call trống",
};

/**
 * Plan the askcard layout for a safety block.
 * Pure function — easy to unit test and swap UI strategies.
 */
export function planSafetyAskcard(info: SafetyBlockInfo): SafetyAskcardLayout {
  const kindLabel = CATEGORY_LABELS[info.kind];
  const cmdPreview = info.blockedItem.length > 120 ? `${info.blockedItem.slice(0, 117)}...` : info.blockedItem;

  const question = `⚠️  ${kindLabel}: Cho phép thực thi?`;

  const detailLines: string[] = [`Lệnh bị chặn: \`${cmdPreview}\``, `Lý do: ${info.reason}`];
  if (info.alternative) {
    detailLines.push(`Gợi ý thay thế: ${info.alternative}`);
  }

  const options: SafetyAskcardOption[] = [
    {
      label: "Cho phép 1 lần (Allow once)",
      value: "allow-once",
      description: "Chỉ chạy lệnh này một lần duy nhất",
    },
    {
      label: "Chặn (Block)",
      value: "block",
      description: "Không chạy lệnh này, trả về lỗi cho agent",
    },
  ];

  // Allow-session only for less severe blocks. A destructive-revert (discards
  // uncommitted work irreversibly) is treated like catastrophic: allow-once
  // only, never a blanket session allow.
  if (info.kind !== "catastrophic" && info.kind !== "destructive-revert") {
    options.splice(1, 0, {
      label: "Cho phép cả phiên (Allow session)",
      value: "allow-session",
      description: "Cho phép tất cả lệnh tương tự trong phiên này",
    });
  }

  return {
    question,
    detail: detailLines.join("\n"),
    options,
    defaultIndex: options.findIndex((o) => o.value === "block"),
  };
}

// --- Types shared between message-processor (askcard trigger) and app.tsx (UI) ---

/** Info passed to the safety-override handler when a tool block is detected. */
export interface SafetyOverrideAskInfo {
  kind: SafetyBlockKind;
  /** The blocked tool name (e.g. "bash", "edit_file"). */
  toolName: string;
  /** The command/args that were blocked. */
  blockedItem: string;
  /** Human-readable reason from the filter. */
  reason: string;
  /** Source block kind tag for the agent to decide retry. */
  source: "bash.execute" | "registry.precheck";
}

/** Verdict the UI returns after the user answers the askcard. */
export type SafetyOverrideVerdict = { action: "allow-once" } | { action: "allow-session" } | { action: "block" };

/**
 * Build a safe alternative suggestion for a blocked command.
 * Returns null when no canned alternative exists.
 */
export function suggestAlternative(kind: SafetyBlockKind, command: string): string | undefined {
  if (kind === "empty-bash") {
    return 'Provide a real command, e.g. {"command":"ls -la"}';
  }
  // sqlite3 / .db access on Windows
  if (/sqlite3|\.db\b/i.test(command)) {
    return "Use the filesystem MCP or write_file to read the DB file instead of shelling sqlite3";
  }
  // rm -rf patterns
  if (/rm\s+-rf/i.test(command)) {
    return "Explicitly list files to remove, or use move to trash";
  }
  return undefined;
}
