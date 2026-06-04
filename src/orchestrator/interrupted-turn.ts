/**
 * src/orchestrator/interrupted-turn.ts
 *
 * When an agent turn is abandoned mid-flight — a model stall (the stall-watchdog
 * surfaces an "abort" stream part) or an unrecoverable stream error — the
 * orchestrator used to `return` without persisting anything. The turn's work
 * (tool calls + on-disk edits) then left NO trace in conversation history, so
 * the NEXT user turn was amnesiac: live obs (2026-06-04, deepseek-v4-flash) the
 * model literally answered "there was no previous turn in this session" and
 * re-did the work from scratch, leaving the earlier edit orphaned.
 *
 * The fix persists at least this note as the assistant turn, so the next turn
 * (a) knows a prior turn happened, and (b) is warned the work may be partially
 * applied and must be re-checked rather than blindly redone.
 *
 * Pure + tiny so it is unit-testable; the orchestrator wires it into the stall
 * return path.
 */
export function buildInterruptedTurnNote(assistantText: string, toolCallNames: readonly string[]): string {
  const base = (assistantText ?? "").trim();
  const names = (toolCallNames ?? []).filter(Boolean);
  const uniq = [...new Set(names)];
  const tail = uniq.length
    ? `[Previous turn was interrupted (model stall) after ${names.length} tool call(s) (${uniq.slice(0, 8).join(", ")}${uniq.length > 8 ? ", …" : ""}). File changes may be PARTIALLY applied — re-check current state before redoing anything.]`
    : "[Previous turn was interrupted (model stall) before completing. Re-check current state before redoing anything.]";
  return base ? `${base}\n\n${tail}` : tail;
}
