import { getRoleModels } from "../../utils/settings.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleCouncilSlash: SlashHandler = async (args, ctx) => {
  let rounds: number | undefined;
  const firstArg = args[0];
  if (firstArg && /^\d+$/.test(firstArg)) {
    rounds = Math.max(1, Math.min(5, parseInt(firstArg, 10)));
    args = args.slice(1);
  }

  const topic = args.join(" ") || ctx.lastPrompt || "";
  if (!topic) {
    return "/council [rounds] <topic> — multi-model adversarial debate\nExample: /council 3 REST vs gRPC for our microservices";
  }

  const roles = getRoleModels();
  if (Object.keys(roles).length === 0) {
    return "/council: no roleModels configured. Add to ~/.muonroi-cli/user-settings.json:\n" +
      '  "roleModels": { "leader": "claude-sonnet-4-6", "implement": "deepseek-chat", "verify": "gpt-4o", "research": "grok-3" }';
  }

  return `__COUNCIL__\n${rounds ?? ""}\n${topic}`;
};

registerSlash("council", handleCouncilSlash);
