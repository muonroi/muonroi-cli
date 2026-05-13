import { handleCouncilInspectSlash } from "./council-inspect.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleCouncilSlash: SlashHandler = async (args, ctx) => {
  // Delegate sub-command: /council inspect <session-id>
  if (args[0] === "inspect") {
    return handleCouncilInspectSlash(args.slice(1), ctx);
  }

  let rounds: number | undefined;
  const firstArg = args[0];
  if (firstArg && /^\d+$/.test(firstArg)) {
    rounds = Math.max(1, Math.min(5, parseInt(firstArg, 10)));
    args = args.slice(1);
  }

  const topic = args.join(" ") || ctx.lastPrompt || "";
  if (!topic) {
    return (
      "/council [rounds] <topic> — multi-model discussion\n" +
      "Default: uses models from the same provider. Set councilPreferMultiProvider + roleModels for cross-provider.\n" +
      "Example: /council 3 REST vs gRPC for our microservices"
    );
  }

  return `__COUNCIL__\n${rounds ?? ""}\n${topic}`;
};

registerSlash("council", handleCouncilSlash);
