/**
 * /pin and /pins slash commands.
 *
 * /pin           — pins the most recent user message; survives compaction.
 * /pin <seq>     — pins a specific user message by sequence number.
 * /unpin <seq>   — removes a pin.
 * /pins          — lists currently pinned message sequences.
 *
 * Returns sentinel signals that app.tsx dispatches to the orchestrator,
 * since slash handlers don't hold an Orchestrator reference.
 */

import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handlePinSlash: SlashHandler = async (args) => {
  if (args.length === 0) {
    return "__PIN_LAST__";
  }
  const seq = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(seq) || seq <= 0) {
    return "Usage: /pin [<seq>]\n  /pin            pin the last user message\n  /pin <seq>      pin a specific message by sequence number";
  }
  return `__PIN_SEQ__\n${seq}`;
};

export const handleUnpinSlash: SlashHandler = async (args) => {
  const seq = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isFinite(seq) || seq <= 0) {
    return "Usage: /unpin <seq>";
  }
  return `__UNPIN_SEQ__\n${seq}`;
};

export const handlePinsListSlash: SlashHandler = async () => {
  return "__PINS_LIST__";
};

registerSlash("pin", handlePinSlash);
registerSlash("unpin", handleUnpinSlash);
registerSlash("pins", handlePinsListSlash);
