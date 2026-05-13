import { MODELS } from "../../models/registry.js";
import type { ModelInfo } from "../../types/index.js";
import type { LiveModel, ModelCapability } from "./provider-fetch.js";
import { A, captureKey, divider, enterRawMode } from "./tui.js";

export interface PickerModel {
  id: string;
  displayName: string;
  provider: string;
  tier?: string;
  capability: ModelCapability;
}

export interface ModelGroup {
  name: string;
  models: PickerModel[];
}

const CAPABILITY_ORDER: ModelCapability[] = ["text", "vision", "image", "video"];
const GROUP_NAMES: Record<ModelCapability, string> = {
  text: "Text / Chat",
  vision: "Vision / Multimodal",
  image: "Image Generation",
  video: "Video Generation",
};

function modelInfoToPickerModel(m: ModelInfo): PickerModel {
  const capability: ModelCapability = m.supportsVision ? "vision" : "text";
  return {
    id: m.id,
    displayName: m.name ?? m.id,
    provider: m.provider ?? "unknown",
    tier: m.tier,
    capability,
  };
}

function liveModelToPickerModel(m: LiveModel & { provider: string }): PickerModel {
  return {
    id: m.id,
    displayName: m.displayName,
    provider: m.provider,
    capability: m.capability,
  };
}

export function filterModels(models: PickerModel[], query: string): PickerModel[] {
  if (!query) return models;
  const q = query.toLowerCase();
  return models.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.tier?.toLowerCase().includes(q) ?? false),
  );
}

export function groupModels(models: PickerModel[]): ModelGroup[] {
  const byCapability = new Map<ModelCapability, PickerModel[]>();
  for (const m of models) {
    const list = byCapability.get(m.capability) ?? [];
    list.push(m);
    byCapability.set(m.capability, list);
  }
  return CAPABILITY_ORDER.filter((cap) => (byCapability.get(cap)?.length ?? 0) > 0).map((cap) => ({
    name: GROUP_NAMES[cap],
    models: byCapability.get(cap)!,
  }));
}

function flattenGroups(groups: ModelGroup[]): Array<PickerModel | { groupHeader: string }> {
  const flat: Array<PickerModel | { groupHeader: string }> = [];
  for (const g of groups) {
    flat.push({ groupHeader: g.name });
    for (const m of g.models) flat.push(m);
  }
  return flat;
}

function countSelectables(flat: Array<PickerModel | { groupHeader: string }>): number {
  return flat.filter((f) => !("groupHeader" in f)).length;
}

function renderPickerScreen(
  forRole: string,
  query: string,
  flat: Array<PickerModel | { groupHeader: string }>,
  cursorIdx: number,
  fetchStatus: string,
  width: number,
): string {
  const lines: string[] = [];
  lines.push(`${A.BOLD}Select model for: ${forRole}${A.RESET}`);
  lines.push(divider(width));
  lines.push(`Filter: [/${query.padEnd(Math.max(0, width - 10))}]`);
  lines.push("");

  let selectable = -1;
  for (const item of flat) {
    if ("groupHeader" in item) {
      lines.push(`${A.DIM}${item.groupHeader}${A.RESET}`);
    } else {
      selectable++;
      const selected = selectable === cursorIdx;
      const prefix = selected ? `${A.REVERSE}> ` : "  ";
      const suffix = selected ? A.RESET : "";
      const tier = item.tier ? `  ${A.DIM}${item.tier}${A.RESET}` : "";
      const provider = `${A.DIM}${item.provider}${A.RESET}`;
      lines.push(`${prefix}${item.displayName.padEnd(32)} ${provider}${tier}${suffix}`);
    }
  }

  if (fetchStatus) {
    lines.push("");
    lines.push(`${A.DIM}${fetchStatus}${A.RESET}`);
  }
  lines.push("");
  lines.push(`${A.DIM}[↑↓] navigate  [Enter] select  [Esc] cancel${A.RESET}`);
  return lines.join("\n");
}

export async function openModelPicker(
  forRole: string,
  extraModels: Array<LiveModel & { provider: string }> = [],
): Promise<string | null> {
  const catalogModels = MODELS.map(modelInfoToPickerModel);
  const liveModels = extraModels.map(liveModelToPickerModel);

  const catalogIds = new Set(catalogModels.map((m) => m.id));
  const merged = [...catalogModels, ...liveModels.filter((m) => !catalogIds.has(m.id))];

  const W = Math.min(process.stdout.columns ?? 72, 80);
  let query = "";
  let cursorIdx = 0;
  const fetchStatus = "";

  const restore = enterRawMode();

  const getFlat = () => {
    const filtered = filterModels(merged, query);
    const groups = groupModels(filtered);
    return flattenGroups(groups);
  };

  const render = () => {
    const flat = getFlat();
    const selectableCount = countSelectables(flat);
    cursorIdx = Math.max(0, Math.min(cursorIdx, selectableCount - 1));
    process.stdout.write(A.CLEAR_SCREEN);
    process.stdout.write(renderPickerScreen(forRole, query, flat, cursorIdx, fetchStatus, W));
  };

  try {
    while (true) {
      render();
      const key = await captureKey();

      if (key.name === "escape") return null;

      if (key.name === "up") {
        cursorIdx = Math.max(0, cursorIdx - 1);
        continue;
      }

      if (key.name === "down") {
        const flat = getFlat();
        cursorIdx = Math.min(countSelectables(flat) - 1, cursorIdx + 1);
        continue;
      }

      if (key.name === "backspace") {
        query = query.slice(0, -1);
        cursorIdx = 0;
        continue;
      }

      if (key.name === "return") {
        const flat = getFlat();
        const selectables = flat.filter((f): f is PickerModel => !("groupHeader" in f));
        const chosen = selectables[cursorIdx];
        if (chosen) return chosen.id;
        continue;
      }

      if (key.name.length === 1 && key.name >= " ") {
        query += key.name;
        cursorIdx = 0;
      }
    }
  } finally {
    restore();
  }
}
