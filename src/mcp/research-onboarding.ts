import { loadMcpServers, saveMcpServers, saveUserSettings, loadUserSettings } from "../utils/settings.js";
import { setMcpKey } from "./mcp-keychain.js";
import { ensureDefaultMcpServers } from "./auto-setup.js";

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

const TAVILY_VALIDATE_URL = "https://api.tavily.com/search";
const MAX_RETRY = 3;
const MIN_KEY_LEN = 16;

export async function validateTavilyKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(TAVILY_VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: "ping", max_results: 1 }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
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

async function promptForKeyWithRetry(io: { askText: (p: string) => Promise<string>; log: (m: string) => void }): Promise<string | null> {
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
    const ok = await validateTavilyKey(key);
    if (ok) return key;
    io.log("Validation failed (HTTP 401 or network error).\n");
  }
  return null;
}

export async function runResearchOnboarding(io: OnboardingIO): Promise<OnboardingResult> {
  io.log("\nWeb research is available via MCP servers:\n");
  io.log("  - context7 - version-pinned library docs (free, no key)\n");
  io.log("  - fetch - URL to markdown extraction (free, no key)\n");
  io.log("  - tavily - LLM-tuned web search (free tier 1k/mo, needs API key)\n\n");
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
  io.log("\nNew: web research is available.\n");
  io.log("  - context7 (library docs) and fetch (URL extraction) - already enabled.\n");
  io.log("  - Tavily web search needs a free API key (tavily.com).\n\n");
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
