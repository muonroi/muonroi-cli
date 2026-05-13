// src/cli/config/screen-council.ts
import type { CouncilExperienceMode, ModelRole } from "../../utils/settings.js";
import {
  getAutoCouncilConfidence,
  getAutoCouncilMinRoles,
  getCouncilExperienceMode,
  getCouncilRounds,
  getRoleModels,
  isAutoCouncilEnabled,
  isCouncilCostAware,
  isCouncilMultiProviderPreferred,
  saveUserSettings,
} from "../../utils/settings.js";
import { openModelPicker } from "./model-picker.js";
import { A, captureKey, divider, enterRawMode } from "./tui.js";

const ROLES: ModelRole[] = ["leader", "implement", "verify", "research"];
const EXP_MODES: CouncilExperienceMode[] = ["off", "advisory", "enforcing"];

type RowKind =
  | { type: "role"; role: ModelRole }
  | { type: "rounds" }
  | { type: "multiProvider" }
  | { type: "costAware" }
  | { type: "experienceMode" }
  | { type: "autoCouncil" }
  | { type: "confidence" }
  | { type: "minRoles" };

const ROWS: RowKind[] = [
  { type: "role", role: "leader" },
  { type: "role", role: "implement" },
  { type: "role", role: "verify" },
  { type: "role", role: "research" },
  { type: "rounds" },
  { type: "multiProvider" },
  { type: "costAware" },
  { type: "experienceMode" },
  { type: "autoCouncil" },
  { type: "confidence" },
  { type: "minRoles" },
];

interface CouncilState {
  roleModels: Partial<Record<ModelRole, string>>;
  rounds: number;
  multiProvider: boolean;
  costAware: boolean;
  experienceMode: CouncilExperienceMode;
  autoCouncil: boolean;
  confidence: number;
  minRoles: number;
}

function loadState(): CouncilState {
  return {
    roleModels: getRoleModels(),
    rounds: getCouncilRounds(),
    multiProvider: isCouncilMultiProviderPreferred(),
    costAware: isCouncilCostAware(),
    experienceMode: getCouncilExperienceMode(),
    autoCouncil: isAutoCouncilEnabled(),
    confidence: getAutoCouncilConfidence(),
    minRoles: getAutoCouncilMinRoles(),
  };
}

function renderRowLine(row: RowKind, state: CouncilState, selected: boolean): string {
  const prefix = selected ? A.REVERSE : "";
  const suffix = selected ? A.RESET : "";

  switch (row.type) {
    case "role": {
      const val = state.roleModels[row.role] ?? "(unset)";
      return `${prefix}  ${row.role.padEnd(12)} ${val.padEnd(28)}  [Enter to change]${suffix}`;
    }
    case "rounds":
      return `${prefix}  ${"Rounds:".padEnd(20)} ${state.rounds}     [◄ 1–5 ►]${suffix}`;
    case "multiProvider":
      return `${prefix}  ${"Multi-provider:".padEnd(20)} ${state.multiProvider ? "ON " : "OFF"}   [space]${suffix}`;
    case "costAware":
      return `${prefix}  ${"Cost-aware:".padEnd(20)} ${state.costAware ? "ON " : "OFF"}   [space]${suffix}`;
    case "experienceMode":
      return `${prefix}  ${"Experience mode:".padEnd(20)} ${state.experienceMode.padEnd(12)}  [space: off→advisory→enforcing]${suffix}`;
    case "autoCouncil":
      return `${prefix}  ${"Auto-council:".padEnd(20)} ${state.autoCouncil ? "ON " : "OFF"}   [space]${suffix}`;
    case "confidence":
      return `${prefix}  ${"Confidence:".padEnd(20)} ${state.confidence.toFixed(2)}  [◄ 0.50–1.00 step 0.05 ►]${suffix}`;
    case "minRoles":
      return `${prefix}  ${"Min roles:".padEnd(20)} ${state.minRoles}     [◄ 1–4 ►]${suffix}`;
  }
}

