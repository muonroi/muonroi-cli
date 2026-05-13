import { DiscordChatProvider } from "./providers/discord/client.js";
import type { ChatClient } from "./types.js";

export type ChatProviderName = "discord" | "slack";

export function readChatProvider(): ChatClient | null {
  const explicit = process.env.MUONROI_CHAT_PROVIDER?.toLowerCase();
  const token = process.env.MUONROI_DISCORD_TOKEN;
  const guildId = process.env.MUONROI_DISCORD_GUILD_ID;

  // Backward compat: if discord tokens set and no explicit provider, default to discord
  const provider: ChatProviderName | undefined =
    explicit === "discord" || explicit === "slack"
      ? (explicit as ChatProviderName)
      : token && guildId
        ? "discord"
        : undefined;

  if (!provider) return null;

  if (provider === "discord") {
    if (!token || !guildId) {
      if (token || guildId) {
        console.warn("[chat] discord provider selected but MUONROI_DISCORD_TOKEN or MUONROI_DISCORD_GUILD_ID missing");
      }
      return null;
    }
    return new DiscordChatProvider(token);
  }

  if (provider === "slack") {
    console.warn("[chat] slack provider not yet implemented");
    return null;
  }

  return null;
}
