/**
 * Decide whether a tool-loop halt should be auto-recovered by compacting the
 * history and continuing, instead of stopping and asking the user to /compact.
 *
 * Only STEP-LIMIT halts recover (the agent is making progress but ran out of
 * round budget). PATTERN-loop halts never recover — the agent is stuck in a
 * repeated call and more steps won't help. A cap bounds the number of
 * auto-recoveries per turn so a genuinely runaway turn still terminates.
 */
export function shouldAutoRecoverToolLimit(
  info: { kind: "cap" | "pattern" },
  autoRecoverCount: number,
  cap: number,
): boolean {
  if (info.kind === "pattern") return false; // agent stuck — compaction won't help
  return autoRecoverCount < cap; // "cap" = tool-round ceiling → recover while budget remains
}
