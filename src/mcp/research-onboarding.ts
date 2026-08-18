import { loadMcpServers, loadUserSettings, saveMcpServers, saveUserSettings } from "../utils/settings.js";
import { ensureDefaultMcpServers } from "./auto-setup.js";
import { setMcpKey } from "./mcp-keychain.js";

export interface OnboardingIO {
  askYesNo: (prompt: string) => Promise<string>;
  askText: (prompt: string) => Promise<string>;
  log: (msg: string) => void;
}

export interface MigrationIO {
  askChoice: (prompt: string) => Promise<string>;
  askText: (prompt: string) => Promise<string>;
  log: (msg: string) => void;
}

export interface OnboardingResult {
  tavilyEnabled: boolean;
}

export interface MigrationResult {
  shown: boolean;
  tavilyEnabled: boolean;
}

// Overridable so a self-hosted Tavily proxy can be probed, and so tests can
// point it at a dead endpoint to exercise the "unverified" (unreachable) path.
function tavilyValidateUrl(): string {
  return process.env.MUONROI_TAVILY_VALIDATE_URL || "https://api.tavily.com/search";
}
const MAX_RETRY = 3;
const MIN_KEY_LEN = 16;

/**
 * Outcome of an online key probe:
 *  - `ok`           — the API accepted the key (HTTP 2xx).
 *  - `unauthorized` — the API rejected the key itself (HTTP 401/403). Retry/reject.
 *  - `unverified`   — we could NOT determine validity: offline, DNS failure,
 *                     timeout, rate-limit (429) or a server-side 5xx. The key is
 *                     plausibly fine; the probe just didn't reach a verdict.
 *
 * The distinction matters: the old boolean collapsed `unverified` into "invalid",
 * so a network hiccup at setup time SILENTLY discarded a perfectly valid key —
 * the user pasted a key, saw it "not saved", and got re-prompted next launch
 * (reported for Tavily). `unverified` must NOT throw the key away.
 */
export type TavilyKeyCheck = "ok" | "unauthorized" | "unverified";

export async function validateTavilyKey(key: string): Promise<TavilyKeyCheck> {
  try {
    const res = await fetch(tavilyValidateUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: "ping", max_results: 1 }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return "ok";
    // Only an explicit auth rejection means the key is bad. Everything else
    // (429 rate-limit, 5xx, unexpected status) is inconclusive — never a reason
    // to drop the key the user just pasted.
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unverified";
  } catch {
    // Offline / DNS / timeout / abort — cannot verify, so do not reject.
    return "unverified";
  }
}

function setTavilyEnabled(enabled: boolean): void {
  // Ensure DEFAULT_CONFIGS is materialized in settings before mutating.
  // First-run wizard runs before the orchestrator's own ensureDefaultMcpServers
  // call, so without this the tavily row may not yet exist and the toggle
  // would silently no-op.
  ensureDefaultMcpServers();
  const servers = loadMcpServers();
  const idx = servers.findIndex((s) => s.id === "tavily");
  if (idx === -1) return;
  if (servers[idx].enabled === enabled) return;
  servers[idx] = { ...servers[idx], enabled };
  saveMcpServers(servers);
}

async function promptForKeyWithRetry(io: {
  askText: (p: string) => Promise<string>;
  log: (m: string) => void;
}): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const raw = await io.askText(
      attempt === 1
        ? "Tavily API key (free tier at https://tavily.com, leave blank to skip): "
        : `Tavily key invalid. Try again (${attempt}/${MAX_RETRY}) or leave blank to skip: `,
    );
    const key = raw.trim();
    if (!key) return null;
    if (key.length < MIN_KEY_LEN) {
      io.log(`Key looks too short (< ${MIN_KEY_LEN} chars).\n`);
      continue;
    }
    const verdict = await validateTavilyKey(key);
    if (verdict === "ok") return key;
    if (verdict === "unverified") {
      // Could not reach Tavily to verify (offline / rate-limited). Keep the key
      // rather than forcing the user to re-enter it later — it is probably fine.
      io.log("Couldn't verify the key online (offline or rate-limited) — saving it anyway.\n");
      return key;
    }
    io.log("Key was rejected (HTTP 401/403). Check the key and try again.\n");
  }
  return null;
}

export async function runResearchOnboarding(io: OnboardingIO): Promise<OnboardingResult> {
  io.log("\nWeb research tools (native builtins):\n");
  io.log("  - fetch_url — fetch any public URL and return clean markdown/text (always available)\n");
  io.log("  - web_search — Tavily-powered web search (free tier, needs API key)\n");
  io.log("  - context7 / muonroi-docs — still available via MCP (library + ecosystem docs)\n");
  io.log("\nTip: if you keep keys in Bitwarden, run `muonroi-cli mcp import-bw tavily` instead.\n\n");
  const yn = (await io.askYesNo("Enable Tavily web search now? [Y/n]: ")).trim().toLowerCase();
  let tavilyEnabled = false;
  if (yn !== "n" && yn !== "no") {
    const key = await promptForKeyWithRetry(io);
    if (key) {
      try {
        await setMcpKey("tavily", key);
        setTavilyEnabled(true);
        tavilyEnabled = true;
        io.log("Tavily key stored. Web search enabled.\n");
      } catch (err) {
        io.log(`Could not store key: ${(err as Error).message}\n`);
      }
    } else {
      io.log("Skipped Tavily setup. You can run `muonroi-cli mcp setup-research` later.\n");
    }
  }
  saveUserSettings({ webResearchPrompted: true });
  return { tavilyEnabled };
}

export async function runResearchMigrationPrompt(io: MigrationIO): Promise<MigrationResult> {
  const settings = loadUserSettings();
  if (settings.webResearchPrompted === true) {
    return { shown: false, tavilyEnabled: false };
  }
  io.log("\nNew: web research tools are available natively.\n");
  io.log("  - fetch_url (URL → markdown) is always available.\n");
  io.log("  - web_search (Tavily) needs a free API key (tavily.com).\n");
  io.log("  - context7 + muonroi-docs remain as optional MCP for specialized docs.\n\n");
  const choice = (await io.askChoice("Set up Tavily now? [Y/n/never]: ")).trim().toLowerCase();
  let tavilyEnabled = false;
  if (choice === "y" || choice === "yes" || choice === "") {
    const key = await promptForKeyWithRetry(io);
    if (key) {
      try {
        await setMcpKey("tavily", key);
        setTavilyEnabled(true);
        tavilyEnabled = true;
        saveUserSettings({ webResearchPrompted: true });
        io.log("Tavily key stored. Web search enabled.\n");
      } catch (err) {
        io.log(`Could not store key: ${(err as Error).message}\n`);
      }
    } else {
      io.log("Skipped. You can run `muonroi-cli mcp setup-research` later.\n");
    }
  } else if (choice === "never") {
    saveUserSettings({ webResearchPrompted: true });
    io.log("Got it - won't ask again. Run `muonroi-cli mcp setup-research` if you change your mind.\n");
  } else {
    // Plain "n" or unrecognized input: deliberately do NOT set webResearchPrompted.
    // The migration prompt will re-fire next session so users who decline once
    // are not silently locked out of web research forever.
    io.log("Skipped for this session.\n");
  }
  return { shown: true, tavilyEnabled };
}
