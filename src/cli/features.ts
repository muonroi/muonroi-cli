/** Discovery only: these entry points run inside the interactive session. */
export function featureGuide(feature?: string): string {
  const entries = {
    council:
      "/council [rounds] <topic> — multi-model discussion inside the TUI. The agent can also use native convene_council. /council inspect <session-id> inspects a saved discussion.",
    ideal:
      "/ideal <idea> — start the product loop inside the TUI. /ideal status, /ideal resume [runId], and /ideal abort <runId> manage runs.",
  };
  if (feature && !Object.hasOwn(entries, feature))
    throw new Error(`Unknown feature: ${feature}. Choose council or ideal.`);
  return [
    "In-session features (discovery only; this command starts no models or workers):",
    "Start muonroi-cli interactively, then enter the slash command.",
    ...(feature ? [entries[feature as keyof typeof entries]] : Object.values(entries)),
    "These are TUI slash commands/native tools, not executable top-level CLI subcommands.",
    "Unrecognized positional words are initial prompt text; global --help describes the root CLI, not proof of a named feature.",
  ].join("\n");
}
