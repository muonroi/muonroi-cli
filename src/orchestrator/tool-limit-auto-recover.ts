/**
 * Decide whether a tool-loop halt should be auto-recovered by compacting the
 * history and continuing, instead of stopping and asking the user to /compact.
 *
 * Only STEP-LIMIT halts recover (the agent is making progress but ran out of
 * round budget). PATTERN-loop halts never recover — the agent is stuck in a
 * repeated call and more steps won't help. A cap bounds the number of
 * auto-recoveries per turn so a genuinely runaway turn still terminates.
 */
/**
 * How many times a single turn may auto-compact-and-continue on a "cap" halt
 * before it stops and returns the best answer. Each auto-recovery resets
 * context to O(N) input (cheap), so a productive long task can sustain many
 * cycles without a cost runaway — genuine loops trip the pattern guard, which
 * is NOT auto-recovered. Default 6 (raised from the historical 2, which
 * stranded long tasks after ~2 compactions). Override with
 * MUONROI_TOOL_LIMIT_AUTO_RECOVER_CAP (clamped to [1, 50]).
 */
export function getToolLimitAutoRecoverCap(): number {
  const raw = Number(process.env.MUONROI_TOOL_LIMIT_AUTO_RECOVER_CAP);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(50, Math.floor(raw));
  return 6;
}

export function shouldAutoRecoverToolLimit(
  info: { kind: "cap" | "pattern" },
  autoRecoverCount: number,
  cap: number,
): boolean {
  if (info.kind === "pattern") return false; // agent stuck — compaction won't help
  return autoRecoverCount < cap; // "cap" = tool-round ceiling → recover while budget remains
}
