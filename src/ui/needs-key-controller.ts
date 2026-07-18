// ---------------------------------------------------------------------------
// Needs-key card controller — pure logic behind the inline "fix it here" card
// for MCP servers that are enabled but missing their API key.
// ---------------------------------------------------------------------------
// The React side (use-app-logic + McpNeedsKeyCard) only holds keyboard/render
// state; every decision (which actions exist, what a submitted key does) lives
// here so it is unit-testable with mocked deps and reusable outside the TUI.
// Everything generalizes on MissingKeyServer — no server id is special-cased in
// the UI; only the default validator knows Tavily has a real API probe.
// ---------------------------------------------------------------------------

import { MCP_KEY_REQUIREMENTS, type MissingKeyServer, resetNeedsKeyNotice } from "../mcp/key-requirements.js";
import { type McpKeyId, setMcpKey } from "../mcp/mcp-keychain.js";
import { resetNeedsKeyAnnouncements } from "../mcp/needs-key-bus.js";
import { ensureDefaultMcpServers } from "../mcp/auto-setup.js";
import { loadMcpServers, saveMcpServers } from "../utils/settings.js";

/** Minimum plausible API key length — mirrors key-requirements/mcp-keychain. */
export const MIN_MCP_KEY_LEN = 16;

export type NeedsKeyActionId = "paste-key" | "use-builtin" | "disable" | "snooze";

export interface NeedsKeyAction {
  id: NeedsKeyActionId;
  label: string;
  hint: string;
}

/**
 * Actions offered by the card for one keyless server. "Use built-in" appears
 * only when the native fallback tool would ACTUALLY work right now
 * (`nativeFallbackAvailable`). For Tavily the native `web_search` shares the
 * same missing key, so offering it unconditionally promised a fallback that
 * immediately errors `no_tavily_key` — misleading. When the key is not
 * reachable the user still has Paste / Disable / Not now.
 */
export function buildNeedsKeyActions(server: MissingKeyServer): NeedsKeyAction[] {
  const actions: NeedsKeyAction[] = [
    {
      id: "paste-key",
      label: `Paste ${server.envVar}`,
      hint: `Validate, store, and reconnect ${server.label} now`,
    },
  ];
  if (server.nativeFallback && server.nativeFallbackAvailable) {
    actions.push({
      id: "use-builtin",
      label: `Use built-in ${server.nativeFallback}`,
      hint: `${server.nativeFallback} is already available — skip ${server.label} for this session`,
    });
  }
  actions.push(
    {
      id: "disable",
      label: `Disable ${server.label}`,
      hint: "Turn the server off in config so it is no longer considered",
    },
    {
      id: "snooze",
      label: "Not now",
      hint: "Hide for this session",
    },
  );
  return actions;
}

/**
 * Persist `enabled` for one MCP server. Materializes the default catalog first
 * (mirrors research-onboarding's setTavilyEnabled) so the row exists even when
 * the card fires before the orchestrator's own ensureDefaultMcpServers call.
 * Returns whether a row was found and (if needed) updated.
 */
export function setMcpServerEnabled(id: string, enabled: boolean): boolean {
  ensureDefaultMcpServers();
  const servers = loadMcpServers();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (servers[idx].enabled !== enabled) {
    servers[idx] = { ...servers[idx], enabled };
    saveMcpServers(servers);
  }
  return true;
}

/**
 * Validate a candidate key for a server. Tavily has a real API probe; other
 * key-gated servers accept any plausible-length key for now.
 * TODO: move per-server validators into MCP_KEY_REQUIREMENTS so a future
 * server ships its probe alongside its envVar/setupHint.
 */
export async function defaultValidateMcpKey(serverId: string, key: string): Promise<boolean> {
  if (serverId === "tavily") {
    const { validateTavilyKey } = await import("../mcp/research-onboarding.js");
    return validateTavilyKey(key);
  }
  return key.trim().length >= MIN_MCP_KEY_LEN;
}

/** Reconnect pooled MCP clients so a freshly-keyed server comes up THIS session. */
export async function reconnectMcpServers(): Promise<void> {
  const { warmMcpClients } = await import("../mcp/client-pool.js");
  await warmMcpClients(loadMcpServers());
}

export interface SubmitKeyDeps {
  validateKey: (serverId: string, key: string) => Promise<boolean>;
  storeKey: (keyId: McpKeyId, key: string) => Promise<unknown>;
  setServerEnabled: (id: string, enabled: boolean) => boolean;
  resetNotice: (id: string) => void;
  reconnect: () => Promise<void> | void;
}

export type SubmitKeyResult = { ok: true } | { ok: false; error: string };

/**
 * Full "paste key" pipeline: trim → length gate → validate → store → re-enable
 * server → reset the once-per-session notice (so retries surface again if the
 * key later fails) → reconnect the pool. Deps are injected for testability;
 * production wiring is `defaultSubmitKeyDeps()`.
 */
export async function submitMcpServerKey(
  server: MissingKeyServer,
  rawKey: string,
  deps: SubmitKeyDeps,
): Promise<SubmitKeyResult> {
  const key = rawKey.trim();
  if (key.length < MIN_MCP_KEY_LEN) {
    return { ok: false, error: `Key looks too short (min ${MIN_MCP_KEY_LEN} chars).` };
  }
  const valid = await deps.validateKey(server.id, key);
  if (!valid) {
    return { ok: false, error: "Key validation failed (HTTP 401 or network error)." };
  }
  const keyId = MCP_KEY_REQUIREMENTS[server.id]?.keyId;
  if (!keyId) {
    return { ok: false, error: `No keychain slot registered for '${server.id}'.` };
  }
  try {
    await deps.storeKey(keyId, key);
  } catch (err) {
    return { ok: false, error: `Could not store key: ${(err as Error).message}` };
  }
  deps.setServerEnabled(server.id, true);
  deps.resetNotice(server.id);
  await deps.reconnect();
  return { ok: true };
}

/** Production dependency wiring for submitMcpServerKey. */
export function defaultSubmitKeyDeps(): SubmitKeyDeps {
  return {
    validateKey: defaultValidateMcpKey,
    storeKey: setMcpKey,
    setServerEnabled: setMcpServerEnabled,
    resetNotice: (id) => {
      resetNeedsKeyNotice(id);
      resetNeedsKeyAnnouncements(id);
    },
    reconnect: reconnectMcpServers,
  };
}
