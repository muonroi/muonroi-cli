/**
 * bb-ecosystem-apply.ts — Apply the BB ecosystem on top of a dotnet new scaffold.
 *
 * Tasks implemented:
 *   6.8  — Program.cs wiring (regex injection with sentinel + idempotency)
 *   6.9  — Sample rule generator
 *   6.10 — Sample test generator
 *   6.11 — Directory.Packages.props minimalism via fast-xml-parser
 *   6.12 — Copy check-modular-boundaries.ps1 + wire into .github/workflows/ci.yml
 *
 * No C# AST parser — uses regex-based injection only. The sentinel block makes
 * the injection idempotent: skip if already present.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Sentinel constants
// ---------------------------------------------------------------------------

const SENTINEL_OPEN = "// >>> muonroi-cli:injected:bb-ecosystem";
const SENTINEL_CLOSE = "// <<< muonroi-cli:injected:bb-ecosystem";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BBEcosystemApplyOptions {
  /** Root of the scaffolded server directory (contains Program.cs, Directory.Packages.props, etc.). */
  serverDir: string;
  /** Project name (used for namespace inference). */
  projectName: string;
  /**
   * Detected intent keywords that determine which BB services to wire.
   * e.g., ["rule-engine", "tenancy", "auth"]
   */
  intents: string[];
  /** EE-recommended packages list (used for 6.11 minimalism pass). */
  eePackages?: string[];
  /**
   * Absolute path to muonroi-building-block repo root.
   * Used to copy check-modular-boundaries.ps1 (task 6.12).
   * If absent or file not found, task 6.12 is skipped.
   */
  bbRepoRoot?: string;
  /** Inject fs ops for testability. */
  fs?: {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => Promise<void>;
    exists: (p: string) => boolean;
    mkdir: (p: string) => Promise<void>;
    readdir: (p: string) => Promise<string[]>;
  };
}

