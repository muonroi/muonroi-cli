/**
 * Ecosystem-aware prompt fragments for the Muonroi /ideal pipeline.
 *
 * Problem this solves:
 *   Without bias, leader LLMs default to general-purpose answers ("Node.js +
 *   Express" for SaaS web) — ignoring the fact that the user is running the
 *   *Muonroi ecosystem CLI* and almost certainly wants to build inside it.
 *   Discovery recommendations, debate stances, and research questions all
 *   need the same ecosystem framing so the council reasons WITHIN the
 *   existing template + package set instead of suggesting greenfield
 *   reinventions.
 *
 * Single source of truth for:
 *   - `buildEcosystemPreamble()` — discovery recommender prompt prefix.
 *   - `buildEcosystemDebateContext()` — debate-planner system-prompt suffix.
 *   - `buildEcosystemResearchSeed()` — research-stance lens augmentation.
 *   - `isEcosystemBiasEnabled()` — opt-out via userSettings (default ON).
 *
 * Opt-out: `userSettings.discoveryEcosystemBias = false` disables ALL four
 * inject sites in one switch, for users running muonroi-cli to build
 * something outside the ecosystem.
 *
 * Auto-suppress: even when the setting is ON, `shouldApplyEcosystemBias` will
 * suppress the bias for existing non-.NET repos (e.g. a TypeScript CLI). The
 * old behavior — pushing Muonroi.BaseTemplate / .NET 9 as defaults for a
 * TypeScript repo — caused councils to debate the wrong stack. See session
 * cfc711c57df0 (improve council quality in muonroi-cli) for the regression.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadUserSettings } from "../utils/settings.js";

/**
 * Default ON. Reads `userSettings.discoveryEcosystemBias` — only `false`
 * explicitly disables. `undefined`/`true` both → enabled.
 */
export function isEcosystemBiasEnabled(): boolean {
  try {
    const s = loadUserSettings();
    return s.discoveryEcosystemBias !== false;
  } catch {
    // Settings unreadable — fail OPEN (ecosystem bias active). Better to
    // over-bias than under-bias for the CLI of a specific ecosystem.
    return true;
  }
}

/**
 * Detection signal shape accepted by `shouldApplyEcosystemBias`. Kept loose
 * (Partial) so callers from different layers (discovery, council, loop-driver)
 * can pass whatever they have without coupling to the full ExistingProjectSignals type.
 */
export interface EcosystemBiasDetection {
  classification?: "greenfield" | "existing" | "ambiguous" | string;
  languages?: string[];
  manifests?: Array<{ type?: string; name?: string }>;
}

/**
 * Decide whether to apply Muonroi-ecosystem bias for the CURRENT call.
 *
 * Rule (binary, on folder state):
 *  - **Greenfield** (empty folder / no folder) → return true. Scaffolding a
 *    new project into the Muonroi ecosystem is the legitimate use of the
 *    preamble; .NET / BB / harness defaults belong here.
 *  - **Any folder with existing code** (existing OR ambiguous classification,
 *    OR cwd-probe finds manifests/source files) → return false. The leader
 *    must explore the existing stack and clarify the user's intent against
 *    THAT, not push a vendor-default stack on top of an unrelated codebase.
 *
 * Suppression also happens unconditionally when
 * `userSettings.discoveryEcosystemBias === false`.
 *
 * Signal precedence:
 *   1. setting → if `false`, return false immediately.
 *   2. detection.classification → if present, the literal value decides
 *      (greenfield ⇒ true; anything else ⇒ false). No language / manifest
 *      inspection — the user's rule is binary on folder state, not stack.
 *   3. cwd-probe fallback (sync, ~1ms) when detection is unavailable. Treats
 *      cwd as greenfield only when no source files AND no manifests are
 *      present at the top level. Any of `package.json`, `Cargo.toml`,
 *      `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `*.csproj`,
 *      `*.sln`, `Directory.Build.props`, or any source extension at the
 *      top level disqualifies. Probe errors are swallowed and treated as
 *      "not greenfield" (better to suppress bias than to over-bias on
 *      uncertainty for existing-project workflows).
 *   4. If neither detection nor cwd is provided, default to true
 *      (legacy behaviour — most discovery call sites pass detection).
 */
const _MANIFEST_FILENAMES = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "directory.build.props",
]);
const _SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rs",
  ".go",
  ".py",
  ".cs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
]);

function probeCwdIsGreenfield(cwd: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const lower = name.toLowerCase();
    if (_MANIFEST_FILENAMES.has(lower)) return false;
    if (lower.endsWith(".csproj") || lower.endsWith(".sln")) return false;
    const dot = lower.lastIndexOf(".");
    if (dot > 0 && _SOURCE_EXTS.has(lower.slice(dot))) return false;
  }
  return true;
}

