// ---------------------------------------------------------------------------
// LSP setup card controller — pure logic behind the inline multi-select
// "which languages do you work in?" card. Parallel to ee-connect-controller
// (same DI shape) but deliberately SEPARATE: sharing controllers would couple
// EE onboarding and LSP onboarding lifecycles.
// ---------------------------------------------------------------------------
// The React side (use-app-logic + LspSetupCard) only holds keyboard/render
// state; the language list, toggle semantics, and the confirm/install pipeline
// live here so they are unit-testable with mocked deps.
// ---------------------------------------------------------------------------

import { listBuiltInServerMeta } from "../lsp/builtins.js";
import { recordLspConfigured } from "../lsp/lsp-setup-onboarding.js";
import {
  defaultLspSetupDeps,
  installLspServers,
  LSP_INSTALL_RECIPES,
  type LspInstallStatus,
} from "../lsp/lsp-setup.js";
import type { LspBuiltInServerId } from "../lsp/types.js";

export interface LspSetupLanguageOption {
  id: LspBuiltInServerId;
  /** Human language label ("TypeScript / JavaScript", "Python", …). */
  label: string;
  /** Short hint for the cursor row (extensions + how it installs). */
  hint: string;
}

function installHint(id: LspBuiltInServerId): string {
  const recipe = LSP_INSTALL_RECIPES[id];
  switch (recipe.kind) {
    case "npm":
      return "auto-installs";
    case "toolchain":
      return `installs via ${recipe.toolchain?.bin}`;
    default:
      return "shows the install command";
  }
}

/**
 * The picker's language list — derived from the built-in server table
 * (builtins.ts) + the install recipes, never a separate hardcoded list.
 */
export function buildLspSetupLanguages(): LspSetupLanguageOption[] {
  return listBuiltInServerMeta().map((server) => {
    const recipe = LSP_INSTALL_RECIPES[server.id];
    return {
      id: server.id,
      label: recipe.label,
      hint: `${server.extensions.slice(0, 4).join(" ")} — ${installHint(server.id)}`,
    };
  });
}

/** Space-toggle: pure set arithmetic (never mutates the input set). */
export function toggleLspLanguage(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export interface LspSetupConfirmDeps {
  install: (ids: readonly LspBuiltInServerId[]) => Promise<LspInstallStatus[]>;
  recordConfigured: () => void;
}

/**
 * Confirm pipeline: install the picked set → mark setup configured (so the
 * first-run nudge never fires again — even for an empty pick, which is a
 * deliberate "none of these"). Never throws; install statuses carry failures.
 */
export async function confirmLspSetup(
  ids: readonly LspBuiltInServerId[],
  deps: LspSetupConfirmDeps,
): Promise<LspInstallStatus[]> {
  const statuses = ids.length > 0 ? await deps.install(ids) : [];
  try {
    deps.recordConfigured();
  } catch {
    // Settings write failure must not break the result view.
  }
  return statuses;
}

/** Production dependency wiring for the confirm pipeline. */
export function defaultLspSetupConfirmDeps(): LspSetupConfirmDeps {
  return {
    install: (ids) => installLspServers(ids, defaultLspSetupDeps()),
    recordConfigured: recordLspConfigured,
  };
}
