import { describe, expect, it, vi } from "vitest";
import { listBuiltInServerMeta } from "../../lsp/builtins.js";
import type { LspInstallStatus } from "../../lsp/lsp-setup.js";
import type { LspBuiltInServerId } from "../../lsp/types.js";
import {
  buildLspSetupLanguages,
  confirmLspSetup,
  type LspSetupConfirmDeps,
  toggleLspLanguage,
} from "../lsp-setup-controller.js";

describe("buildLspSetupLanguages", () => {
  it("derives the picker list 1:1 from the built-in server table (no separate hardcoded list)", () => {
    const languages = buildLspSetupLanguages();
    expect(languages.map((l) => l.id)).toEqual(listBuiltInServerMeta().map((s) => s.id));
  });

  it("labels are human language names and hints carry the extensions", () => {
    const languages = buildLspSetupLanguages();
    const ts = languages.find((l) => l.id === "typescript");
    expect(ts?.label).toBe("TypeScript / JavaScript");
    expect(ts?.hint).toContain(".ts");
    const go = languages.find((l) => l.id === "gopls");
    expect(go?.label).toBe("Go");
    expect(go?.hint).toContain("go");
  });
});

describe("toggleLspLanguage", () => {
  it("adds an unselected id and removes a selected one", () => {
    const empty = new Set<string>();
    const withTs = toggleLspLanguage(empty, "typescript");
    expect(withTs.has("typescript")).toBe(true);
    const withoutTs = toggleLspLanguage(withTs, "typescript");
    expect(withoutTs.has("typescript")).toBe(false);
  });

  it("never mutates the input set", () => {
    const original = new Set(["gopls"]);
    toggleLspLanguage(original, "gopls");
    toggleLspLanguage(original, "pyright");
    expect([...original]).toEqual(["gopls"]);
  });
});

function makeDeps(overrides: Partial<LspSetupConfirmDeps> = {}) {
  const statuses: LspInstallStatus[] = [
    { id: "typescript", label: "TypeScript / JavaScript", status: "installed" },
  ];
  const deps: LspSetupConfirmDeps = {
    install: vi.fn(async () => statuses),
    recordConfigured: vi.fn(),
    ...overrides,
  };
  return { deps, statuses };
}

describe("confirmLspSetup", () => {
  it("installs the picked set and records the setup as configured", async () => {
    const { deps, statuses } = makeDeps();
    const ids: LspBuiltInServerId[] = ["typescript"];
    await expect(confirmLspSetup(ids, deps)).resolves.toEqual(statuses);
    expect(deps.install).toHaveBeenCalledWith(ids);
    expect(deps.recordConfigured).toHaveBeenCalledTimes(1);
  });

  it("an empty pick still records configured (deliberate 'none of these') without installing", async () => {
    const { deps } = makeDeps();
    await expect(confirmLspSetup([], deps)).resolves.toEqual([]);
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.recordConfigured).toHaveBeenCalledTimes(1);
  });

  it("a failing settings write does not break the result view", async () => {
    const { deps, statuses } = makeDeps({
      recordConfigured: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    await expect(confirmLspSetup(["typescript"], deps)).resolves.toEqual(statuses);
  });
});
