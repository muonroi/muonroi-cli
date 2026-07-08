#!/usr/bin/env bun
/**
 * Ingest flowcore-crawled docs points into EE.
 * Usage:
 *   bun run scripts/ingest-flowcore-docs-to-ee.mts --points /path/to/flowcore-docs.jsonl --collection ecosystem
 *   --dry-run
 *
 * Expects JSONL or JSON array of EEPoint shape with collection already set or overridden by --collection.
 * Supports ecosystem vs external separation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ingestPoint, loadIngestState, saveIngestState } from "./ingest-bb-to-ee.mts"; // reuse core logic

interface Args {
  points: string;
  collection?: "ecosystem" | "external";
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: any = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--points") out.points = args[++i];
    if (args[i] === "--collection") out.collection = args[++i];
    if (args[i] === "--dry-run") out.dryRun = true;
  }
  if (!out.points) throw new Error("Missing --points <file.json|jsonl>");
  return out;
}

async function main() {
  const { points, collection, dryRun } = parseArgs();
  const file = resolve(points);
  const raw = readFileSync(file, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  const pts = lines.map((l) => JSON.parse(l));

  console.log(`Loading ${pts.length} docs points from flowcore crawler...`);

  const state = loadIngestState();
  let accepted = 0;

  for (const p of pts) {
    const targetCollection = collection || p.collection || "external";
    const id = p.id || (await import("./ingest-bb-to-ee.mts")).deterministicId(p); // reuse if exported
    const payload = { ...p.payload, ingested_via: "flowcore-docs-crawl", crawled_at: p.payload?.crawled_at };

    const point = {
      id: id || crypto.randomUUID().replace(/-/g, "").slice(0, 32),
      text: p.text,
      collection: targetCollection,
      payload,
    };

    const key = `${targetCollection}:${point.id}`;
    const contentHash = (await import("./ingest-bb-to-ee.mts")).contentHash(point);
    if (state[key] === contentHash) {
      if (dryRun) console.log(`[DRY-RUN] SKIP (unchanged) ${key}`);
      continue;
    }

    if (dryRun) {
      console.log(`[DRY-RUN] NEW ${targetCollection}/${point.id} (${targetCollection})`);
      accepted++;
      continue;
    }

    await ingestPoint(point); // reuse the existing throttled POST
    state[key] = contentHash;
    accepted++;
  }

  if (!dryRun) saveIngestState(state);
  console.log(`${dryRun ? "[DRY-RUN] " : ""}Accepted/processed ${accepted} docs points (${collection || "mixed"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
