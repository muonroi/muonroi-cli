import { DiscordChatProvider } from "../src/chat/providers/discord/client.js";

async function main() {
  const token = process.env.MUONROI_DISCORD_TOKEN;
  const guildId = process.env.MUONROI_DISCORD_GUILD_ID;
  if (!token || !guildId) {
    console.error("Missing MUONROI_DISCORD_TOKEN or MUONROI_DISCORD_GUILD_ID");
    process.exit(1);
  }

  const client = new DiscordChatProvider(token);
  console.log("[1/4] Verifying token via /users/@me ...");
  const userId = await client.getCurrentUserId();
  console.log("  bot user id:", userId);

  console.log("[2/4] Listing channels in guild", guildId, "...");
  const channels = await client.listGuildChannels(guildId);
  console.log(
    "  found",
    channels.length,
    "channels:",
    channels
      .slice(0, 5)
      .map((c) => c.name)
      .join(", "),
  );

  console.log("[3/4] Creating smoke test channel ...");
  const ch = await client.createChannel(guildId, "muonroi-smoke-test", {
    topic: "smoke test from muonroi-cli — safe to delete",
    isPrivate: true,
  });
  console.log("  created channel id:", ch.id);

  console.log("[4/4] Posting hello message ...");
  const msg = await client.postMessage(ch.id, "Hello from muonroi-cli smoke test. Channel can be deleted.");
  console.log("  message id:", msg.id);

  console.log("\nSUCCESS — Discord wiring works. You can delete channel #muonroi-smoke-test manually.");
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err.message);
  if (err.status) console.error("  status:", err.status);
  process.exit(1);
});
