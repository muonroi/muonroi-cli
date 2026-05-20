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

  it("warns that template sample files are reference-only and should be deleted", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("REFERENCE ONLY");
    expect(result.toLowerCase()).toContain("delete all template sample");
  });

  it("instructs LLM to rename BaseTemplate/DocTemplate identifiers", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("BaseTemplate");
    expect(result).toContain("DocTemplate");
    expect(result.toLowerCase()).toContain("rename");
  });

  it("calls out .NET conventions explicitly", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("CancellationToken");
    expect(result).toContain("Async");
    expect(result).toContain("DTO");
    expect(result.toLowerCase()).toContain("namespace must mirror");
  });

  it("instructs LLM to preserve SemanticProvider in client scaffolds", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result).toContain("SemanticProvider");
    expect(result).toContain("VITE_API_BASE");
    expect(result.toLowerCase()).toContain("never delete or overwrite");
  });

  it("requires three async view states + strict ts + build verification on client", () => {
    const result = buildIdealContinuationPrompt(base);
    expect(result.toLowerCase()).toContain("loading, empty, error");
    expect(result).toContain('"strict": true');
    expect(result).toContain("bunx tsc --noEmit");
  });
});
