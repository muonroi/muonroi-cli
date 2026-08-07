/**
 * src/mcp/mcp-keychain.ts
 *
 * Per-MCP key store, keyed by McpKeyId (MCP servers like Tavily). Backed by the
 * env-store (`.env` file + process.env + Windows registry mirror) — the OS
 * keychain (keytar) has been removed. Reads come straight from process.env.
 */

import { clearEnvVar, persistEnvVar } from "../providers/env-store.js";
import { logger } from "../utils/logger.js";
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

/**
 * Whether a usable Tavily API key is configured (keychain/env-store first,
 * falling back to a raw env read). Shared "does Tavily fallback exist" check
 * for every web-capability gate that follows the owner's Part E rule —
 * council clarifier scope-research (`clarifier.ts`) and the council debate
 * research phase (`debate.ts`). Threshold is intentionally looser (10 chars)
 * than `getMcpKey`'s own `MIN_KEY_LEN` gate (16) because it also accepts a
 * raw `TAVILY_API_KEY` env value that never went through `setMcpKey`.
 */
export async function hasTavilyKey(): Promise<boolean> {
  try {
    const k = ((await getMcpKey("tavily")) || process.env.TAVILY_API_KEY || "").trim();
    return k.length >= 10;
  } catch (err) {
    logger.error("mcp", `mcp-keychain: hasTavilyKey check failed: ${(err as Error)?.message}`, {
      stack: (err as Error)?.stack?.split("\n").slice(0, 3),
    });
    return (process.env.TAVILY_API_KEY ?? "").trim().length >= 10;
  }
}
