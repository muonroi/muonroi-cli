import type { KeyEvent } from "@opentui/core";
import type { ScheduleDaemonStatus, StoredSchedule } from "../../tools/schedule.js";
import type { ChatEntry, CouncilQuestionData, ToolCall, ToolResult } from "../../types/index.js";
import type { CouncilCardKey } from "../components/council-question-card.js";

export function formatScheduleDetails(schedule: StoredSchedule, daemonStatus: ScheduleDaemonStatus): string {
  const daemonText = daemonStatus.running
    ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}`
    : "not running";
  return [
    `Schedule: ${schedule.name}`,
    `ID: ${schedule.id}`,
    `Type: ${schedule.cron ? "recurring" : "one-time"}`,
    `Cron: ${schedule.cron ?? "runs once immediately"}`,
    `Enabled: ${schedule.enabled ? "yes" : "no"}`,
    `Model: ${schedule.model}`,
    `Directory: ${schedule.directory}`,
    `Last run: ${schedule.lastRunAt ?? "never"}`,
    `Daemon: ${daemonText}`,
    "",
    "Instruction:",
    schedule.instruction,
  ].join("\n");
}

/**
 * Render the user's AskCard answer for inclusion in the chat log.
 *
 * For choice-kind answers we used to display the bare verb ("accept",
 * "override", "skip") which makes the log meaningless when 6 cards in a row
 * resolve as "accept / accept / accept …" — the user can't tell what they
 * actually agreed to. Now we append the selected option's label when one is
 * known, so the entry becomes e.g. `accept · productType="internal-tool"` or
 * `override · "consumer-app"`.
 *
 * The `questionId` (when provided) is normalized to a short prefix so the
 * entry remains scannable, e.g. `accept · targetPlatform=["cli"]`.
 */
export function formatAnswerForLog(
  ans: { kind: string; text: string },
  ctx?: { selectedOptionLabel?: string; questionId?: string },
): string {
  if (ans.kind === "freetext") return ans.text || "(empty)";
  if (ans.kind === "chat") return "[Chat about this]";
  const verb = ans.text;
  const label = ctx?.selectedOptionLabel?.trim();
  if (!label || label === verb) return verb;
  // Single line — labels carry value + rationale tail; keep echo to the value.
  const valueOnly = label.split("—")[0].trim().replace(/\s+/g, " ");
  if (ctx?.questionId) {
    return `${verb} · ${ctx.questionId}=${valueOnly}`;
  }
  return `${verb} · ${valueOnly}`;
}

export function buildAssistantEntry(content: string, extra?: Partial<ChatEntry>): ChatEntry {
  return { type: "assistant", content, timestamp: new Date(), ...extra };
}

export function buildToolResultEntry(
  toolCall: ToolCall,
  toolResult: ToolResult,
  extra?: Partial<ChatEntry>,
): ChatEntry {
  const output = toolResult.output ?? (toolResult.error ? `Error: ${toolResult.error}` : "");
  return {
    type: "tool_result",
    content: typeof output === "string" ? output : String(output),
    timestamp: new Date(),
    toolCall,
    toolResult,
    ...extra,
  };
}

export function buildUserEntry(content: string, extra?: Partial<ChatEntry>): ChatEntry {
  return { type: "user", content, timestamp: new Date(), ...extra };
}

export function buildPreflightQuestion(pf: {
  preflightId: string;
  problemStatement: string;
  participants: Array<{ role: string; model: string }>;
}): CouncilQuestionData {
  return {
    questionId: pf.preflightId,
    phase: "preflight",
    question: `Approve discussion plan for: ${pf.problemStatement}`,
    context: pf.participants.length > 0 ? `Participants: ${pf.participants.map((p) => p.role).join(", ")}` : undefined,
    options: [
      { label: "Approve", value: "approve", kind: "choice", description: "Start the debate now" },
      { label: "Reject", value: "reject", kind: "choice", description: "Cancel and rewrite the topic" },
    ],
    isRequired: true,
    defaultIndex: 0,
  };
}

export function mapCouncilCardKey(key: KeyEvent): CouncilCardKey | null {
  if (key.name === "up") return { kind: "up" };
  if (key.name === "down") return { kind: "down" };
  if (key.name === "return") return { kind: "enter" };
  if (key.name === "escape") return { kind: "escape" };
  if (key.name === "backspace" || key.name === "delete") return { kind: "backspace" };
  // Printable single character (letters, digits, space, etc.).
  if (typeof key.sequence === "string" && key.sequence.length === 1 && key.sequence >= " " && key.sequence !== "\x7f") {
    return { kind: "char", ch: key.sequence };
  }
  return null;
}
