/**
 * scripts/ingest-self-qa-rule.mts
 *
 * Ingest the self-QA behavioral rule (docs/self-qa/ee-rule-seed.json) into the
 * Experience Engine via POST /api/ingest-point.
 *
 * The seed file targets `muonroi-cli-behavioral` but that collection is not in
 * EE's KNOWN_COLLECTIONS yet. We ingest into `experience-behavioral` with
 * scope.project_include=["muonroi-cli"] so the entry still narrows correctly.
 *
 * Auth: reads EE_AUTH_TOKEN from env first; if absent, reads
 *       ~/.experience/config.json:serverAuthToken
 *
 * Usage:
 *   bun run scripts/ingest-self-qa-rule.mts [--dry-run] [--ee-url <url>]
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    "ee-url": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`Usage: bun run scripts/ingest-self-qa-rule.mts [--dry-run] [--ee-url <url>]`);
  process.exit(0);
}

interface EeConfig {
  serverBaseUrl?: string;
  serverAuthToken?: string;
}

function loadEeConfig(): EeConfig {
  try {
    const p = join(homedir(), ".experience", "config.json");
    return JSON.parse(readFileSync(p, "utf8")) as EeConfig;
  } catch {
    return {};
  }
}

const cfg = loadEeConfig();
const EE_URL = args["ee-url"] || cfg.serverBaseUrl || "http://100.79.164.25:8082";
const AUTH = process.env["EE_AUTH_TOKEN"] || cfg.serverAuthToken;
if (!AUTH) {
  console.error("FATAL: no auth token (set EE_AUTH_TOKEN or ~/.experience/config.json:serverAuthToken)");
  process.exit(1);
}

const seedPath = join(import.meta.dir, "..", "docs", "self-qa", "ee-rule-seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as {
  entries: Array<{
    id: string;
    title: string;
    confidence: string;
    trigger: { tool: string[]; fileGlobs: string[] };
    scope: { project_include?: string[]; lang_include?: string[] };
    message: string;
    why: string;
    how_to_apply: string;
  }>;
};

interface IngestPoint {
  id: string;
  text: string;
  collection: string;
  payload: Record<string, unknown>;
}

const points: IngestPoint[] = seed.entries.map((e) => {
  const text = [
    `Title: ${e.title}`,
    "",
    `Trigger files: ${e.trigger.fileGlobs.join(", ")}`,
    `Trigger tools: ${e.trigger.tool.join(", ")}`,
    "",
    "Message:",
    e.message,
    "",
    `Why: ${e.why}`,
    `How to apply: ${e.how_to_apply}`,
  ].join("\n");
  // EE experience-core.js shape:
  //  - payload.json: { scope, solution, confidence, domain, ... }
  //    `solution` is the text the agent sees. Confidence ≥ 0.42 to surface
  //    (see scoring.js:computeEffectiveConfidence + config.js:getMinConfidence).
  //  - Flat payload.scope_* keys: required by the Qdrant index-level pre-filter
  //    (queryFilter closure in experience-core.js around line 166-216).
  const solutionText = [e.message, "", `Why: ${e.why}`, `How to apply: ${e.how_to_apply}`].join("\n");
  const confMap: Record<string, number> = { low: 0.5, medium: 0.7, high: 0.85 };
  const numericConfidence = confMap[e.confidence.toLowerCase()] ?? 0.7;
  const expJson = {
    scope: {
      lang: "typescript",
      project_slug: "muonroi-cli",
      framework: "any",
    },
    solution: solutionText,
    domain: "ui-harness",
    confidence: numericConfidence,
    isSeed: true,
    slug: e.id,
    title: e.title,
    tool_triggers: e.trigger.tool,
    file_globs: e.trigger.fileGlobs,
    source: "muonroi-cli/docs/self-qa/ee-rule-seed.json",
  };
  return {
    id: deterministicUuid(`self-qa:${e.id}`),
    text,
    collection: "experience-behavioral",
    payload: {
      kind: "behavioral",
      // payload.json — read by post-filter applyScopeFilter() in experience-core.js
      json: JSON.stringify(expJson),
      // Flat scope_* keys — read by the Qdrant index-level pre-filter (queryFilter
      // closure in experience-core.js). Without these the pre-filter drops the
      // point before topK selection because it does NOT match is_empty(scope_lang).
      scope_lang: "typescript",
      scope_framework: "any",
      scope_project_slug: "muonroi-cli",
      slug: e.id,
      title: e.title,
      confidence: e.confidence,
      seeded_at: new Date().toISOString(),
    },
  };
});

console.log(`[ingest-self-qa] target=${EE_URL} collection=experience-behavioral points=${points.length}`);

if (args["dry-run"]) {
  console.log(JSON.stringify(points, null, 2));
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const p of points) {
  const url = `${EE_URL}/api/ingest-point`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH}`,
    },
    body: JSON.stringify(p),
  });
  if (res.ok) {
    const body = (await res.json()) as { id: string; success: boolean };
    console.log(`  ✓ ${p.id} → ${body.success ? "OK" : "noop"}`);
    ok++;
  } else {
    const text = await res.text();
    console.error(`  ✗ ${p.id} → ${res.status} ${text.slice(0, 200)}`);
    failed++;
  }
}

console.log(`\n[ingest-self-qa] done: ok=${ok} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
