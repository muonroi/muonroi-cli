import { isPonytailModeEnabled } from "../../pil/config.js";
import { registerSlash, type SlashHandler } from "./registry.js";

export const handlePonytailSlash: SlashHandler = async (args, _ctx) => {
  const arg = args[0]?.toLowerCase();

  if (arg === "on") {
    process.env.MUONROI_PONYTAIL_DISABLE = "0";
    return "✅ Ponytail Mode enabled (Lazy Senior mode). The agent will enforce YAGNI and prioritize standard libraries.";
  }

  if (arg === "off") {
    process.env.MUONROI_PONYTAIL_DISABLE = "1";
    return "❌ Ponytail Mode disabled. The agent is free to propose complex architectures and dependencies.";
  }

  // Status check
  const status = isPonytailModeEnabled() ? "ON (enabled)" : "OFF (disabled)";
  return `Ponytail Mode is currently: **${status}**\nUsage: \`/ponytail on\` or \`/ponytail off\``;
};

// Self-register on module import
registerSlash("ponytail", handlePonytailSlash);
