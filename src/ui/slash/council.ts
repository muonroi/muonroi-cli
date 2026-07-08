import { getCouncilLanguage, normalizeCouncilLanguage, saveUserSettings } from "../../utils/settings.js";
import { handleCouncilInspectSlash } from "./council-inspect.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleCouncilSlash: SlashHandler = async (args, ctx) => {
  // Delegate sub-command: /council inspect <session-id>
  if (args[0] === "inspect") {
    return handleCouncilInspectSlash(args.slice(1), ctx);
  }

  // Feature B — /council lang [value] : read or set the debate language.
  // The chosen language IS the debate language (no translate pass).
  if (args[0] === "lang" || args[0] === "language") {
    const value = args.slice(1).join(" ").trim();
    if (!value) {
      const current = getCouncilLanguage();
      return (
        `Council debate language: ${current}\n` +
        `- "auto" (default): debate + conclusion follow the language of your prompt.\n` +
        `- "english": force the historical English-only debate.\n` +
        `- <locale> (e.g. "vietnamese", "日本語"): pin the debate to that language.\n` +
        `Set with: /council lang <value>`
      );
    }
    const normalized = normalizeCouncilLanguage(value);
    saveUserSettings({ councilLanguage: normalized });
    return `Council debate language set to: ${normalized}`;
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
      "Default: multi-provider lineup from catalog (implement/verify/research across providers).\n" +
      "Override via roleModels in settings, or councilPreferMultiProvider: false for same-provider.\n" +
      "Example: /council 3 REST vs gRPC for our microservices"
    );
  }

  return `__COUNCIL__\n${rounds ?? ""}\n${topic}`;
};

registerSlash("council", handleCouncilSlash);
