/**
 * src/mcp/mcp-keychain.ts
 *
 * Per-MCP key store, keyed by McpKeyId (MCP servers like Tavily). Backed by the
 * env-store (`.env` file + process.env + Windows registry mirror) — the OS
 * keychain (keytar) has been removed. Reads come straight from process.env.
 */

import { clearEnvVar, persistEnvVar } from "../providers/env-store.js";
import { redactor } from "../utils/redactor.js";

export type McpKeyId = "tavily";

const ENV_BY_MCP: Record<McpKeyId, string> = {
  tavily: "TAVILY_API_KEY",
};

const MIN_KEY_LEN = 16;

export async function setMcpKey(id: McpKeyId, key: string): Promise<boolean> {
  if (!key || key.length < MIN_KEY_LEN) {
    throw new Error(`Key for MCP '${id}' is too short (< ${MIN_KEY_LEN} chars).`);
  }
  persistEnvVar(ENV_BY_MCP[id], key);
  return true;
}

export async function getMcpKey(id: McpKeyId): Promise<string | null> {
  const envKey = process.env[ENV_BY_MCP[id]];
  if (envKey && envKey.length >= MIN_KEY_LEN) {
    redactor.enrollSecret(envKey);
    return envKey;
  }
  return null;
}

export async function deleteMcpKey(id: McpKeyId): Promise<boolean> {
  const had = !!process.env[ENV_BY_MCP[id]];
  clearEnvVar(ENV_BY_MCP[id]);
  return had;
}
