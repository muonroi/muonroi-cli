// Simulate orchestrator's PIL logging path against real DB; then read back rows
// to verify the schema we're writing matches what we'd expect to debug from.

import { loadEEAuthToken } from "../src/ee/auth.js";
import { detectEEClientMode } from "../src/ee/client-mode.js";
import { runPipeline } from "../src/pil/pipeline.js";
import { logInteraction } from "../src/storage/interaction-log.js";
import { getDatabase } from "../src/storage/db.js";

await loadEEAuthToken();
await detectEEClientMode();

const db = getDatabase();
const SESSION_ID = `test-pil-${Date.now()}`;
const WORKSPACE_ID = (db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string } | undefined)?.id;
if (!WORKSPACE_ID) throw new Error("no workspace in DB; run the CLI once first");
const now = new Date().toISOString();
db.prepare(
  `INSERT INTO sessions (id, workspace_id, model, mode, cwd_at_start, cwd_last, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(SESSION_ID, WORKSPACE_ID, "test-model", "test", process.cwd(), process.cwd(), "active", now, now);

const PROMPTS = [
  "Refactor this function to be async:\n```ts\nfunction foo() { return 1; }\n```",
  "Add JSDoc comments to this module",
  "hi",
  "tôi muốn check xem 6 layer pil có chạy đúng không",
  "Tests are failing with TypeError: cannot read property 'x' of undefined",
  // EE injection probe — should hit experience-principles (score ≥ 0.55)
  "fix permission on my private SSH key file at ~/.ssh/id_rsa, currently 0777",
];

for (const userMessage of PROMPTS) {
  const t0 = Date.now();
  const ctx = await runPipeline(userMessage, { sessionId: SESSION_ID });
  const ms = Date.now() - t0;

  // Mirror orchestrator.ts:2996-3014
  const { getCachedEEClientMode } = await import("../src/ee/client-mode.js");
  logInteraction(SESSION_ID, "pil", {
    eventSubtype: ctx.taskType ?? "none",
    durationMs: ms,
    data: {
      layers: ctx.layers?.filter((l) => l.applied).map((l) => l.name) ?? [],
      layerCount: ctx.layers?.length ?? 0,
      layerTimings: ctx.metrics?.layerTimings ?? null,
      domain: ctx.domain,
      confidence: ctx.confidence,
      outputStyle: ctx.outputStyle,
      fallbackReason: ctx.fallbackReason ?? null,
      eeMode: getCachedEEClientMode()?.mode ?? "unknown",
    },
  });
  logInteraction(SESSION_ID, "user_message", {
    data: {
      raw_length: userMessage.length,
      enriched_length: ctx.enriched.length,
      taskType: ctx.taskType,
      confidence: ctx.confidence,
      pilActive: ctx.taskType !== null,
    },
  });
}

console.log(`session_id = ${SESSION_ID}\n`);

console.log("─── pil rows ───");
const pilRows = db
  .prepare(
    "SELECT id, event_subtype, duration_ms, metadata_json, created_at FROM interaction_logs WHERE session_id = ? AND event_type = 'pil' ORDER BY id ASC",
  )
  .all(SESSION_ID) as Array<{ id: number; event_subtype: string; duration_ms: number; metadata_json: string; created_at: string }>;
for (const r of pilRows) {
  const meta = JSON.parse(r.metadata_json);
  console.log(`#${r.id} taskType=${r.event_subtype} dur=${r.duration_ms}ms`);
  console.log(`   layers(${meta.layerCount}) applied=[${meta.layers.join(", ")}]`);
  console.log(`   domain=${meta.domain} conf=${meta.confidence} style=${meta.outputStyle} fallback=${meta.fallbackReason ?? "—"}`);
}

console.log("\n─── user_message rows ───");
const umRows = db
  .prepare(
    "SELECT id, metadata_json FROM interaction_logs WHERE session_id = ? AND event_type = 'user_message' ORDER BY id ASC",
  )
  .all(SESSION_ID) as Array<{ id: number; metadata_json: string }>;
for (const r of umRows) {
  console.log(`#${r.id} ${r.metadata_json}`);
}

console.log("\n─── ee_injection rows ───");
const eeRows = db
  .prepare(
    "SELECT id, event_subtype, metadata_json FROM interaction_logs WHERE session_id = ? AND event_type = 'ee_injection' ORDER BY id ASC",
  )
  .all(SESSION_ID) as Array<{ id: number; event_subtype: string; metadata_json: string }>;
for (const r of eeRows) {
  console.log(`#${r.id} subtype=${r.event_subtype}  ${r.metadata_json}`);
}

console.log("\n─── all event types in this session ───");
const allEvents = db
  .prepare(
    "SELECT event_type, event_subtype, COUNT(*) as n FROM interaction_logs WHERE session_id = ? GROUP BY event_type, event_subtype",
  )
  .all(SESSION_ID) as Array<{ event_type: string; event_subtype: string; n: number }>;
for (const e of allEvents) console.log(`  ${e.event_type}/${e.event_subtype ?? "—"}: ${e.n}`);
