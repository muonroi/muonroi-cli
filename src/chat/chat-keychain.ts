/**
 * src/chat/chat-keychain.ts
 *
 * Chat-service secret store, keyed by ChatSecretId (Discord, Slack). Backed by
 * the env-store (`.env` file + process.env + Windows registry mirror) — the OS
 * keychain (keytar) has been removed. Reads come straight from process.env.
 */

import { clearEnvVar, persistEnvVar } from "../providers/env-store.js";
import { redactor } from "../utils/redactor.js";

export type ChatSecretId = "discord-token" | "discord-guild-id" | "slack-token" | "slack-team-id";

const ENV_BY_CHAT: Record<ChatSecretId, string> = {
  "discord-token": "MUONROI_DISCORD_TOKEN",
  "discord-guild-id": "MUONROI_DISCORD_GUILD_ID",
  "slack-token": "MUONROI_SLACK_TOKEN",
  "slack-team-id": "MUONROI_SLACK_TEAM_ID",
};

const MIN_LEN = 8; // guild IDs are short (18-19 digits); tokens ~70 chars. Use 8 as floor.

function isTokenSecret(id: ChatSecretId): boolean {
  return id === "discord-token" || id === "slack-token";
}

export async function setChatSecret(id: ChatSecretId, value: string): Promise<boolean> {
  if (!value || value.length < MIN_LEN) {
    throw new Error(`Value for chat secret '${id}' is too short (< ${MIN_LEN} chars).`);
  }
  if (isTokenSecret(id)) redactor.enrollSecret(value);
  persistEnvVar(ENV_BY_CHAT[id], value);
  return true;
}

export async function getChatSecret(id: ChatSecretId): Promise<string | null> {
  const envKey = process.env[ENV_BY_CHAT[id]];
  if (envKey && envKey.length >= MIN_LEN) {
    if (isTokenSecret(id)) redactor.enrollSecret(envKey);
    return envKey;
  }
  return null;
}

export async function deleteChatSecret(id: ChatSecretId): Promise<boolean> {
  const had = !!process.env[ENV_BY_CHAT[id]];
  clearEnvVar(ENV_BY_CHAT[id]);
  return had;
}

/**
 * List all stored chat secret IDs (those present in the environment).
 */
export async function listChatSecrets(): Promise<ChatSecretId[]> {
  const ids: ChatSecretId[] = ["discord-token", "discord-guild-id", "slack-token", "slack-team-id"];
  const stored: ChatSecretId[] = [];
  for (const id of ids) {
    if (await getChatSecret(id)) stored.push(id);
  }
  return stored;
}

/**
 * Retained for boot compatibility (index.ts). Chat secrets now live in the
 * environment (loaded from the env-store at startup), so there is nothing to
 * hydrate — this is a no-op.
 */
export async function hydrateChatEnvFromKeychain(): Promise<void> {
  // Intentional no-op: env-store already populated process.env at startup.
}
