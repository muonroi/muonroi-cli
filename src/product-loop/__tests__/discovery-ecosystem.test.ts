/**
 * Tests for the ecosystem-prompt module.
 *
 * Goal: every Council/discovery prompt path must frame answers within the
 * Muonroi ecosystem (BB, Muonroi.* templates, @muonroi/agent-harness-*) by
 * default. Opt-out toggles ALL paths off in one switch.
 */

import * as fsMod from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildEcosystemDebateContext,
  buildEcosystemPreamble,
  buildEcosystemResearchSeed,
  isEcosystemBiasEnabled,
  shouldApplyEcosystemBias,
} from "../discovery-ecosystem.js";

// Stub the user-settings reader so tests don't depend on a live config file.
vi.mock("../../utils/settings.js", async (orig) => {
  const real: Record<string, unknown> = await orig();
  return {
    ...real,
    loadUserSettings: vi.fn(() => ({})),
  };
});

import { loadUserSettings } from "../../utils/settings.js";

describe("buildEcosystemPreamble", () => {
  it("names the three Muonroi templates", () => {
    const text = buildEcosystemPreamble();
    expect(text).toContain("Muonroi.BaseTemplate");
    expect(text).toContain("Muonroi.Microservices.Template");
    expect(text).toContain("Muonroi.Modular.Template");
  });

  it("mentions muonroi-building-block (BB) as the default building blocks", () => {
    const text = buildEcosystemPreamble();
    expect(text).toContain("muonroi-building-block");
    expect(text).toContain("BB");
  });

  it("lists both React + Angular agent-harness adapters", () => {
    const text = buildEcosystemPreamble();
    expect(text).toContain("@muonroi/agent-harness-react");
    expect(text).toContain("@muonroi/agent-harness-angular");
  });

  it("explicitly allows opt-out only when the user names a non-ecosystem stack", () => {
    const text = buildEcosystemPreamble();
    expect(text.toLowerCase()).toContain("explicitly opts out");
  });

  it("defaults backend stack to .NET 9", () => {
    const text = buildEcosystemPreamble();
    expect(text).toContain(".NET 9");
  });
});

describe("buildEcosystemDebateContext", () => {
  it("frames stances around optimal use of existing packages, not greenfield", () => {
    const text = buildEcosystemDebateContext();
    expect(text.toLowerCase()).toContain("optimal use");
    expect(text.toLowerCase()).toContain("avoid stances that propose greenfield reinventions");
  });

  it("names BB + the three templates so the leader has concrete options", () => {
    const text = buildEcosystemDebateContext();
    expect(text).toContain("muonroi-building-block");
    expect(text).toContain("Muonroi.BaseTemplate");
    expect(text).toContain("Muonroi.Microservices.Template");
    expect(text).toContain("Muonroi.Modular.Template");
  });

  it("mentions Authorization + Infrastructure + Queries/Commands as modular boundaries", () => {
    const text = buildEcosystemDebateContext();
    expect(text).toContain("Authorization");
    expect(text).toContain("Infrastructure");
    expect(text).toContain("Queries");
    expect(text).toContain("Commands");
  });
});

describe("buildEcosystemResearchSeed", () => {
  it("Researcher lens prioritizes muonroi-docs MCP over web search", () => {
    const seed = buildEcosystemResearchSeed();
    expect(seed.researcherLens).toContain("muonroi-docs");
    expect(seed.researcherLens).toContain("docs_search");
    expect(seed.researcherLens.toLowerCase()).toContain("first");
    expect(seed.researcherLens.toLowerCase()).toContain("fall back to web");
  });

  it("Architect lens forbids greenfield reinventions where a package exists", () => {
    const seed = buildEcosystemResearchSeed();
    expect(seed.architectLens.toLowerCase()).toContain("existing");
    expect(seed.architectLens.toLowerCase()).toContain("greenfield code is allowed only");
  });

  it("Skeptic lens demands evidence from muonroi-docs before accepting feature claims", () => {
    const seed = buildEcosystemResearchSeed();
    expect(seed.skepticLens).toContain("muonroi-docs");
    expect(seed.skepticLens.toLowerCase()).toContain("evidence");
    expect(seed.skepticLens.toLowerCase()).toContain("reinvention");
  });
});

