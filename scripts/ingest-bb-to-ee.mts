/**
 * ingest-bb-to-ee.mts
 *
 * CLI script: ingest structured assets from muonroi-building-block (and template repos)
 * into the Experience Engine (EE).
 *
 * Auth: reads EE_AUTH_TOKEN from env first; if absent, reads ~/.experience/config.json:serverAuthToken
 *       Errors out with a clear hint if neither resolves.
 *
 * Usage:
 *   bun run scripts/ingest-bb-to-ee.mts \
 *     --bb-root D:/sources/Core/muonroi-building-block \
 *     --templates-root D:/sources/Core \
 *     [--dry-run] \
 *     [--collection-filter bb-recipes]
 *
 *   # From flowcore crawler output (manifest-driven GitHub + web docs):
 *   bun run scripts/ingest-bb-to-ee.mts --docs-points /tmp/flowcore-docs-points.jsonl [--dry-run] [--ee-url ...]
 *
 * Collections written:
 *   bb-behavioral        — per-row REPO_DEEP_MAP.md points + schema file points
 *   bb-recipes           — sample READMEs + template intents
 *   experience-principles — package-family rows + OSS-BOUNDARY hard rules
 *   ecosystem            — Muonroi/BB internal docs (from flowcore)
 *   external             — trusted 3rd-party lib/framework docs (from flowcore)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "bb-root": { type: "string" },
    "templates-root": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "collection-filter": { type: "string" },
    "ee-url": { type: "string", default: "https://experience.muonroi.com" },
    "docs-points": { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Usage:
  bun run scripts/ingest-bb-to-ee.mts --bb-root <path> --templates-root <path> [--dry-run] [--collection-filter <col>]
  bun run scripts/ingest-bb-to-ee.mts --docs-points <points.json|jsonl> [--dry-run] [--ee-url <url>]

Options:
  --bb-root           Path to muonroi-building-block repo root
  --templates-root    Path to the directory containing Muonroi.*Template repos
  --dry-run           Print what would be ingested; no HTTP POST
  --collection-filter Ingest only this collection (bb-behavioral | bb-recipes | experience-principles | ecosystem | external)
  --ee-url            EE base URL (default: https://experience.muonroi.com)
  --docs-points       Path to JSON or JSONL file of pre-chunked docs points from flowcore crawler (each: {id?, text, collection, payload?}). Enables manifest-driven GitHub+web ingestion.
`);
  process.exit(0);
}

const BB_ROOT = args["bb-root"] ?? "D:/sources/Core/muonroi-building-block";
const TEMPLATES_ROOT = args["templates-root"] ?? "D:/sources/Core";
const DRY_RUN = args["dry-run"] ?? false;
const COLLECTION_FILTER = args["collection-filter"] ?? null;
const EE_URL = args["ee-url"] ?? "https://experience.muonroi.com";
const DOCS_POINTS_PATH = args["docs-points"] ?? null;

const STATE_FILE = resolve(process.cwd(), ".ee-ingest-state.json");

// ---------------------------------------------------------------------------
// Auth resolution (3.9)
// ---------------------------------------------------------------------------

function resolveAuthToken(): string {
  const fromEnv = process.env.EE_AUTH_TOKEN;
  if (fromEnv) return fromEnv;

  const configPath = join(homedir(), ".experience", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.serverAuthToken) return cfg.serverAuthToken;
    } catch {
      // fall through
    }
  }

  console.error(
    "ERROR: No auth token found.\n" +
      "  Set EE_AUTH_TOKEN env var, or ensure ~/.experience/config.json has serverAuthToken.\n" +
      "  Example: export EE_AUTH_TOKEN=your-token-here",
  );
  process.exit(1);
}

const AUTH_TOKEN = resolveAuthToken();

// ---------------------------------------------------------------------------
// State / hash-watch (3.7)
// ---------------------------------------------------------------------------

type IngestState = Record<string, string>; // filepath → sha256 of file contents

function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(state: IngestState): void {
  if (!DRY_RUN) {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function deterministicId(source: string, text: string): string {
  return sha256(source + text).slice(0, 32);
}

// ---------------------------------------------------------------------------
// EE client
// ---------------------------------------------------------------------------

interface EEPoint {
  id: string;
  text: string;
  collection: string;
  payload?: Record<string, unknown>;
}

type IngestResult = { new: number; updated: number; unchanged: number; failed: number };

const POST_THROTTLE_MS = Number(process.env.EE_POST_THROTTLE_MS ?? 250);
const MAX_429_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postPoint(point: EEPoint): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${EE_URL}/api/ingest-point`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify(point),
      });
      if (resp.status === 429) {
        // Exponential backoff on rate limit: 1s, 2s, 4s, 8s
        const backoffMs = 1000 * 2 ** attempt;
        if (attempt < MAX_429_RETRIES) {
          await sleep(backoffMs);
          continue;
        }
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        console.error(`  POST /api/extract failed ${resp.status}: ${body.slice(0, 200)}`);
        return false;
      }
      // Successful POST — apply throttle for the next request (rate-limit hygiene).
      if (POST_THROTTLE_MS > 0) await sleep(POST_THROTTLE_MS);
      return true;
    } catch (e) {
      console.error(`  Network error posting point: ${e}`);
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Counters per collection
// ---------------------------------------------------------------------------

const counters: Record<string, IngestResult> = {};

function getCounter(col: string): IngestResult {
  if (!counters[col]) counters[col] = { new: 0, updated: 0, unchanged: 0, failed: 0 };
  return counters[col];
}

async function ingestPoint(point: EEPoint, state: IngestState, fileKey: string, fileHash: string): Promise<void> {
  if (COLLECTION_FILTER && point.collection !== COLLECTION_FILTER) return;

  const counter = getCounter(point.collection);
  const stateKey = `${point.collection}:${point.id}`;
  const existingHash = state[stateKey];
  const pointHash = sha256(JSON.stringify(point));

  if (existingHash === pointHash) {
    counter.unchanged++;
    return;
  }

  const isNew = !existingHash;

  if (DRY_RUN) {
    console.log(`  [DRY-RUN] ${isNew ? "NEW" : "UPDATE"} ${point.collection}/${point.id}: ${point.text.slice(0, 80)}`);
    if (isNew) counter.new++;
    else counter.updated++;
    state[stateKey] = pointHash;
    return;
  }

  const ok = await postPoint(point);
  if (ok) {
    state[stateKey] = pointHash;
    if (isNew) counter.new++;
    else counter.updated++;
  } else {
    counter.failed++;
  }
}

// ---------------------------------------------------------------------------
// 3.1 — Parse REPO_DEEP_MAP.md
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

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // H3 = package section
    const h3 = line.match(/^### (.+?) \(`/);
    if (h3) {
      currentPackage = h3[1].trim();
      continue;
    }

    // Table row: | File | Class | Methods |
    // Must have at least 3 pipe-separated segments, skip header/separator rows
    if (line.startsWith("|") && !line.includes("---")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 3) {
        const [file, classOrInterface, ...rest] = cells;
        // Skip header rows
        if (file === "File" || file === "Tool" || file === "Sample" || file === "Area" || file === "Command") continue;
        const keyMethods = rest.join(" | ");
        if (currentPackage && file && classOrInterface) {
          rows.push({ package: currentPackage, file, classOrInterface, keyMethods });
        }
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// 3.2 — Parse README.md Package Families table
// ---------------------------------------------------------------------------

interface PackageFamilyRow {
  area: string;
  ossPackages: string[];
  commercialPackages: string[];
}

function parsePackageFamilies(content: string): PackageFamilyRow[] {
  const rows: PackageFamilyRow[] = [];
  const inFamiliesSection =
    content.indexOf("## Package Families") !== -1 || content.indexOf("## Package families") !== -1;
  if (!inFamiliesSection) return rows;

  const sectionStart = Math.max(content.indexOf("## Package Families"), content.indexOf("## Package families"));
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

// ---------------------------------------------------------------------------
// 3.3 — Parse OSS-BOUNDARY.md
// ---------------------------------------------------------------------------

interface OssBoundaryRule {
  type: "general" | "oss-pkg" | "commercial-pkg";
  text: string;
  packageName?: string;
  category?: "oss" | "commercial";
}

function parseOssBoundary(content: string): OssBoundaryRule[] {
  content = content.replace(/\r\n/g, "\n");
  const rules: OssBoundaryRule[] = [];

  // General rules section
  const ruleSection = content.match(/## Rule\n([\s\S]*?)(?=\n##)/);
  if (ruleSection) {
    for (const line of ruleSection[1].split("\n")) {
      const text = line.replace(/^-\s*/, "").trim();
      if (text.length > 10) {
        rules.push({ type: "general", text });
      }
    }
  }

  // OSS packages list
  const ossSection = content.match(/## OSS Packages[\s\S]*?\n([\s\S]*?)(?=\n## Commercial)/);
  if (ossSection) {
    for (const line of ossSection[1].split("\n")) {
      const pkg = line
        .replace(/^-\s*/, "")
        .trim()
        .replace(/\s+\(.*\)/, "");
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

  // Commercial packages list
  const commercialSection = content.match(/## Commercial Packages[\s\S]*?\n([\s\S]*?)$/);
  if (commercialSection) {
    for (const line of commercialSection[1].split("\n")) {
      const pkg = line
        .replace(/^-\s*/, "")
        .trim()
        .replace(/\s+\(.*\)/, "");
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
// 3.4 — Parse sample READMEs
// ---------------------------------------------------------------------------

interface SampleInfo {
  sampleDir: string;
  title: string;
  intent: string;
  intentKeywords: string[];
  packages: string[];
}

function parseSampleReadme(content: string, sampleDir: string): SampleInfo {
  const lines = content.split("\n");

  // Title: first H1
  const title =
    lines
      .find((l) => l.startsWith("# "))
      ?.slice(2)
      .trim() ?? basename(sampleDir);

  // Intent: H2 "What this demonstrates" section
  const intentLines: string[] = [];
  let inIntent = false;
  for (const line of lines) {
    if (line.match(/^## What this demonstrates/i)) {
      inIntent = true;
      continue;
    }
    if (inIntent) {
      if (line.startsWith("##")) break;
      intentLines.push(line);
    }
  }

  // Fallback: first 200 words from doc
  const intentText =
    intentLines
      .join(" ")
      .replace(/```[\s\S]*?```/g, "")
      .trim() ||
    content
      .replace(/```[\s\S]*?```/g, "")
      .split(/\s+/)
      .slice(0, 200)
      .join(" ");

  // Keywords from intent + H1/H2 headings
  const headings = lines.filter((l) => l.startsWith("#")).map((l) => l.replace(/^#+\s*/, "").toLowerCase());
  const intentWords = intentText
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  const allWords = [...headings, ...intentWords];
  // Deduplicate and pick distinct keywords
  const intentKeywords = [
    ...new Set(
      allWords.filter((w) =>
        [
          "rule",
          "decision",
          "fraud",
          "loan",
          "tenant",
          "multi",
          "cep",
          "workflow",
          "approval",
          "engine",
          "source",
          "generator",
          "saas",
          "quickstart",
          "detection",
          "table",
          "canary",
          "hot-reload",
          "postgres",
          "redis",
          "feel",
          "orchestration",
          "governance",
          "licensing",
        ].some((kw) => w.includes(kw)),
      ),
    ),
  ].slice(0, 10);

  // Extract package references from code blocks
  const packageRefs = [...content.matchAll(/Muonroi\.\w+(?:\.\w+)*/g)].map((m) => m[0]);

  const packages = [...new Set(packageRefs)];

  return {
    sampleDir: basename(sampleDir),
    title,
    intent: intentText.slice(0, 400),
    intentKeywords,
    packages,
  };
}

// ---------------------------------------------------------------------------
// 3.5 — Schema file points
// ---------------------------------------------------------------------------

interface SchemaInfo {
  schemaPath: string;
  description: string;
  fieldsCount: number;
  category: string;
}

async function collectSchemas(schemaRoot: string): Promise<SchemaInfo[]> {
  const schemas: SchemaInfo[] = [];

  async function walk(dir: string, category: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip metrics dirs as they're sample data not contracts
        if (entry.name !== "metrics") {
          await walk(full, category || entry.name);
        }
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const content = await readFile(full, "utf8");
          const json = JSON.parse(content);
          const desc = json.description ?? json.title ?? "";
          const propsCount = Object.keys(json.properties ?? json.definitions ?? {}).length;
          // Only ingest contract/baseline schemas, skip sample data
          if (!full.includes("metrics")) {
            schemas.push({
              schemaPath: relative(schemaRoot, full).replace(/\\/g, "/"),
              description: desc,
              fieldsCount: propsCount,
              category: category || "root",
            });
          }
        } catch {
          // skip unparseable
        }
      }
    }
  }

  await walk(schemaRoot, "");
  return schemas;
}

// ---------------------------------------------------------------------------
// 3.5b — Template intent ingestion
// ---------------------------------------------------------------------------

interface TemplateInfo {
  templateName: string;
  shortName: string;
  nugetId: string;
  intentKeywords: string[];
  packagesConsumed: string[];
  description: string;
}

async function collectTemplates(templatesRoot: string): Promise<TemplateInfo[]> {
  const results: TemplateInfo[] = [];
  const templateDirs = ["Muonroi.BaseTemplate", "Muonroi.Modular.Template", "Muonroi.Microservices.Template"];

  for (const dir of templateDirs) {
    const tplRoot = join(templatesRoot, dir);
    if (!existsSync(tplRoot)) continue;

    // Parse template.json
    const tplConfigPath = join(tplRoot, ".template.config", "template.json");
    let tplName = dir;
    let shortName = "";
    let description = "";
    let symbols: Record<string, unknown> = {};

    if (existsSync(tplConfigPath)) {
      try {
        const tplJson = JSON.parse(readFileSync(tplConfigPath, "utf8"));
        tplName = tplJson.name ?? dir;
        shortName = tplJson.shortName ?? "";
        description = tplJson.description ?? "";
        symbols = tplJson.symbols ?? {};
      } catch {
        // ignore
      }
    }

    // Derive nuget ID from directory name
    const nugetId = dir.replace(".Template", "");

    // Extract intent keywords from description + symbol descriptions
    const symbolDescs = Object.values(symbols)
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .flatMap((s) => [
        String(s.description ?? ""),
        ...((s.choices as Array<{ description?: string }>) ?? []).map((c) => c.description ?? ""),
      ])
      .join(" ");

    const allText = `${description} ${symbolDescs}`.toLowerCase();
    const keywords = [
      ...new Set(
        allText
          .split(/\W+/)
          .filter((w) => w.length > 4)
          .filter((w) =>
            [
              "base",
              "modular",
              "micro",
              "service",
              "solution",
              "template",
              "enterprise",
              "licensed",
              "control",
              "plane",
              "angular",
              "react",
              "tier",
              "oss",
              "governance",
              "monolith",
            ].some((kw) => w.includes(kw)),
          ),
      ),
    ].slice(0, 10);

    // Scan all csproj for Muonroi.* package references
    const pkgs: string[] = [];
    async function scanCsproj(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          await scanCsproj(full);
        } else if (entry.isFile() && entry.name.endsWith(".csproj")) {
          const content = await readFile(full, "utf8").catch(() => "");
          const found = [...content.matchAll(/PackageReference[^>]*Include="(Muonroi\.[^"]+)"/g)].map((m) => m[1]);
          pkgs.push(...found);
        }
      }
    }
    await scanCsproj(tplRoot);

    results.push({
      templateName: tplName,
      shortName,
      nugetId,
      intentKeywords: keywords,
      packagesConsumed: [...new Set(pkgs)],
      description,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main() {
  console.log(`EE ingest-bb-to-ee${DRY_RUN ? " [DRY-RUN]" : ""}`);
  console.log(`  BB root:         ${BB_ROOT}`);
  console.log(`  Templates root:  ${TEMPLATES_ROOT}`);
  console.log(`  EE URL:          ${EE_URL}`);
  if (COLLECTION_FILTER) console.log(`  Collection filter: ${COLLECTION_FILTER}`);
  if (DOCS_POINTS_PATH) console.log(`  Docs points (flowcore): ${DOCS_POINTS_PATH}`);
  console.log("");

  const state = loadState();
  const exitCode = 0;

  // ---- 3.1 REPO_DEEP_MAP.md → bb-behavioral ----
  const deepMapPath = join(BB_ROOT, "REPO_DEEP_MAP.md");
  if (existsSync(deepMapPath)) {
    console.log("Parsing REPO_DEEP_MAP.md → bb-behavioral ...");
    const content = readFileSync(deepMapPath, "utf8");
    const rows = parseDeepMap(content);
    console.log(`  Found ${rows.length} table rows`);

    for (const row of rows) {
      const text = `${row.file}: ${row.classOrInterface} — ${row.keyMethods}`;
      const point: EEPoint = {
        id: deterministicId("repo-deep-map", text),
        text,
        collection: "bb-behavioral",
        payload: {
          package: row.package,
          file: row.file,
          project_slug: "muonroi-building-block",
          source: "repo-deep-map",
        },
      };
      await ingestPoint(point, state, deepMapPath, sha256(content));
    }
  }

  // ---- 3.2 README.md Package Families → experience-principles ----
  const readmePath = join(BB_ROOT, "README.md");
  if (existsSync(readmePath)) {
    console.log("Parsing README.md Package Families → experience-principles ...");
    const content = readFileSync(readmePath, "utf8");
    const families = parsePackageFamilies(content);
    console.log(`  Found ${families.length} family rows`);

    for (const row of families) {
      const pkgList = [
        ...row.ossPackages.map((p) => `${p} (OSS)`),
        ...row.commercialPackages.map((p) => `${p} (Commercial)`),
      ].join(", ");
      const text = `${row.area} area packages: ${pkgList}`;
      const point: EEPoint = {
        id: deterministicId("readme-package-families", text),
        text,
        collection: "experience-principles",
        payload: {
          area: row.area,
          oss_packages: row.ossPackages,
          commercial_packages: row.commercialPackages,
          project_slug: "muonroi-building-block",
          source: "readme-package-families",
        },
      };
      await ingestPoint(point, state, readmePath, sha256(content));
    }
  }

  // ---- 3.3 OSS-BOUNDARY.md → experience-principles (severity: high) ----
  const boundaryPath = join(BB_ROOT, "OSS-BOUNDARY.md");
  if (existsSync(boundaryPath)) {
    console.log("Parsing OSS-BOUNDARY.md → experience-principles ...");
    const content = readFileSync(boundaryPath, "utf8");
    const rules = parseOssBoundary(content);
    console.log(`  Found ${rules.length} boundary rules`);

    for (const rule of rules) {
      const point: EEPoint = {
        id: deterministicId("oss-boundary", rule.text),
        text: rule.text,
        collection: "experience-principles",
        payload: {
          rule_type: rule.type,
          severity: "high",
          package: rule.packageName ?? null,
          category: rule.category ?? null,
          project_slug: "muonroi-building-block",
          source: "oss-boundary",
        },
      };
      await ingestPoint(point, state, boundaryPath, sha256(content));
    }
  }

  // ---- 3.4 samples/*/README.md → bb-recipes ----
  const samplesDir = join(BB_ROOT, "samples");
  if (existsSync(samplesDir)) {
    console.log("Parsing sample READMEs → bb-recipes ...");
    const sampleDirs = await readdir(samplesDir, { withFileTypes: true });
    let sampleCount = 0;

    for (const entry of sampleDirs) {
      if (!entry.isDirectory()) continue;
      const samplePath = join(samplesDir, entry.name, "README.md");
      if (!existsSync(samplePath)) continue;

      const content = readFileSync(samplePath, "utf8");
      const info = parseSampleReadme(content, entry.name);
      sampleCount++;

      const text = `${info.title}: ${info.intent.slice(0, 300)}`;
      const point: EEPoint = {
        id: deterministicId("bb-sample", `${entry.name}:${text}`),
        text,
        collection: "bb-recipes",
        payload: {
          sample_dir: info.sampleDir,
          packages: info.packages,
          intent_keywords: info.intentKeywords,
          project_slug: "muonroi-building-block",
          source: "bb-sample",
        },
      };
      await ingestPoint(point, state, samplePath, sha256(content));
    }
    console.log(`  Processed ${sampleCount} samples`);
  }

  // ---- 3.5 schema/*.json → bb-behavioral ----
  const schemaDir = join(BB_ROOT, "schema");
  if (existsSync(schemaDir)) {
    console.log("Parsing schema files → bb-behavioral ...");
    const schemas = await collectSchemas(schemaDir);
    console.log(`  Found ${schemas.length} schema files`);

    for (const schema of schemas) {
      const text = `Schema ${schema.schemaPath}${schema.description ? ` — ${schema.description}` : ""} (${schema.fieldsCount} fields, category: ${schema.category})`;
      const point: EEPoint = {
        id: deterministicId("bb-schema", schema.schemaPath),
        text,
        collection: "bb-behavioral",
        payload: {
          schema_path: schema.schemaPath,
          fields_count: schema.fieldsCount,
          category: schema.category,
          project_slug: "muonroi-building-block",
          source: "bb-schema",
        },
      };
      const schemaFullPath = join(schemaDir, schema.schemaPath);
      const schemaContent = existsSync(schemaFullPath) ? readFileSync(schemaFullPath, "utf8") : "";
      await ingestPoint(point, state, schemaFullPath, sha256(schemaContent));
    }
  }

  // ---- 3.5b Template intent → bb-recipes ----
  console.log("Parsing template repos → bb-recipes ...");
  const templates = await collectTemplates(TEMPLATES_ROOT);
  console.log(`  Found ${templates.length} templates`);

  for (const tpl of templates) {
    const pkgSummary = tpl.packagesConsumed.length > 0 ? ` | uses: ${tpl.packagesConsumed.join(", ")}` : "";
    const text = `Template ${tpl.templateName} (${tpl.shortName}): ${tpl.description}${pkgSummary}`;
    const point: EEPoint = {
      id: deterministicId("bb-template", `${tpl.nugetId}:${tpl.shortName}`),
      text,
      collection: "bb-recipes",
      payload: {
        template_name: tpl.templateName,
        short_name: tpl.shortName,
        nuget_id: tpl.nugetId,
        intent_keywords: tpl.intentKeywords,
        packages_consumed: tpl.packagesConsumed,
        project_slug: tpl.nugetId,
        source: "bb-template",
      },
    };
    const tplRoot = join(
      TEMPLATES_ROOT,
      tpl.nugetId === "Muonroi.BaseTemplate" ? "Muonroi.BaseTemplate" : `${tpl.nugetId}.Template`,
    );
    await ingestPoint(point, state, tplRoot, sha256(JSON.stringify(tpl)));
  }

  // ---- 3.6 Generic docs points (from flowcore harvester + adapters for GitHub/web manifest-driven crawl) ----
  // Flowcore outputs standardized points (id?, text, collection "ecosystem"|"external", payload with source_id/url/version/crawled_at/trust/path etc).
  // Reuses same deterministicId (if missing), incremental state (collection:id), throttle/backoff, /api/ingest-point.
  // Supports JSON array or JSONL. Idempotent via pointHash; dedup marker contract: <!-- <col>:<source_id or url>:<sha16> --> (Layer 3 + PIL will use).
  if (DOCS_POINTS_PATH) {
    console.log(`Loading docs points from flowcore crawler: ${DOCS_POINTS_PATH}`);
    let raw: string;
    try {
      raw = readFileSync(DOCS_POINTS_PATH, "utf8");
    } catch (e) {
      console.error(`  ERROR reading docs-points: ${e}`);
      process.exit(1);
    }
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    let points: EEPoint[] = [];
    if (lines.length === 1 && raw.trim().startsWith("[")) {
      // JSON array
      try { points = JSON.parse(raw); } catch { /* fall */ }
    }
    if (points.length === 0) {
      // JSONL
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          if (p && typeof p.text === "string" && p.collection) points.push(p);
        } catch {}
      }
    }
    console.log(`  Parsed ${points.length} candidate docs points`);
    let accepted = 0;
    for (const rawP of points) {
      if (!rawP.text || !rawP.collection) continue;
      const col = (rawP.collection === "ecosystem" || rawP.collection === "external") ? rawP.collection : (COLLECTION_FILTER || "ecosystem");
      if (COLLECTION_FILTER && col !== COLLECTION_FILTER) continue;
      const srcForId = (rawP.payload && (rawP.payload.source_id || rawP.payload.url)) || rawP.id || "flowcore-doc";
      let id = typeof rawP.id === "string" && rawP.id.length >= 16 ? rawP.id : deterministicId(String(srcForId), rawP.text);
      const point: EEPoint = {
        id,
        text: rawP.text,
        collection: col,
        payload: {
          ...(rawP.payload || {}),
          ingested_via: "flowcore-docs-crawl",
          crawled_at: (rawP.payload && rawP.payload.crawled_at) || new Date().toISOString(),
        },
      };
      // Use docs-points path + id as pseudo fileKey for logging; actual incremental is per collection:id
      await ingestPoint(point, state, `${DOCS_POINTS_PATH}:${id}`, sha256(rawP.text));
      accepted++;
    }
    console.log(`  Accepted/processed ${accepted} docs points (ecosystem/external)`);
  }

  // ---- Save updated state ----
  saveState(state);

  // ---- Summary (4.2) ----
  console.log("\n--- Ingest Summary ---");
  let anyFailed = false;
  for (const [col, c] of Object.entries(counters)) {
    if (COLLECTION_FILTER && col !== COLLECTION_FILTER) continue;
    console.log(
      `  ${col}: ✓ ingested ${c.new} new, ${c.updated} updated, ${c.unchanged} unchanged${c.failed > 0 ? `, ${c.failed} FAILED` : ""}`,
    );
    if (c.failed > 0) anyFailed = true;
  }

  if (DRY_RUN) {
    console.log("\n[DRY-RUN] No HTTP POSTs were made.");
  }

  // 4.3 — exit code 1 on any POST failure
  if (anyFailed) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
