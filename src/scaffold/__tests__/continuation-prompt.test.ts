/**
 * Unit tests for buildIdealContinuationPrompt.
 */

import { describe, expect, it } from "vitest";
import { buildIdealContinuationPrompt } from "../continuation-prompt.js";

describe("buildIdealContinuationPrompt", () => {
  const base = {
    originalPrompt: "todo app",
    projectDir: "/home/user/projects/todo-app",
    templateName: "Muonroi.BaseTemplate",
  };

  it("interpolates originalPrompt verbatim", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain('"todo app"');
  });

  it("includes the absolute projectDir path", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("/home/user/projects/todo-app");
  });

  it("includes the templateName", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("Muonroi.BaseTemplate");
  });

  it("includes the joined installedPackages list when provided", () => {
    const result = buildIdealContinuationPrompt({
      ...base,
      installedPackages: ["Muonroi.Auth", "Muonroi.Audit"],
    });
    expect(result).toContain("with packages: Muonroi.Auth, Muonroi.Audit");
  });

  it("omits the packages clause when installedPackages is empty", () => {
    const result = buildIdealContinuationPrompt({ ...base, installedPackages: [] });
    expect(result).not.toContain("with packages:");
  });

  it("omits the packages clause when installedPackages is not provided", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).not.toContain("with packages:");
  });

  it("mentions docs_search MCP tool and dotnet build", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("docs_search");
    expect(result).toContain("dotnet build");
  });

  it("instructs LLM to tolerate missing README/AGENTS files", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result.toLowerCase()).toContain("missing files are fine");
  });
});
