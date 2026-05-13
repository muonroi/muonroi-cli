/**
 * src/chat/chat-keychain.ts
 *
 * Chat-service keychain loader with env-var fallback.
 * Parallel module to src/mcp/mcp-keychain.ts but keyed by ChatSecretId
 * (chat services like Discord, Slack) instead of MCP servers.
 *
 * Priority: OS keychain (keytar) > environment variable > null.
 * On CLI startup, hydrateChatEnvFromKeychain() populates process.env from
 * keychain for any chat secret not already set in env.
 */

import { redactor } from "../utils/redactor.js";

export type ChatSecretId = "discord-token" | "discord-guild-id" | "slack-token" | "slack-team-id";

const KEYCHAIN_SERVICE = "muonroi-cli";

const ACCOUNT_BY_CHAT: Record<ChatSecretId, string> = {
  "discord-token": "chat-discord-token",
  "discord-guild-id": "chat-discord-guild-id",
  "slack-token": "chat-slack-token",
  "slack-team-id": "chat-slack-team-id",
};

const ENV_BY_CHAT: Record<ChatSecretId, string> = {
  "discord-token": "MUONROI_DISCORD_TOKEN",
  "discord-guild-id": "MUONROI_DISCORD_GUILD_ID",
  "slack-token": "MUONROI_SLACK_TOKEN",
  "slack-team-id": "MUONROI_SLACK_TEAM_ID",
};

const MIN_LEN = 8; // guild IDs are short (18-19 digits); tokens ~70 chars. Use 8 as floor.

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword?(service: string, account: string, password: string): Promise<void>;
  deletePassword?(service: string, account: string): Promise<boolean>;
}

async function loadKeytar(): Promise<KeytarLike | null> {
  try {
    return (await import("keytar")) as KeytarLike;
  } catch {
    return null;
  }
}

export async function setChatSecret(id: ChatSecretId, value: string): Promise<boolean> {
  if (!value || value.length < MIN_LEN) {
    throw new Error(`Value for chat secret '${id}' is too short (< ${MIN_LEN} chars).`);
  }
  const kt = await loadKeytar();
  if (!kt?.setPassword) return false;

  // Enroll token values in redactor, but not IDs (they are not secrets)
  if (id === "discord-token" || id === "slack-token") {
    redactor.enrollSecret(value);
  }

  await kt.setPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_CHAT[id], value);
  return true;
}

export async function getChatSecret(id: ChatSecretId): Promise<string | null> {
  const kt = await loadKeytar();
  if (kt) {
    try {
      const v = await kt.getPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_CHAT[id]);
      if (v && v.length >= MIN_LEN) {
        // Enroll in redactor only for token values
        if (id === "discord-token" || id === "slack-token") {
          redactor.enrollSecret(v);
        }
        return v;
      }
    } catch {
      /* keytar backend failure → fall through to env */
    }
  }
  const envKey = process.env[ENV_BY_CHAT[id]];
  if (envKey && envKey.length >= MIN_LEN) {
    // Enroll in redactor only for token values
    if (id === "discord-token" || id === "slack-token") {
      redactor.enrollSecret(envKey);
    }
    return envKey;
  }
  return null;
}

export async function deleteChatSecret(id: ChatSecretId): Promise<boolean> {
  const kt = await loadKeytar();
  if (!kt?.deletePassword) return false;
  return kt.deletePassword(KEYCHAIN_SERVICE, ACCOUNT_BY_CHAT[id]);
}

/**
 * List all stored chat secret IDs.
 * Note: This only returns secrets stored in OS keychain, not those in env.
 */
export async function listChatSecrets(): Promise<ChatSecretId[]> {
  const ids: ChatSecretId[] = ["discord-token", "discord-guild-id", "slack-token", "slack-team-id"];
  const stored: ChatSecretId[] = [];

  for (const id of ids) {
    const v = await getChatSecret(id);
    if (v) {
      stored.push(id);
    }
  }

  return stored;
}

/**
 * On CLI startup, populate process.env from keychain for any chat secret
 * not already set in env. Allows downstream code (chat/factory.ts) to
 * remain env-based without code changes.
 */
export async function hydrateChatEnvFromKeychain(): Promise<void> {
  const ids: ChatSecretId[] = ["discord-token", "discord-guild-id", "slack-token", "slack-team-id"];
  for (const id of ids) {
    const envName = ENV_BY_CHAT[id];
    if (process.env[envName]) continue; // env wins
    const v = await getChatSecret(id);
    if (v) process.env[envName] = v;
  }
}
