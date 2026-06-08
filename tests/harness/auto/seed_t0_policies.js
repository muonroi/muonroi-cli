#!/usr/bin/env node
/**
 * One-shot: seed high-confidence T0 policy principles.
 *
 * Currently seeds:
 *   1. followed-habit — enforce calling exp-feedback after acting on a hint.
 *      Kept in T0 because the trigger ("the agent just acted on a hint") is
 *      semantic, not deterministic, so embedding match is the right layer.
 *
 * Moved out of T0 (do NOT re-add here):
 *   - file-size-cap-1000  — embedding match was unreliable (only fired when
 *     the query text contained explicit size language). Now lives in
 *     ~/experience-engine/.experience/src/static-rules.js as a deterministic
 *     rule that runs before vector lookup in handleIntercept (server.js).
 *     It checks line count + exempt paths (catalog.json, *.snap, fixtures,
 *     node_modules, etc.) and fires reliably regardless of content semantics.
 *
 * Idempotent: re-run is safe — uses deterministic UUIDs derived from sha1(slug).
 * Reads EMBED_KEY + QDRANT_KEY from env. Run on the VPS (Qdrant on localhost).
 */
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const EMBED_KEY = process.env.SILICONFLOW_API_KEY || process.env.EXPERIENCE_EMBED_KEY;
const QDRANT_KEY = process.env.QDRANT_API_KEY || process.env.EXPERIENCE_QDRANT_KEY;
const QDRANT = process.env.QDRANT_URL || "http://localhost:6333";
const COLL = process.env.EXPERIENCE_T0_COLLECTION || "experience-principles";

if (!EMBED_KEY || !QDRANT_KEY) {
  console.error("ERROR: set SILICONFLOW_API_KEY and QDRANT_API_KEY before running.");
  process.exit(2);
}

function deterministicUuid(slug) {
  const h = crypto
    .createHash("sha1")
    .update("seed-policy:" + slug)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function request(url, body, headers, method = "POST") {
  const u = new URL(url);
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, opts, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(s));
        } catch (err) {
          reject(new Error(`[${res.statusCode}] ${s.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function embed(text) {
  const r = await request(
    "https://api.siliconflow.com/v1/embeddings",
    { model: "Qwen/Qwen3-Embedding-0.6B", input: [text] },
    { Authorization: "Bearer " + EMBED_KEY },
  );
  if (!r.data || !r.data[0] || !r.data[0].embedding) {
    throw new Error("embedding failed: " + JSON.stringify(r).slice(0, 300));
  }
  return r.data[0].embedding;
}

const NOW = new Date().toISOString();

const ENTRIES = [
  {
    slug: "followed-feedback-habit",
    principle:
      "When [a PreToolUse hint (⚠️ [Experience] or 💡 [Suggestion]) shaped your tool call], do [call `node ~/.experience/exp-feedback.js followed <id> <coll>` immediately after the action lands] because [Gate 4 precision is measured as (followed + ignored) / (followed + ignored + noise); skipping `followed` lets a hint that actually helped get auto-pruned as dead weight, and T1 abstractions never gain the validatedHitCount they need to promote to T0]",
    failureMode: "silent positive — useful hint never gets credit",
    judgment:
      "Always emit `followed` feedback when an experience hint changed your approach. The hint ID and collection are printed at the end of every warning line.",
    conditions: ["experience-hint", "followed", "feedback", "exp-feedback", "preToolUse"],
    evidenceClass: "workflow",
    scope: { lang: "any", framework: "any", project_slug: "any" },
  },
  // file-size-cap-1000-lines: REMOVED. See engine static-rules.js.
];

(async () => {
  const points = [];
  for (const e of ENTRIES) {
    const text = `${e.principle}\n\nConditions: ${e.conditions.join(", ")}\nFailureMode: ${e.failureMode}\nJudgment: ${e.judgment}`;
    process.stdout.write(`[embed] ${e.slug}... `);
    const vector = await embed(text);
    process.stdout.write(`dim=${vector.length}\n`);

    const id = deterministicUuid(e.slug);
    const payloadJson = {
      id,
      principle: e.principle,
      solution: e.principle,
      scope: e.scope,
      failureMode: e.failureMode,
      judgment: e.judgment,
      conditions: e.conditions,
      evidenceClass: e.evidenceClass,
      provenance: { kind: "principle", source: "seed-policy", policySlug: e.slug },
      novelCaseEvidence: {
        seedSupportCount: 0,
        seedEntryIds: [],
        holdoutMatchedCount: 1,
        holdoutTestedCount: 1,
        holdoutSessions: ["seed-policy-init"],
        holdoutProjects: ["any"],
        lastMatchedAt: NOW,
      },
      tier: 0,
      confidence: 0.92,
      hitCount: 0,
      validatedCount: 0,
      surfaceCount: 0,
      ignoreCount: 0,
      unusedCount: 0,
      signalVersion: 2,
      confirmedAt: [],
      confirmedSessions: [],
      lastConfirmedSession: null,
      createdAt: NOW,
      createdFrom: "seed-policy",
      sourceCount: 1,
      promotedToT0At: NOW,
      probationary: false,
    };
    points.push({ id, vector, payload: { json: JSON.stringify(payloadJson) } });
  }

  process.stdout.write(`[upsert] ${points.length} points -> ${COLL}... `);
  const r = await request(
    QDRANT + "/collections/" + COLL + "/points?wait=true",
    { points },
    { "api-key": QDRANT_KEY },
    "PUT",
  );
  console.log(r.status || JSON.stringify(r).slice(0, 200));

  for (const e of ENTRIES) {
    const id = deterministicUuid(e.slug);
    console.log(`  - ${e.slug} -> ${id}`);
  }
  console.log("DONE");
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
