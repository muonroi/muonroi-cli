import { getModelsForProvider } from "../../models/registry.js";
import { PROVIDER_ENDPOINTS } from "../../providers/endpoints.js";
import {
  KEYCHAIN_PROVIDER_IDS,
  listStoredProviders,
  loadKeyForProvider,
  setKeyForProvider,
} from "../../providers/keychain.js";
import type { ProviderId } from "../../providers/types.js";
import { getCurrentModel, getDisabledProviders, saveUserSettings, setProviderDisabled } from "../../utils/settings.js";
import { openModelPicker } from "./model-picker.js";
import { fetchProviderModels } from "./provider-fetch.js";
import { A, captureKey, divider, enterRawMode, hiddenPrompt, maskKey } from "./tui.js";

const ALL_PROVIDERS: ProviderId[] = [...KEYCHAIN_PROVIDER_IDS, "ollama"];

interface ProviderRow {
  id: ProviderId;
  maskedKey: string | null;
  enabled: boolean;
  isDefault: boolean;
}

async function loadRows(): Promise<ProviderRow[]> {
  const stored = new Set(await listStoredProviders());
  const disabled = new Set(getDisabledProviders());
  const currentModel = getCurrentModel();

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

    const modelsForProvider = getModelsForProvider(id);
    const isDefault = modelsForProvider.some((m) => m.id === currentModel);

    rows.push({ id, maskedKey, enabled: !disabled.has(id), isDefault });
  }
  return rows;
}

function renderScreen(rows: ProviderRow[], cursor: number, statusMsg: string, width: number): string {
  const lines: string[] = [];
  lines.push(`${A.BOLD}Providers${A.RESET}`);
  lines.push(divider(width));
  lines.push(" Provider".padEnd(14) + "Key".padEnd(20) + "Status".padEnd(10) + "Default");
  lines.push(divider(width));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const selected = i === cursor;
    const prefix = selected ? `${A.REVERSE}► ` : "  ";
    const suffix = selected ? A.RESET : "";

    const keyDisplay = row.maskedKey ?? "(no key)";
    const statusDisplay = row.enabled ? "ENABLED " : "disabled";
    const defaultDisplay = row.isDefault ? "★" : "";

    lines.push(prefix + row.id.padEnd(12) + keyDisplay.padEnd(18) + statusDisplay + "  " + defaultDisplay + suffix);
  }

  lines.push(divider(width));
  if (statusMsg) lines.push(`${A.YELLOW}${statusMsg}${A.RESET}`);
  lines.push(`${A.DIM}[k] set/update key  [space] toggle  [d] set default  [r] fetch models  [Esc] back${A.RESET}`);
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
        const models = getModelsForProvider(row.id);
        if (models.length === 0) {
          statusMsg = `No catalog models for ${row.id}`;
          continue;
        }
        saveUserSettings({ defaultModel: models[0]!.id });
        rows = await loadRows();
        statusMsg = `Default model set to ${models[0]!.id}`;
        continue;
      }

      if (key.name === "r") {
        if (row.id === "ollama") {
          statusMsg = "Ollama model discovery not supported here";
          continue;
        }
        if (!row.maskedKey) {
          statusMsg = "Press [k] to set key first";
          continue;
        }

        restore();
        process.stdout.write("\nFetching models from provider...\n");
        let apiKey: string;
        try {
          apiKey = await loadKeyForProvider(row.id);
        } catch {
          statusMsg = "Could not load key from keychain";
          enterRawMode();
          continue;
        }

        const baseURL = PROVIDER_ENDPOINTS[row.id].apiBase;
        let live: Awaited<ReturnType<typeof fetchProviderModels>> = [];
        try {
          live = await fetchProviderModels(baseURL, apiKey);
        } catch {
          statusMsg = "Failed to fetch models from provider";
          enterRawMode();
          continue;
        }

        if (live.length === 0) {
          process.stdout.write("Could not fetch models (check key/network). Using catalog only.\n");
        }

        const liveWithProvider = live.map((m) => ({ ...m, provider: row.id }));
        let chosen: string | null = null;
        try {
          chosen = await openModelPicker(row.id, liveWithProvider);
        } catch {
          statusMsg = "Model picker error";
          enterRawMode();
          continue;
        }

        if (chosen) {
          saveUserSettings({ defaultModel: chosen });
          rows = await loadRows();
          statusMsg = `Default model set to ${chosen}`;
        }
        enterRawMode();
      }
    }
  } finally {
    restore();
  }
}