export function shouldApplyEcosystemBias(opts?: { detection?: EcosystemBiasDetection; cwd?: string }): boolean {
  if (!isEcosystemBiasEnabled()) return false;

  const det = opts?.detection;
  if (det?.classification !== undefined) {
    return det.classification === "greenfield";
  }

  const cwd = opts?.cwd;
  if (cwd) {
    try {
      return probeCwdIsGreenfield(cwd);
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Discovery-recommender preamble. Prepended to the leader prompt for every
 * AskCard question so the leader recommends WITHIN the Muonroi ecosystem.
 *
 * Kept concise (~12 lines) — recommender uses maxTokens=4096 but the prompt
 * still competes with detection signals, prior runs, and context-so-far.
 */
export function buildEcosystemPreamble(): string {
  return [
    "Ecosystem context: this CLI ships with the Muonroi ecosystem. Recommend WITHIN it.",
    "",
    "Backend default:",
    "- .NET 9 with one of the Muonroi templates (nupkgs published on NuGet):",
    "  - Muonroi.BaseTemplate (greenfield, modular monolith)",
    "  - Muonroi.Microservices.Template (microservices)",
    "  - Muonroi.Modular.Template (modular monolith, larger scope)",
    "- Building blocks: muonroi-building-block (BB) — auth, audit, modular boundaries, rule engines.",
    "- DB: PostgreSQL via EF Core / Npgsql.",
    "",
    "Frontend default:",
    "- React with @muonroi/agent-harness-react wrapper, or",
    "- Angular with @muonroi/agent-harness-angular directive.",
    'When recommending `frontendApproach`, ALWAYS fill the optional `agentHarness` slot — pick "react" for React/Next, "angular" for Angular, "opentui" for terminal UI, "core" for non-DOM integration. Only use "none" when the project has no UI at all.',
    "",
    "Recommend non-ecosystem options ONLY when the user's prompt explicitly opts out (e.g. mentions Node.js/Express/Django by name).",
  ].join("\n");
}

/**
 * Debate-planner system-prompt suffix. Appended after the base debate prompt
 * so the leader plans stances framed around "optimal use of EXISTING ecosystem
 * packages" rather than greenfield analysis.
 *
 * Differs from the recommender preamble: this targets the stance LENS, not
 * the answer value. Tells the leader to pick stances that compare BB recipes,
 * not stances that compare general architectures.
 */
export function buildEcosystemDebateContext(): string {
  return [
    "## Ecosystem framing (Muonroi)",
    "Stances and output sections MUST be framed around optimal use of the existing Muonroi ecosystem packages:",
    "- muonroi-building-block (BB) — auth, audit, modular boundaries, rule engines",
    "- Muonroi.BaseTemplate / Muonroi.Microservices.Template / Muonroi.Modular.Template",
    "- @muonroi/agent-harness-{core,opentui,react,angular}",
    "",
    "When designing stances, prefer lenses that:",
    "1. Compare which BB package(s) solve the user's need without writing new infra.",
    "2. Identify modular boundaries (Authorization, Infrastructure, Application/Queries vs Commands) using existing template conventions.",
    "3. Surface mismatches between the user's brief and the conventions baked into the templates.",
    "",
    "Avoid stances that propose greenfield reinventions of features already shipped by BB.",
  ].join("\n");
}

/**
 * Research-stance lens augmentation. Returns a string appended to the
 * `Researcher` and `Architect` stance lenses in the research phase, so the
 * debate prioritizes `muonroi-docs` MCP queries + existing-package
 * composition before reaching for the open web.
 */
export interface EcosystemResearchSeed {
  researcherLens: string;
  architectLens: string;
  skepticLens: string;
}

export function buildEcosystemResearchSeed(): EcosystemResearchSeed {
  return {
    researcherLens:
      "Query muonroi-docs MCP first (`docs_search` for BB package usage, recipes, conventions). " +
      "Fall back to web search ONLY when muonroi-docs returns nothing relevant. " +
      "When the user names a specific URL on docs.muonroi.com, fetch it directly via web_fetch — " +
      "the same content is in MCP but the URL anchor signals the user wants that exact page. " +
      "Identify which existing BB / template packages address the user's need before proposing new code.",
    architectLens:
      "Compose the solution from EXISTING ecosystem packages (BB, Muonroi.* templates, " +
      "@muonroi/agent-harness-*). Greenfield code is allowed only for domain logic that " +
      "no shipped package covers. Mirror the directory/namespace conventions of the chosen template.",
    skepticLens:
      "Stress-test claims against the ACTUAL behavior of BB packages. " +
      "If a proposal cites a feature, demand evidence from muonroi-docs that the package supports it. " +
      "Flag every greenfield-reinvention risk where an ecosystem package would have sufficed.",
  };
}
