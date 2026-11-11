/** Actual caller identity only. Never fabricate a registered agent or terminal pane. */
export function mcpIdentityEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["AG_NAME", "AG_PANE", "AG_BUS_DB", "TMUX_PANE"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  );
}
