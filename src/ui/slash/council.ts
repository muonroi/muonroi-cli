import { getCouncilLanguage, normalizeCouncilLanguage, saveUserSettings } from "../../utils/settings.js";
import { handleCouncilInspectSlash } from "./council-inspect.js";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export const handleCouncilSlash: SlashHandler = async (args, ctx) => {
  // Sub-command matching is case-folded HERE rather than relying on the caller
  // handing down a pre-lowercased argv — that used to be true and is what
  // destroyed the casing of every topic (see the argsText note below).
  const sub = args[0]?.toLowerCase();

  // Delegate sub-command: /council inspect <session-id>
  if (sub === "inspect") {
    return handleCouncilInspectSlash(args.slice(1), ctx);
  }

  // Feature B — /council lang [value] : read or set the debate language.
  // The chosen language IS the debate language (no translate pass).
  if (sub === "lang" || sub === "language") {
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

  // The topic is prose the user wrote — take it VERBATIM from `argsText`, not
  // from `args.join(" ")`. The join collapses every line break, so a pasted
  // multi-line brief (a spec with numbered rules, fenced blocks, a bullet list
  // of paths) arrived as one unreadable run-on line and became the debate's
  // topic string. `args` remains the fallback for callers that supply no
  // argsText (tests, MCP).
  let rounds: number | undefined;
  let topicText = ctx.argsText ?? args.join(" ");
  const firstArg = args[0];
  if (firstArg && /^\d+$/.test(firstArg)) {
    rounds = Math.max(1, Math.min(5, parseInt(firstArg, 10)));
    args = args.slice(1);
    // Strip the same leading round-count token off the verbatim text.
    topicText = topicText.replace(/^\s*\d+\s*/, "");
  }

  const topic = topicText.trim() || ctx.lastPrompt || "";
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
