// ---------------------------------------------------------------------------
// MCP key requirements — coherent handling of "enabled but no key" servers.
// ---------------------------------------------------------------------------
// A server that needs an API key it does not have is NOT an error — it is
// unconfigured. Treating it as a per-turn connection failure (the old behavior)
// produced a "⚠️ tavily unavailable: TAVILY_API_KEY is missing" nag on every
// warmup with no in-app fix. Instead we partition such servers OUT of the
// connect set before attempting a connection, surface them once as an
// actionable `needsKey` list (consumed by the TUI's inline fix card + a
// one-time console notice), and let the native builtin (e.g. web_search)
// cover the capability in the meantime.
// ---------------------------------------------------------------------------

import type { McpServerConfig } from "../utils/settings.js";
import { getMcpKey, type McpKeyId } from "./mcp-keychain.js";

/** Minimum plausible length for a real API key (rejects blanks/placeholders). */
const MIN_KEY_LEN = 16;

/**
 * Servers whose stdio process requires an API key. `keyId` is the keychain slot;
 * `envVar` is injected into the spawned process; `setupHint` is the one-line,
 * actionable guidance shown in the inline fix card and the one-time notice.
 * The native fallback tool keeps the capability available while unconfigured.
 */
export const MCP_KEY_REQUIREMENTS: Record<
  string,
  { keyId: McpKeyId; envVar: string; setupHint: string; nativeFallback?: string }
> = {
  tavily: {
    keyId: "tavily",
    envVar: "TAVILY_API_KEY",
    setupHint: "Add a Tavily key via /mcp (paste inline) or `muonroi-cli mcp key tavily`.",
    nativeFallback: "web_search",
  },
};

/** An enabled server that requires a key it does not currently have. */
export interface MissingKeyServer {
  id: string;
  label: string;
  envVar: string;
  setupHint: string;
  nativeFallback?: string;
  /**
   * Whether the `nativeFallback` tool would actually WORK right now. For Tavily
   * the native `web_search` shares the very same key (it calls the Tavily API
   * directly), so "use built-in" is only truthful when the key is reachable via
   * the process env — the one source the native tool reads that the card's
   * missing-check does not gate on (server.env + keychain are already empty when
   * this card shows). Without this the option promised a working fallback that
   * would immediately error `no_tavily_key`.
   */
  nativeFallbackAvailable?: boolean;
}

/**
 * Resolve whether an enabled server needs a key it does not have. Checks the
 * inline `server.env` value first, then the OS keychain slot. Returns the
 * actionable descriptor when a key is required and missing, else null.
 */
export async function resolveMissingKey(server: McpServerConfig): Promise<MissingKeyServer | null> {
  const req = MCP_KEY_REQUIREMENTS[server.id];
  if (!req) return null;
  const fromEnv = server.env?.[req.envVar];
  if (fromEnv && fromEnv.length >= MIN_KEY_LEN) return null;
  const fromKeychain = await getMcpKey(req.keyId);
  if (fromKeychain && fromKeychain.length >= MIN_KEY_LEN) return null;
  // The native fallback (e.g. web_search) reads the same key from the process
  // env directly, so it only genuinely covers the capability when that env var
  // is set — otherwise it errors identically to the missing MCP server.
  const fromProcessEnv = process.env[req.envVar];
  const nativeFallbackAvailable = !!req.nativeFallback && !!fromProcessEnv && fromProcessEnv.length >= MIN_KEY_LEN;
  return {
    id: server.id,
    label: server.label,
    envVar: req.envVar,
    setupHint: req.setupHint,
    nativeFallback: req.nativeFallback,
    nativeFallbackAvailable,
  };
}

/**
 * Partition the ENABLED servers into those we can attempt to connect and those
 * that are enabled-but-keyless (excluded from the connect attempt so they never
 * register as a per-turn failure). Shared by buildMcpToolSet + the pooled path
 * so both stop nagging identically.
 */
export async function partitionEnabledServers(
  servers: McpServerConfig[],
): Promise<{ connectable: McpServerConfig[]; needsKey: MissingKeyServer[] }> {
  const enabled = servers.filter((s) => s.enabled);
  const connectable: McpServerConfig[] = [];
  const needsKey: MissingKeyServer[] = [];
  for (const s of enabled) {
    const missing = await resolveMissingKey(s);
    if (missing) needsKey.push(missing);
    else connectable.push(s);
  }
  return { connectable, needsKey };
}

// Per-process de-dup so an unconfigured server is announced ONCE, not every turn.
const noticed = new Set<string>();

/** Reset the one-time-notice memory (tests + after a successful key setup). */
export function resetNeedsKeyNotice(id?: string): void {
  if (id) noticed.delete(id);
  else noticed.clear();
}

/**
 * Emit a single, actionable notice per unconfigured server per process — the
 * one-time replacement for the per-turn "⚠️ unavailable" nag. Returns the subset
 * that was actually announced (the rest were already noticed this process), so
 * a caller can also drive a TUI card off the same first-seen signal.
 */
export function noticeNeedsKeyOnce(needsKey: MissingKeyServer[]): MissingKeyServer[] {
  const fresh = needsKey.filter((s) => !noticed.has(s.id));
  for (const s of fresh) {
    noticed.add(s.id);
    // Only advertise the native fallback when it can actually serve the
    // capability (its key is reachable); otherwise the claim is misleading.
    const fallback =
      s.nativeFallback && s.nativeFallbackAvailable ? ` Using the built-in ${s.nativeFallback} until then.` : "";
    console.warn(`[MCP] ${s.label} is off (no API key). ${s.setupHint}${fallback}`);
  }
  return fresh;
}
