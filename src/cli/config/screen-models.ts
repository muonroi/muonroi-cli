import { getModelsForProvider } from "../../models/registry.js";
import type { ProviderId } from "../../providers/types.js";
import { ALL_PROVIDER_IDS } from "../../providers/types.js";
import { isModelDisabled, setModelDisabled } from "../../utils/settings.js";
import { A, captureKey, divider, enterRawMode } from "./tui.js";

interface ModelRow {
  id: string;
  name: string;
  provider: ProviderId;
  tier: string | undefined;
  enabled: boolean;
}

const ALL_PROVIDERS: readonly ProviderId[] = ALL_PROVIDER_IDS;

function loadRows(): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const pid of ALL_PROVIDERS) {
    for (const m of getModelsForProvider(pid)) {
      rows.push({
        id: m.id,
        name: m.name ?? m.id,
        provider: pid,
        tier: m.tier,
        enabled: !isModelDisabled(m.id),
      });
    }
  }
  return rows;
}

function renderScreen(rows: ModelRow[], cursor: number, statusMsg: string, width: number): string {
  const lines: string[] = [];
  lines.push(`${A.BOLD}Models${A.RESET}`);
  lines.push(divider(width));
  lines.push(`    ${"Model".padEnd(36)}${"Provider".padEnd(14)}${"Tier".padEnd(8)}Status`);
  lines.push(divider(width));

  if (rows.length === 0) {
    lines.push(`  ${A.DIM}No models loaded — run 'muonroi-cli config' from a project to load the catalog.${A.RESET}`);
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const selected = i === cursor;
    const prefix = selected ? `${A.REVERSE}► ` : "  ";
    const suffix = selected ? A.RESET : "";
    const mark = row.enabled ? "✓" : "✗";
    const nameDisplay = row.name.length > 34 ? `${row.name.slice(0, 33)}…` : row.name;
    const statusDisplay = row.enabled ? "ENABLED " : "disabled";
    lines.push(
      `${prefix}${mark} ${nameDisplay.padEnd(34)} ${row.provider.padEnd(12)} ${(row.tier ?? "-").padEnd(6)} ${statusDisplay}${suffix}`,
    );
  }

  lines.push(divider(width));
  if (statusMsg) lines.push(`${A.YELLOW}${statusMsg}${A.RESET}`);
  lines.push(`${A.DIM}[↑↓] navigate  [space] toggle  [Esc] back${A.RESET}`);
  return lines.join("\n");
}

export async function runModelsScreen(): Promise<void> {
  let rows = loadRows();
  let cursor = 0;
  let statusMsg = "";
  const W = Math.min(process.stdout.columns ?? 80, 100);

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

      if (key.name === "space") {
        const row = rows[cursor];
        if (!row) continue;
        // row.enabled=true means currently enabled → disable it; and vice versa
        setModelDisabled(row.id, row.enabled);
        rows = loadRows();
        statusMsg = `${row.name}: ${row.enabled ? "disabled" : "enabled"}`;
      }
    }
  } finally {
    restore();
  }
}
