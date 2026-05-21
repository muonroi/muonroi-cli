import { getModelByTier, getModelsForProvider } from "../../models/registry.js";
import { PROVIDER_ENDPOINTS } from "../../providers/endpoints.js";
import {
  KEYCHAIN_PROVIDER_IDS,
  listStoredProviders,
  loadKeyForProvider,
  setKeyForProvider,
} from "../../providers/keychain.js";
import type { ProviderId } from "../../providers/types.js";
import {
  getDefaultProvider,
  getDisabledProviders,
  saveUserSettings,
  setDefaultProvider,
  setProviderDisabled,
} from "../../utils/settings.js";
import { A, captureKey, divider, enterRawMode, hiddenPrompt, maskKey } from "./tui.js";

/**
 * Providers the splash/config UI exposes. The codebase still supports the
 * other providers in KEYCHAIN_PROVIDER_IDS, but we hide them from the picker
 * until their integration is hardened — the router can still target them
 * programmatically. To re-expose one, add its id here.
 */
const VISIBLE_PROVIDERS: ProviderId[] = ["deepseek", "siliconflow"];
const ALL_PROVIDERS: ProviderId[] = [...VISIBLE_PROVIDERS, "ollama"];
void KEYCHAIN_PROVIDER_IDS;

interface ProviderRow {
  id: ProviderId;
  maskedKey: string | null;
  enabled: boolean;
  isDefault: boolean;
}

async function loadRows(): Promise<ProviderRow[]> {
  const stored = new Set(await listStoredProviders());
  const disabled = new Set(getDisabledProviders());
  const defaultProvider = getDefaultProvider();

  const rows: ProviderRow[] = [];
  for (const id of ALL_PROVIDERS) {
    let maskedKey: string | null = null;

    if (id === "ollama") {
      maskedKey = PROVIDER_ENDPOINTS.ollama.apiBase;
    } else if (stored.has(id)) {
      try {
        const key = await loadKeyForProvider(id);
        maskedKey = maskKey(key);
      } catch {
        maskedKey = "<unreadable>";
      }
    }

    rows.push({ id, maskedKey, enabled: !disabled.has(id), isDefault: defaultProvider === id });
  }
  return rows;
}

/**
 * Pick the model the router should use when a provider is set as default.
 * Preference: balanced → fast → premium → any model in catalog for the
 * provider. Returns null when the provider has no catalog entries.
 */
function pickModelForProvider(id: ProviderId): string | null {
  for (const tier of ["balanced", "fast", "premium"] as const) {
    const m = getModelByTier(tier, id);
    if (m && m.provider === id) return m.id;
  }
  const fallback = getModelsForProvider(id);
  return fallback[0]?.id ?? null;
}

function renderScreen(rows: ProviderRow[], cursor: number, statusMsg: string, width: number): string {
  const lines: string[] = [];
  lines.push(`${A.BOLD}Providers${A.RESET}`);
  lines.push(divider(width));
  lines.push(`${" Provider".padEnd(14) + "Key".padEnd(20) + "Status".padEnd(10)}Default`);
  lines.push(divider(width));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const selected = i === cursor;
    const prefix = selected ? `${A.REVERSE}► ` : "  ";
    const suffix = selected ? A.RESET : "";

    const keyDisplay = row.maskedKey ?? "(no key)";
    const statusDisplay = row.enabled ? "ENABLED " : "disabled";
    const defaultDisplay = row.isDefault ? "★" : "";

    lines.push(`${prefix + row.id.padEnd(12) + keyDisplay.padEnd(18) + statusDisplay}  ${defaultDisplay}${suffix}`);
  }

  lines.push(divider(width));
  if (statusMsg) lines.push(`${A.YELLOW}${statusMsg}${A.RESET}`);
  lines.push(`${A.DIM}[k] set/update key  [space] toggle  [d] set as default  [Esc] back${A.RESET}`);
  lines.push(`${A.DIM}Router auto-picks the model from the default provider.${A.RESET}`);
  return lines.join("\n");
}

export async function runProviderScreen(): Promise<void> {
  let rows = await loadRows();
  let cursor = 0;
  let statusMsg = "";
  const W = Math.min(process.stdout.columns ?? 72, 80);

  const restore = enterRawMode();

  const render = () => {
    process.stdout.write(A.CLEAR_SCREEN);
    process.stdout.write(renderScreen(rows, cursor, statusMsg, W));
  };

  try {
    while (true) {
      render();
      statusMsg = "";
      const key = await captureKey();

      if (key.name === "escape") break;
      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }
      if (key.name === "down") {
        cursor = Math.min(rows.length - 1, cursor + 1);
        continue;
      }

      const row = rows[cursor]!;

      if (key.name === "space") {
        if (row.id === "ollama") {
          setProviderDisabled(row.id, row.enabled);
          rows = await loadRows();
          continue;
        }
        if (!row.maskedKey) {
          statusMsg = "Press [k] to set key first";
          continue;
        }
        setProviderDisabled(row.id, row.enabled);
        rows = await loadRows();
        continue;
      }

      if (key.name === "k") {
        if (row.id === "ollama") {
          statusMsg = "Ollama does not use an API key";
          continue;
        }
        restore();
        const newKey = (await hiddenPrompt(`\nNew API key for ${row.id} (hidden): `)).trim();
        enterRawMode();
        if (!newKey) {
          statusMsg = "Aborted (empty key)";
          continue;
        }
        try {
          const ok = await setKeyForProvider(row.id, newKey);
          if (!ok) {
            statusMsg = "OS keychain unavailable — set env var instead";
          } else {
            statusMsg = `Key updated for ${row.id}`;
            rows = await loadRows();
          }
        } catch (e) {
          statusMsg = `Error: ${(e as Error).message}`;
        }
        continue;
      }

      if (key.name === "d") {
        if (!row.maskedKey && row.id !== "ollama") {
          statusMsg = "Press [k] to set key first";
          continue;
        }
        if (!row.enabled) {
          statusMsg = `Enable ${row.id} first (press [space])`;
          continue;
        }
        const modelId = pickModelForProvider(row.id);
        if (!modelId) {
          statusMsg = `No catalog models for ${row.id}`;
          continue;
        }
        setDefaultProvider(row.id);
        saveUserSettings({ defaultModel: modelId });
        rows = await loadRows();
        statusMsg = `Default provider: ${row.id} (router picks model: ${modelId})`;
      }
    }
  } finally {
    restore();
  }
}