function renderScreen(state: CouncilState, cursor: number, statusMsg: string, W: number): string {
  const lines: string[] = [];
  lines.push(`${A.BOLD}Council / Debate Configuration${A.RESET}`);
  lines.push(divider(W));
  lines.push(`${A.DIM} Roles${A.RESET}`);

  for (let i = 0; i < ROWS.length; i++) {
    const row = ROWS[i]!;
    if (i === 4) {
      lines.push("");
      lines.push(`${A.DIM} Debate Settings${A.RESET}`);
    }
    if (i === 8) {
      lines.push("");
      lines.push(`${A.DIM} Auto-council${A.RESET}`);
    }
    lines.push(renderRowLine(row, state, i === cursor));
  }

  lines.push(divider(W));
  if (statusMsg) lines.push(`${A.YELLOW}${statusMsg}${A.RESET}`);
  lines.push(`${A.DIM}[↑↓] navigate  [Enter] edit role  [space/◄►] adjust  [Esc] save+back${A.RESET}`);
  return lines.join("\n");
}

function saveState(state: CouncilState): void {
  saveUserSettings({
    roleModels: state.roleModels,
    councilRounds: state.rounds,
    councilPreferMultiProvider: state.multiProvider,
    councilCostAware: state.costAware,
    councilExperienceMode: state.experienceMode,
    autoCouncil: state.autoCouncil,
    autoCouncilConfidence: state.confidence,
    autoCouncilMinRoles: state.minRoles,
  });
}

export async function runCouncilScreen(): Promise<void> {
  const state = loadState();
  let cursor = 0;
  let statusMsg = "";
  const W = Math.min(process.stdout.columns ?? 72, 80);

  const restore = enterRawMode();

  const render = () => {
    process.stdout.write(A.CLEAR_SCREEN);
    process.stdout.write(renderScreen(state, cursor, statusMsg, W));
  };

  try {
    while (true) {
      render();
      statusMsg = "";
      const key = await captureKey();

      if (key.name === "escape") {
        saveState(state);
        break;
      }

      if (key.name === "up") {
        cursor = Math.max(0, cursor - 1);
        continue;
      }
      if (key.name === "down") {
        cursor = Math.min(ROWS.length - 1, cursor + 1);
        continue;
      }

      const row = ROWS[cursor]!;

      if (key.name === "return" && row.type === "role") {
        restore();
        let chosen: string | null = null;
        try {
          chosen = await openModelPicker(row.role);
        } catch {
          statusMsg = "Model picker error";
        }
        enterRawMode();
        if (chosen) {
          state.roleModels = { ...state.roleModels, [row.role]: chosen };
          saveState(state);
          statusMsg = `${row.role} → ${chosen}`;
        }
        continue;
      }

      if (key.name === "space") {
        switch (row.type) {
          case "multiProvider":
            state.multiProvider = !state.multiProvider;
            break;
          case "costAware":
            state.costAware = !state.costAware;
            break;
          case "autoCouncil":
            state.autoCouncil = !state.autoCouncil;
            break;
          case "experienceMode": {
            const idx = EXP_MODES.indexOf(state.experienceMode);
            state.experienceMode = EXP_MODES[(idx + 1) % EXP_MODES.length]!;
            break;
          }
          default:
            break;
        }
        saveState(state);
        continue;
      }

      if (key.name === "left") {
        switch (row.type) {
          case "rounds":
            state.rounds = Math.max(1, state.rounds - 1);
            break;
          case "confidence":
            state.confidence = Math.max(0.5, parseFloat((state.confidence - 0.05).toFixed(2)));
            break;
          case "minRoles":
            state.minRoles = Math.max(1, state.minRoles - 1);
            break;
          default:
            break;
        }
        saveState(state);
        continue;
      }

      if (key.name === "right") {
        switch (row.type) {
          case "rounds":
            state.rounds = Math.min(5, state.rounds + 1);
            break;
          case "confidence":
            state.confidence = Math.min(1.0, parseFloat((state.confidence + 0.05).toFixed(2)));
            break;
          case "minRoles":
            state.minRoles = Math.min(4, state.minRoles + 1);
            break;
          default:
            break;
        }
        saveState(state);
      }
    }
  } finally {
    restore();
  }
}
