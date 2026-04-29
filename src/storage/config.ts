import * as os from "node:os";
import * as path from "node:path";
import { atomicReadJSON, atomicWriteJSON } from "./atomic-io.js";

/**
 * TUI-owned cap configuration stored at ~/.muonroi-cli/config.json.
 *
 * Architecture anti-pattern 4: cap state is owned exclusively by the TUI process.
 * EE server must NEVER read or write this file — it only receives per-call context
 * over HTTP.
 */
export interface MuonroiConfig {
  cap: { monthly_usd: number };
  ee?: { baseUrl?: string; authToken?: string };
}

const DEFAULT_CONFIG: MuonroiConfig = {
  cap: { monthly_usd: 15 },
  ee: { baseUrl: "http://localhost:8082" },
};

/**
 * Resolve the ~/.muonroi-cli/ home directory.
 * Priority: explicit override → MUONROI_CLI_HOME env → os.homedir()/.muonroi-cli
 */
function muonroiHome(override?: string): string {
  return override ?? process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli");
}

/**
 * Load config from ~/.muonroi-cli/config.json.
 * If absent, writes and returns the default config (cap.monthly_usd = 15).
 * Accepts an optional homeOverride for test isolation.
 */
export async function loadConfig(homeOverride?: string): Promise<MuonroiConfig> {
  const home = muonroiHome(homeOverride);
  const filePath = path.join(home, "config.json");
  const existing = await atomicReadJSON<MuonroiConfig>(filePath);
  if (existing) {
    // Merge so that missing keys fall back to defaults (handles partial user configs)
    return {
      ...DEFAULT_CONFIG,
      ...existing,
      cap: { ...DEFAULT_CONFIG.cap, ...existing.cap },
    };
  }
  await atomicWriteJSON(filePath, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}