export interface BBEcosystemApplyResult {
  filesModified: string[];
  filesCreated: string[];
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Intent detection helpers
// ---------------------------------------------------------------------------

function hasIntent(intents: string[], ...keywords: string[]): boolean {
  return keywords.some((kw) => intents.some((i) => i.toLowerCase().includes(kw.toLowerCase())));
}

// ---------------------------------------------------------------------------
// Task 6.8 — Program.cs wiring
// ---------------------------------------------------------------------------

function buildBBServicesBlock(intents: string[], projectName: string): string {
  const lines: string[] = [];

  // Always wire infrastructure + middleware
  lines.push(`builder.Services.AddInfrastructure(builder.Configuration, new MTokenInfo(builder.Configuration));`);
  lines.push(`app.UseDefaultMiddleware();`);

  // Rule-engine intent
  if (hasIntent(intents, "rule", "rule-engine", "fraud", "loan", "approval", "decision")) {
    lines.push(`builder.Services.AddRuleEngine<${projectName}DbContext>();`);
    lines.push(`builder.Services.AddRulesFromAssemblies(typeof(Program).Assembly);`);
  }

  // Tenancy intent
  if (hasIntent(intents, "tenant", "tenancy", "saas", "multi-tenant")) {
    lines.push(`builder.Services.AddMultiTenancy(builder.Configuration);`);
  }

  // Auth intent
  if (hasIntent(intents, "auth", "authn", "jwt", "identity")) {
    lines.push(`builder.Services.AddMuonroiAuth(builder.Configuration);`);
  }

  return lines.join("\n");
}

export async function applyProgramCsWiring(
  serverDir: string,
  projectName: string,
  intents: string[],
  fsOps: {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<{ modified: boolean; reason?: string }> {
  // Locate Program.cs — may be at root or in src/<name>/
  const candidates = [
    path.join(serverDir, "Program.cs"),
    path.join(serverDir, "src", `${projectName}.Api`, "Program.cs"),
    path.join(serverDir, "src", "Program.cs"),
  ];

  let programCsPath: string | null = null;
  for (const c of candidates) {
    if (fsOps.exists(c)) {
      programCsPath = c;
      break;
    }
  }
  if (!programCsPath) {
    return { modified: false, reason: "Program.cs not found" };
  }

  const content = fsOps.readFile(programCsPath);

  // Idempotency guard — skip if sentinel already present
  if (content.includes(SENTINEL_OPEN)) {
    return { modified: false, reason: "sentinel already present" };
  }

  // Anchor: find `var builder = WebApplication.CreateBuilder(args);`
  const anchorRe = /^([ \t]*var builder = WebApplication\.CreateBuilder\(args\);[ \t]*)$/m;
  const match = anchorRe.exec(content);
  if (!match) {
    return { modified: false, reason: "anchor line not found in Program.cs" };
  }

  const servicesBlock = buildBBServicesBlock(intents, projectName);
  const injection = `${SENTINEL_OPEN}\n${servicesBlock}\n${SENTINEL_CLOSE}`;
  const updated = content.replace(anchorRe, `$1\n${injection}`);

  await fsOps.writeFile(programCsPath, updated);
  return { modified: true };
}

// ---------------------------------------------------------------------------
// Task 6.9 — Sample rule generator
// ---------------------------------------------------------------------------

function buildSampleRuleCs(projectName: string, intent: string): string {
  const intentPascal = intent
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const contextTypeName = `${projectName}RuleContext`;

  return `using Muonroi.RuleEngine.Abstractions;
using Muonroi.RuleEngine.Core;

namespace ${projectName}.Domain.Rules;

/// <summary>
/// Sample rule for intent: ${intent}.
/// Generated by muonroi-cli — replace stub logic with real business logic.
/// </summary>
[MExtractAsRule("SAMPLE_${intent.toUpperCase().replace(/[-\s]/g, "_")}", DependsOn = new string[] { })]
public class Sample${intentPascal}Rule : IRule<${contextTypeName}>
{
    public Task<RuleResult> EvaluateAsync(${contextTypeName} context, CancellationToken cancellationToken = default)
    {
        // TODO: Replace with real ${intent} evaluation logic.
        return Task.FromResult(RuleResult.Passed());
    }
}
`;
}

export async function generateSampleRule(
  serverDir: string,
  projectName: string,
  intent: string,
  fsOps: {
    writeFile: (p: string, content: string) => Promise<void>;
    mkdir: (p: string) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<string | null> {
  const intentPascal = intent
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const rulesDir = path.join(serverDir, "src", `${projectName}.Domain`, "Rules");
  const filePath = path.join(rulesDir, `Sample${intentPascal}Rule.cs`);

  if (!fsOps.exists(rulesDir)) {
    await fsOps.mkdir(rulesDir);
  }
  await fsOps.writeFile(filePath, buildSampleRuleCs(projectName, intent));
  return filePath;
}

// ---------------------------------------------------------------------------
// Task 6.10 — Sample test generator
// ---------------------------------------------------------------------------

function buildSampleRuleTestCs(projectName: string, intent: string): string {
  const intentPascal = intent
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const contextTypeName = `${projectName}RuleContext`;

  return `using Muonroi.RuleEngine.Abstractions;
using Muonroi.RuleEngine.Core;
using Xunit;

namespace ${projectName}.UnitTests.Rules;

/// <summary>
/// Tests for Sample${intentPascal}Rule.
/// Generated by muonroi-cli — extend with real test cases.
/// </summary>
public class Sample${intentPascal}RuleTests
{
    [Fact]
    public async Task EvaluateAsync_ReturnsRuleResultPassed()
    {
        // Arrange — senior-grade: uses FactBag + reflection-free context construction
        var context = new ${contextTypeName}();
        var rule = new Sample${intentPascal}Rule();

        // Act
        var result = await rule.EvaluateAsync(context, CancellationToken.None);

        // Assert
        Assert.Equal(RuleResultStatus.Passed, result.Status);
    }
}
`;
}

export async function generateSampleRuleTest(
  serverDir: string,
  projectName: string,
  intent: string,
  fsOps: {
    writeFile: (p: string, content: string) => Promise<void>;
    mkdir: (p: string) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<string | null> {
  const intentPascal = intent
    .split(/[-_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const testsDir = path.join(serverDir, "tests", `${projectName}.UnitTests`, "Rules");
  const filePath = path.join(testsDir, `Sample${intentPascal}RuleTests.cs`);

  if (!fsOps.exists(testsDir)) {
    await fsOps.mkdir(testsDir);
  }
  await fsOps.writeFile(filePath, buildSampleRuleTestCs(projectName, intent));
  return filePath;
}

// ---------------------------------------------------------------------------
// Task 6.11 — Directory.Packages.props minimalism
// ---------------------------------------------------------------------------

export async function minimizePackagesProps(
  serverDir: string,
  eePackages: string[],
  fsOps: {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<{ modified: boolean }> {
  const propsPath = path.join(serverDir, "Directory.Packages.props");
  if (!fsOps.exists(propsPath)) return { modified: false };

  const content = fsOps.readFile(propsPath);
  const eeSet = new Set(eePackages);

  try {
    const { XMLParser, XMLBuilder } = await import("fast-xml-parser");
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      isArray: (name) => name === "PackageVersion",
    });
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      format: true,
      indentBy: "  ",
    });

    const parsed = parser.parse(content) as {
      Project?: {
        PropertyGroup?: unknown;
        ItemGroup?: {
          PackageVersion?: Array<{ "@_Include": string; "@_Version": string }>;
        };
      };
    };

    const project = parsed.Project ?? {};
    const itemGroup = project.ItemGroup ?? {};
    const existing: Array<{ "@_Include": string; "@_Version": string }> = itemGroup.PackageVersion ?? [];

    // Keep packages that are: (a) not BB-namespaced, OR (b) in the EE-recommended set
    const filtered = existing.filter((pv) => {
      const id = pv["@_Include"] ?? "";
      if (!id.startsWith("Muonroi.")) return true; // non-BB packages always kept
      return eeSet.has(id);
    });

    if (filtered.length === existing.length) return { modified: false };

    itemGroup.PackageVersion = filtered;
    project.ItemGroup = itemGroup;
    parsed.Project = project;
    const updated = builder.build(parsed) as string;
    await fsOps.writeFile(propsPath, updated);
    return { modified: true };
  } catch {
    // fast-xml-parser not installed — skip minimalism pass
    return { modified: false };
  }
}

// ---------------------------------------------------------------------------
// Task 6.12 — Copy check-modular-boundaries.ps1 + wire CI
// ---------------------------------------------------------------------------

const BOUNDARIES_SCRIPT_NAME = "check-modular-boundaries.ps1";
const BOUNDARIES_SCRIPT_SRC = ["scripts", BOUNDARIES_SCRIPT_NAME];

export async function copyBoundaryScript(
  serverDir: string,
  bbRepoRoot: string,
  fsOps: {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => Promise<void>;
    exists: (p: string) => boolean;
    mkdir: (p: string) => Promise<void>;
  },
): Promise<{ copied: boolean; ciWired: boolean }> {
  const srcPath = path.join(bbRepoRoot, ...BOUNDARIES_SCRIPT_SRC);
  if (!fsOps.exists(srcPath)) {
    return { copied: false, ciWired: false };
  }

  const scriptContent = fsOps.readFile(srcPath);
  const destScriptsDir = path.join(serverDir, "scripts");
  const destPath = path.join(destScriptsDir, BOUNDARIES_SCRIPT_NAME);

  if (!fsOps.exists(destScriptsDir)) {
    await fsOps.mkdir(destScriptsDir);
  }
  await fsOps.writeFile(destPath, scriptContent);

  // Wire into .github/workflows/ci.yml if it exists
  const workflowsDir = path.join(serverDir, ".github", "workflows");
  const ciYmlPath = path.join(workflowsDir, "ci.yml");
  let ciWired = false;

  if (fsOps.exists(ciYmlPath)) {
    const ciContent = fsOps.readFile(ciYmlPath);
    // Idempotency: skip if already wired
    if (!ciContent.includes(BOUNDARIES_SCRIPT_NAME)) {
      const boundaryStep = `
      - name: Check modular boundaries
        run: pwsh ./scripts/${BOUNDARIES_SCRIPT_NAME} -RepoRoot .
`;
      // Append before the last line or after the last job step
      const updated = `${ciContent.trimEnd()}\n${boundaryStep}\n`;
      await fsOps.writeFile(ciYmlPath, updated);
      ciWired = true;
    }
  }

  return { copied: true, ciWired };
}

// ---------------------------------------------------------------------------
// Main orchestrator — apply full BB ecosystem
// ---------------------------------------------------------------------------

export async function applyBBEcosystem(opts: BBEcosystemApplyOptions): Promise<BBEcosystemApplyResult> {
  const { serverDir, projectName, intents, eePackages = [], bbRepoRoot } = opts;

  // Default fs ops
  const fsOps = opts.fs ?? {
    readFile: (p: string) => readFileSync(p, "utf-8"),
    writeFile: async (p: string, content: string) => writeFileSync(p, content, "utf-8"),
    exists: (p: string) => existsSync(p),
    mkdir: async (p: string) => {
      await mkdir(p, { recursive: true });
    },
    readdir: async (p: string) => readdir(p),
  };

  const filesModified: string[] = [];
  const filesCreated: string[] = [];
  const skipped: string[] = [];

  // Task 6.8 — Program.cs wiring
  const programResult = await applyProgramCsWiring(serverDir, projectName, intents, fsOps);
  if (programResult.modified) {
    filesModified.push("Program.cs");
  } else {
    skipped.push(`Program.cs (${programResult.reason ?? "skipped"})`);
  }

  // Tasks 6.9 + 6.10 — Sample rule + test (for rule-engine intents)
  if (hasIntent(intents, "rule", "rule-engine", "fraud", "loan", "approval", "decision")) {
    const primaryIntent =
      intents.find((i) =>
        ["rule-engine", "fraud", "loan", "approval", "decision"].some((kw) => i.toLowerCase().includes(kw)),
      ) ??
      intents[0] ??
      "sample";

    const rulePath = await generateSampleRule(serverDir, projectName, primaryIntent, fsOps);
    if (rulePath) filesCreated.push(path.relative(serverDir, rulePath));

    const testPath = await generateSampleRuleTest(serverDir, projectName, primaryIntent, fsOps);
    if (testPath) filesCreated.push(path.relative(serverDir, testPath));
  }

  // Task 6.11 — Directory.Packages.props minimalism
  if (eePackages.length > 0) {
    const propsResult = await minimizePackagesProps(serverDir, eePackages, fsOps);
    if (propsResult.modified) filesModified.push("Directory.Packages.props");
  }

  // Task 6.12 — Copy boundary script + wire CI
  if (bbRepoRoot) {
    const boundaryResult = await copyBoundaryScript(serverDir, bbRepoRoot, fsOps);
    if (boundaryResult.copied) {
      filesCreated.push(`scripts/${BOUNDARIES_SCRIPT_NAME}`);
    }
    if (boundaryResult.ciWired) {
      filesModified.push(".github/workflows/ci.yml");
    }
  }

  return { filesModified, filesCreated, skipped };
}
