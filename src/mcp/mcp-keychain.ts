/**
 * src/mcp/mcp-keychain.ts
 *
 * Per-MCP keychain loader with env-var fallback.
 * Parallel module to src/providers/keychain.ts but keyed by McpKeyId
 * (MCP servers like Tavily) instead of ProviderId (LLM providers).
 *
 * Priority: OS keychain (keytar) > environment variable > null.
 */

import { redactor } from "../utils/redactor.js";

export type McpKeyId = "tavily";

const KEYCHAIN_SERVICE = "muonroi-cli";

const ACCOUNT_BY_MCP: Record<McpKeyId, string> = {
  tavily: "mcp-tavily",
};

const ENV_BY_MCP: Record<McpKeyId, string> = {
  tavily: "TAVILY_API_KEY",
};

const MIN_KEY_LEN = 16;

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

export async function setMcpKey(id: McpKeyId, key: string): Promise<boolean> {
  if (!key || key.length < MIN_KEY_LEN) {
    throw new Error(`Key for MCP '${id}' is too short (< ${MIN_KEY_LEN} chars).`);
  }
  const kt = await loadKeytar();
  if (!kt?.setPassword) return false;
  redactor.enrollSecret(key);
  try {
    await kt.setPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_MCP[id], key);
    return true;
  } catch (err: any) {
    // Runtime backend failure (e.g. Linux without libsecret or no active secret service).
    if (process.env.DEBUG || process.env.MUONROI_DEBUG_KEYCHAIN) {
      console.error(`[mcp-keychain] setPassword backend error for ${id}:`, err?.message || err);
    }
    return false;
  }
}

export async function getMcpKey(id: McpKeyId): Promise<string | null> {
  const kt = await loadKeytar();
  if (kt) {
    try {
      const k = await kt.getPassword(KEYCHAIN_SERVICE, ACCOUNT_BY_MCP[id]);
      if (k && k.length >= MIN_KEY_LEN) {
        redactor.enrollSecret(k);
        return k;
      }
    } catch {
      /* keytar backend failure → fall through to env */
    }
  }
  const envKey = process.env[ENV_BY_MCP[id]];
  if (envKey && envKey.length >= MIN_KEY_LEN) {
    redactor.enrollSecret(envKey);
    return envKey;
  }
  return null;
}

export async function deleteMcpKey(id: McpKeyId): Promise<boolean> {
  const kt = await loadKeytar();
  if (!kt?.deletePassword) return false;
  return kt.deletePassword(KEYCHAIN_SERVICE, ACCOUNT_BY_MCP[id]);
}