describe("isEcosystemBiasEnabled", () => {
  it("defaults to true when discoveryEcosystemBias is undefined", () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({});
    expect(isEcosystemBiasEnabled()).toBe(true);
  });

  it("returns true when discoveryEcosystemBias === true", () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      discoveryEcosystemBias: true,
    });
    expect(isEcosystemBiasEnabled()).toBe(true);
  });

  it("returns false only when discoveryEcosystemBias === false", () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      discoveryEcosystemBias: false,
    });
    expect(isEcosystemBiasEnabled()).toBe(false);
  });

  it("fails OPEN when settings read throws", () => {
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("disk error");
    });
    expect(isEcosystemBiasEnabled()).toBe(true);
  });
});

describe("shouldApplyEcosystemBias", () => {
  const setSetting = (value: unknown) =>
    (loadUserSettings as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(value as Record<string, unknown>);

  it("explicit opt-out short-circuits regardless of classification", () => {
    setSetting({ discoveryEcosystemBias: false });
    expect(shouldApplyEcosystemBias({ detection: { classification: "greenfield" } })).toBe(false);
  });

  it("greenfield classification → bias ON (scaffold into ecosystem)", () => {
    setSetting({});
    expect(shouldApplyEcosystemBias({ detection: { classification: "greenfield" } })).toBe(true);
  });

  it("existing classification → bias OFF (don't push vendor defaults — regression cfc711c57df0)", () => {
    setSetting({});
    expect(
      shouldApplyEcosystemBias({
        detection: { classification: "existing", languages: ["TypeScript"], manifests: [{ type: "package.json" }] },
      }),
    ).toBe(false);
  });

  it("existing .NET classification → also bias OFF (rule is folder-state, not stack)", () => {
    setSetting({});
    expect(
      shouldApplyEcosystemBias({
        detection: { classification: "existing", languages: ["C#"], manifests: [{ type: "MyApp.csproj" }] },
      }),
    ).toBe(false);
  });

  it("ambiguous classification → bias OFF (folder has code, treat like existing)", () => {
    setSetting({});
    expect(shouldApplyEcosystemBias({ detection: { classification: "ambiguous", languages: ["TypeScript"] } })).toBe(
      false,
    );
  });

  it("cwd-probe: empty directory → bias ON", () => {
    setSetting({});
    const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), "muonroi-eco-empty-"));
    try {
      expect(shouldApplyEcosystemBias({ cwd: tmp })).toBe(true);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cwd-probe: directory with package.json → bias OFF", () => {
    setSetting({});
    const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), "muonroi-eco-pkg-"));
    try {
      fsMod.writeFileSync(path.join(tmp, "package.json"), "{}");
      expect(shouldApplyEcosystemBias({ cwd: tmp })).toBe(false);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cwd-probe: directory with a .csproj → bias OFF", () => {
    setSetting({});
    const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), "muonroi-eco-cs-"));
    try {
      fsMod.writeFileSync(path.join(tmp, "MyApp.csproj"), "<Project/>");
      expect(shouldApplyEcosystemBias({ cwd: tmp })).toBe(false);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cwd-probe: directory with only a stray source file (no manifest) → bias OFF", () => {
    setSetting({});
    const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), "muonroi-eco-src-"));
    try {
      fsMod.writeFileSync(path.join(tmp, "stray.ts"), "export {};");
      expect(shouldApplyEcosystemBias({ cwd: tmp })).toBe(false);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cwd-probe: directory with only dotfiles (e.g. .git) → still greenfield", () => {
    setSetting({});
    const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), "muonroi-eco-git-"));
    try {
      fsMod.mkdirSync(path.join(tmp, ".git"));
      fsMod.writeFileSync(path.join(tmp, ".gitignore"), "node_modules\n");
      expect(shouldApplyEcosystemBias({ cwd: tmp })).toBe(true);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detection wins over cwd: existing classification suppresses even when cwd is empty", () => {
    setSetting({});
    const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), "muonroi-eco-mixed-"));
    try {
      expect(shouldApplyEcosystemBias({ detection: { classification: "existing" }, cwd: tmp })).toBe(false);
    } finally {
      fsMod.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no detection, no cwd → defaults to ON (legacy callers)", () => {
    setSetting({});
    expect(shouldApplyEcosystemBias()).toBe(true);
  });
});
