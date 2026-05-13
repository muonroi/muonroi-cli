import { setChatSecret } from "../src/chat/chat-keychain.js";

const map: Record<string, "discord-token" | "discord-guild-id" | "slack-token" | "slack-team-id"> = {
  MUONROI_DISCORD_TOKEN: "discord-token",
  MUONROI_DISCORD_GUILD_ID: "discord-guild-id",
  MUONROI_SLACK_TOKEN: "slack-token",
  MUONROI_SLACK_TEAM_ID: "slack-team-id",
};

let stored = 0;
for (const [envName, id] of Object.entries(map)) {
  const v = process.env[envName];
  if (!v) continue;
  try {
    const ok = await setChatSecret(id, v.trim());
    console.log(`${ok ? "✓" : "✗"} ${id.padEnd(20)} ← $env:${envName}  (${v.slice(0, 6)}…${v.slice(-4)})`);
    if (ok) stored++;
  } catch (err) {
    console.log(`✗ ${id.padEnd(20)} ${(err as Error).message}`);
  }
}
console.log(`\nStored ${stored} chat secret(s) to OS keychain.`);
