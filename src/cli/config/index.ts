import { Command } from "commander";
import { loadCatalog } from "../../models/registry.js";
import { listStoredProviders } from "../../providers/keychain.js";
import { getDisabledModels, getDisabledProviders, getRoleModels } from "../../utils/settings.js";
import { runCouncilScreen } from "./screen-council.js";
import { runModelsScreen } from "./screen-models.js";
import { runProviderScreen } from "./screen-providers.js";
import { A, captureKey, divider, enterRawMode } from "./tui.js";

const MENU_ITEMS = [
  {
    id: "providers",
    label: "Providers",
    badge: async () => {
      const stored = await listStoredProviders();
      const disabled = getDisabledProviders();
      const enabled = stored.filter((p) => !disabled.includes(p));
      return `${enabled.length} enabled`;
    },
  },
  {
    id: "council",
    label: "Council/Debate",
    badge: async () => {
      const roles = getRoleModels();
      const count = Object.keys(roles).length;
      return count > 0 ? `${count} role${count > 1 ? "s" : ""} set` : "no roles set";
    },
  },
  {
    id: "models",
    label: "Models",
    badge: async () => {
      const disabled = getDisabledModels();
      return disabled.length > 0 ? `${disabled.length} disabled` : "all enabled";
    },
  },
];

async function runConfigMenu(): Promise<void> {
  const W = Math.min(process.stdout.columns ?? 72, 56);
  let cursor = 0;

  const badges = await Promise.all(MENU_ITEMS.map((item) => item.badge()));

  const restore = enterRawMode();

  const render = () => {
    process.stdout.write(A.CLEAR_SCREEN);
    const lines: string[] = [];
    const headerPad = "─".repeat(Math.max(0, W - 17));
    lines.push(`${A.BOLD}┌─ Configuration ${headerPad}┐${A.RESET}`);
    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const item = MENU_ITEMS[i]!;
      const selected = i === cursor;
      const prefix = selected ? `│  ${A.REVERSE}> ` : "│    ";
      const suffix = selected ? A.RESET : "";
      const badge = badges[i] ? `  ${A.DIM}[${badges[i]}]${A.RESET}` : "";
      lines.push(`${prefix}${item.label.padEnd(18)}${badge}${suffix}`);
    }
    lines.push(`${A.BOLD}└${"─".repeat(W - 1)}┘${A.RESET}`);
    lines.push("");
    lines.push(`${A.DIM}[↑↓] navigate  [Enter] open  [q] quit${A.RESET}`);
    process.stdout.write(lines.join("\n"));
  };

  try {
    while (true) {
      render();
      const key = await captureKey();

      if (key.name === "q" || key.name === "escape") break;
      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }
      if (key.name === "down") {
        cursor = Math.min(MENU_ITEMS.length - 1, cursor + 1);
        continue;
      }

      if (key.name === "return") {
        const item = MENU_ITEMS[cursor];
        if (!item) continue;
        restore();

        if (item.id === "providers") {
          await runProviderScreen();
        } else if (item.id === "council") {
          await runCouncilScreen();
        } else if (item.id === "models") {
          await runModelsScreen();
        }

        const newBadges = await Promise.all(MENU_ITEMS.map((mi) => mi.badge()));
        badges.splice(0, badges.length, ...newBadges);
        enterRawMode();
      }
    }
  } finally {
    restore();
    process.stdout.write("\n");
  }
}

export function buildConfigCommand(): Command {
  return new Command("config").description("Interactive provider and council configuration").action(async () => {
    if (!process.stdin.isTTY) {
      console.error("muonroi-cli config requires an interactive terminal (TTY).");
      process.exit(1);
    }
    // Populate MODELS registry — the picker reads from it, and `muonroi-cli config`
    // does not go through the main entrypoint that boots the catalog.
    await loadCatalog().catch(() => {
      // Picker handles empty registry gracefully (shows no rows) — surface no error here.
    });
    await runConfigMenu();
  });
}
