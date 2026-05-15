/**
 * tests/ee-ingest/parser.spec.ts
 *
 * Unit tests for the parsers in scripts/ingest-bb-to-ee.mts.
 * Parsers are extracted via inline re-implementation here to avoid
 * running the full CLI (which requires auth and network).
 * The fixture files in ./fixtures/ provide minimal stable inputs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline parser re-exports (mirrors the logic in ingest-bb-to-ee.mts)
// ---------------------------------------------------------------------------

interface DeepMapRow {
  package: string;
  file: string;
  classOrInterface: string;
  keyMethods: string;
}

function parseDeepMap(content: string): DeepMapRow[] {
  const rows: DeepMapRow[] = [];
  let currentPackage = "";

  for (const line of content.split("\n")) {
    const h3 = line.match(/^### (.+?) \(`/);
    if (h3) {
      currentPackage = h3[1].trim();
      continue;
    }
    if (line.startsWith("|") && !line.includes("---")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 3) {
        const [file, classOrInterface, ...rest] = cells;
        if (
          file === "File" ||
          file === "Tool" ||
          file === "Sample" ||
          file === "Area" ||
          file === "Command"
        )
          continue;
        const keyMethods = rest.join(" | ");
        if (currentPackage && file && classOrInterface) {
          rows.push({ package: currentPackage, file, classOrInterface, keyMethods });
        }
      }
    }
  }
  return rows;
}

interface PackageFamilyRow {
  area: string;
  ossPackages: string[];
  commercialPackages: string[];
}

function parsePackageFamilies(content: string): PackageFamilyRow[] {
  const rows: PackageFamilyRow[] = [];
  if (!content.includes("## Package Families") && !content.includes("## Package families"))
    return rows;

  const sectionStart = Math.max(
    content.indexOf("## Package Families"),
    content.indexOf("## Package families"),
  );
  const sectionEnd = content.indexOf("\n##", sectionStart + 1);
  const section = sectionEnd === -1 ? content.slice(sectionStart) : content.slice(sectionStart, sectionEnd);

  for (const line of section.split("\n")) {
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 2) continue;
    const [area, ossRaw, commercialRaw] = cells;
    if (area === "Area" || area === "area") continue;

    const extractPkgs = (raw: string) =>
      raw
        ? raw
            .split(/[`,]/)
            .map((s) => s.trim())
            .filter((s) => s.startsWith("Muonroi."))
        : [];

    rows.push({
      area,
      ossPackages: extractPkgs(ossRaw ?? ""),
      commercialPackages: extractPkgs(commercialRaw ?? ""),
    });
  }
  return rows;
}

interface OssBoundaryRule {
  type: "general" | "oss-pkg" | "commercial-pkg";
  text: string;
  packageName?: string;
  category?: "oss" | "commercial";
}

function parseOssBoundary(content: string): OssBoundaryRule[] {
  const rules: OssBoundaryRule[] = [];

  const ruleSection = content.match(/## Rule\n([\s\S]*?)(?=\n##)/);
  if (ruleSection) {
    for (const line of ruleSection[1].split("\n")) {
      const text = line.replace(/^-\s*/, "").trim();
      if (text.length > 10) rules.push({ type: "general", text });
    }
  }

  const ossSection = content.match(/## OSS Packages[\s\S]*?\n([\s\S]*?)(?=\n## Commercial)/);
  if (ossSection) {
    for (const line of ossSection[1].split("\n")) {
      const pkg = line.replace(/^-\s*/, "").trim().replace(/\s+\(.*\)/, "");
      if (pkg.startsWith("Muonroi.")) {
        rules.push({
          type: "oss-pkg",
          text: `OSS package ${pkg} MUST NOT reference any Commercial package`,
          packageName: pkg,
          category: "oss",
        });
      }
    }
  }

  const commercialSection = content.match(/## Commercial Packages[\s\S]*?\n([\s\S]*?)$/);
  if (commercialSection) {
    for (const line of commercialSection[1].split("\n")) {
      const pkg = line.replace(/^-\s*/, "").trim().replace(/\s+\(.*\)/, "");
      if (pkg.startsWith("Muonroi.")) {
        rules.push({
          type: "commercial-pkg",
          text: `Commercial package ${pkg} requires a valid Muonroi commercial license for production use`,
          packageName: pkg,
          category: "commercial",
        });
      }
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Deterministic ID (mirrors ingest script 3.6)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

function deterministicId(source: string, text: string): string {
  return createHash("sha256").update(source + text, "utf8").digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES = resolve("tests/ee-ingest/fixtures");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseDeepMap", () => {
  const content = readFileSync(resolve(FIXTURES, "deep-map-snippet.md"), "utf8");
  const rows = parseDeepMap(content);

  it("returns at least 6 rows from the fixture", () => {
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  it("assigns the correct package name from H3", () => {
    const abstractionRows = rows.filter((r) => r.package === "RuleEngine.Abstractions");
    expect(abstractionRows.length).toBeGreaterThanOrEqual(3);
  });

  it("correctly parses IRule.cs row", () => {
    const row = rows.find((r) => r.file === "IRule.cs");
    expect(row).toBeDefined();
    expect(row?.classOrInterface).toMatch(/IRule/);
    expect(row?.keyMethods).toMatch(/EvaluateAsync/);
  });

  it("correctly parses Tenancy.Abstractions package", () => {
    const tenancyRows = rows.filter((r) => r.package === "Tenancy.Abstractions");
    expect(tenancyRows.length).toBeGreaterThanOrEqual(2);
  });

  it("does not include header rows", () => {
    const headerRow = rows.find((r) => r.file === "File");
    expect(headerRow).toBeUndefined();
  });

  it("does not include separator rows", () => {
    const sepRow = rows.find((r) => r.file.includes("---"));
    expect(sepRow).toBeUndefined();
  });
});

describe("parsePackageFamilies", () => {
  const content = readFileSync(resolve(FIXTURES, "readme-snippet.md"), "utf8");
  const families = parsePackageFamilies(content);

  it("returns 3 family rows from fixture", () => {
    expect(families.length).toBe(3);
  });

  it("Core area has OSS packages", () => {
    const core = families.find((f) => f.area === "Core");
    expect(core).toBeDefined();
    expect(core?.ossPackages).toContain("Muonroi.Core.Abstractions");
  });

  it("Governance area has both OSS and Commercial", () => {
    const gov = families.find((f) => f.area === "Governance");
    expect(gov?.ossPackages).toContain("Muonroi.Governance");
    expect(gov?.commercialPackages).toContain("Muonroi.Governance.Enterprise");
  });

  it("Core area commercial packages are empty (dash row)", () => {
    const core = families.find((f) => f.area === "Core");
    expect(core?.commercialPackages).toHaveLength(0);
  });
});

describe("parseOssBoundary", () => {
  const content = readFileSync(resolve(FIXTURES, "oss-boundary-snippet.md"), "utf8");
  const rules = parseOssBoundary(content);

  it("returns at least 7 rules from fixture", () => {
    // 2 general + 3 oss-pkg + 2 commercial-pkg
    expect(rules.length).toBeGreaterThanOrEqual(7);
  });

  it("general rules have type=general", () => {
    const general = rules.filter((r) => r.type === "general");
    expect(general.length).toBeGreaterThanOrEqual(1);
    expect(general[0].text).toMatch(/MUST NOT depend/);
  });

  it("OSS packages produce oss-pkg rules", () => {
    const ossPkgs = rules.filter((r) => r.type === "oss-pkg");
    expect(ossPkgs.length).toBe(3);
    expect(ossPkgs[0].text).toMatch(/MUST NOT reference any Commercial package/);
    expect(ossPkgs[0].category).toBe("oss");
  });

  it("Commercial packages produce commercial-pkg rules", () => {
    const comPkgs = rules.filter((r) => r.type === "commercial-pkg");
    expect(comPkgs.length).toBe(2);
    expect(comPkgs[0].packageName).toMatch(/^Muonroi\./);
    expect(comPkgs[0].category).toBe("commercial");
  });
});

describe("deterministicId", () => {
  it("returns a 32-char hex string", () => {
    const id = deterministicId("repo-deep-map", "IRule.cs: IRule<TContext> — EvaluateAsync");
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    const id1 = deterministicId("source", "text");
    const id2 = deterministicId("source", "text");
    expect(id1).toBe(id2);
  });

  it("differs for different source+text combos", () => {
    const id1 = deterministicId("source-a", "same text");
    const id2 = deterministicId("source-b", "same text");
    expect(id1).not.toBe(id2);
  });
});
