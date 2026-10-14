import { Database } from "bun:sqlite";

const db = new Database(process.env.USERPROFILE + "/.muonroi-cli/muonroi.db", { readonly: true });

const j = (row: any, key: string) => {
  try {
    return JSON.parse(row.metadata_json ?? "{}")[key];
  } catch {
    return undefined;
  }
};

console.log("=== VIEW 1: per-stage cost + segment split ===");
const view1 = db
  .query(`
  SELECT event_subtype stage, COUNT(*) calls, SUM(input_tokens) est_tok, MAX(input_tokens) peak,
    SUM(json_extract(metadata_json,'$.bySegment.system')) sys_chars,
    SUM(json_extract(metadata_json,'$.bySegment.history')) hist_chars,
    SUM(json_extract(metadata_json,'$.bySegment.toolResults')) tool_chars,
    SUM(json_extract(metadata_json,'$.chars')) chars
  FROM interaction_logs WHERE event_type='call_accounting'
  GROUP BY event_subtype ORDER BY est_tok DESC`)
  .all();
for (const r of view1 as any[]) {
  const c = r.chars || 1;
  console.log(
    `${r.stage.padEnd(14)} calls=${String(r.calls).padStart(6)} est_tok=${String(r.est_tok).padStart(10)} peak=${String(r.peak).padStart(8)} ` +
      `sys%=${((100 * r.sys_chars) / c).toFixed(1).padStart(5)} hist%=${((100 * r.hist_chars) / c).toFixed(1).padStart(5)} tool%=${((100 * r.tool_chars) / c).toFixed(1).padStart(5)}`,
  );
}

console.log("\n=== VIEW 2: ceiling / throw hits ===");
const view2 = db
  .query(`
  SELECT event_subtype stage, COUNT(*) calls,
    SUM(json_extract(metadata_json,'$.ceilingHit')) warn_hits,
    SUM(CASE WHEN json_extract(metadata_json,'$.throwHit')=1 THEN 1 ELSE 0 END) throw_hits,
    MAX(input_tokens) peak_est
  FROM interaction_logs WHERE event_type='call_accounting' GROUP BY event_subtype`)
  .all();
for (const r of view2 as any[]) {
  console.log(
    `${r.stage.padEnd(14)} calls=${String(r.calls).padStart(6)} warn_hits=${String(r.warn_hits ?? 0).padStart(6)} throw_hits=${String(r.throw_hits ?? 0).padStart(4)} peak_est=${String(r.peak_est).padStart(8)}`,
  );
}

console.log("\n=== VIEW 3: single biggest call composition ===");
const row: any = db
  .query(`
  SELECT session_id, event_subtype, model, input_tokens, metadata_json, created_at
  FROM interaction_logs WHERE event_type='call_accounting' ORDER BY input_tokens DESC LIMIT 1`)
  .get();
console.log(JSON.stringify(row, null, 2));

console.log("\n=== Target session 526a83cf22df ===");
const ses = db
  .query(`
  SELECT COUNT(*) calls, SUM(input_tokens) est_tok, MAX(input_tokens) peak
  FROM interaction_logs WHERE event_type='call_accounting' AND session_id LIKE '526a83cf22df%'`)
  .get();
console.log(JSON.stringify(ses));
const sesByStage = db
  .query(`
  SELECT event_subtype stage, COUNT(*) calls, SUM(input_tokens) est_tok, MAX(input_tokens) peak,
    SUM(CASE WHEN json_extract(metadata_json,'$.throwHit')=1 THEN 1 ELSE 0 END) throw_hits
  FROM interaction_logs WHERE event_type='call_accounting' AND session_id LIKE '526a83cf22df%'
  GROUP BY event_subtype`)
  .all();
console.log(JSON.stringify(sesByStage, null, 1));

console.log("\n=== Recent sessions (last 3 days) by stage ===");
const recent = db
  .query(`
  SELECT event_subtype stage, COUNT(*) calls, SUM(input_tokens) est_tok, MAX(input_tokens) peak,
    SUM(CASE WHEN json_extract(metadata_json,'$.throwHit')=1 THEN 1 ELSE 0 END) throw_hits
  FROM interaction_logs WHERE event_type='call_accounting' AND created_at >= datetime('now','-3 days')
  GROUP BY event_subtype ORDER BY est_tok DESC`)
  .all();
console.log(JSON.stringify(recent, null, 1));

console.log("\n=== Global throw_hits total ===");
const th = db
  .query(`
  SELECT COUNT(*) total, SUM(CASE WHEN json_extract(metadata_json,'$.throwHit')=1 THEN 1 ELSE 0 END) throws,
    SUM(json_extract(metadata_json,'$.ceilingHit')) warn_total
  FROM interaction_logs WHERE event_type='call_accounting'`)
  .get();
console.log(JSON.stringify(th));

console.log("\n=== Unattributed share (meter coverage) ===");
const unatt = db
  .query(`
  SELECT COUNT(*) total, SUM(CASE WHEN event_subtype='unattributed' THEN 1 ELSE 0 END) unattributed
  FROM interaction_logs WHERE event_type='call_accounting'`)
  .get();
console.log(JSON.stringify(unatt));
