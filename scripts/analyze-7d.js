const Database = require("better-sqlite3");
const db = new Database(require("os").homedir() + "/.muonroi-cli/muonroi.db");

const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

// 1. Session count past 7d
const sessions = db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE created_at >= ?").get(weekAgo);
console.log("=== Sessions (7d):", sessions.cnt, "===");

// 2. Call accounting summary by stage
const callAcc = db
  .prepare(`
  SELECT event_subtype as stage,
    COUNT(*) as calls,
    ROUND(AVG(input_tokens),0) as avg_est,
    MAX(input_tokens) as peak_est,
    SUM(CASE WHEN json_extract(metadata_json, '$.throwHit') = 1 THEN 1 ELSE 0 END) as throw_hits,
    SUM(CASE WHEN json_extract(metadata_json, '$.ceilingHit') = 1 THEN 1 ELSE 0 END) as warn_hits,
    ROUND(100.0*SUM(json_extract(metadata_json, '$.bySegment.system'))/SUM(json_extract(metadata_json, '$.chars')),1) as sys_pct,
    ROUND(100.0*SUM(json_extract(metadata_json, '$.bySegment.history'))/SUM(json_extract(metadata_json, '$.chars')),1) as hist_pct,
    ROUND(100.0*SUM(json_extract(metadata_json, '$.bySegment.toolResults'))/SUM(json_extract(metadata_json, '$.chars')),1) as tool_pct
  FROM interaction_logs
  WHERE event_type = 'call_accounting' AND created_at >= ?
  GROUP BY event_subtype
  ORDER BY peak_est DESC
`)
  .all(weekAgo);
console.log("\n=== Call Accounting by Stage (7d) ===");
console.log(JSON.stringify(callAcc, null, 2));

// 3. Top 5 highest-token calls
const topCalls = db
  .prepare(`
  SELECT id, created_at, event_subtype as stage, input_tokens as est,
    json_extract(metadata_json, '$.bySegment.system') as sys_chars,
    json_extract(metadata_json, '$.bySegment.history') as hist_chars,
    json_extract(metadata_json, '$.bySegment.toolResults') as tool_chars,
    json_extract(metadata_json, '$.ceilingMode') as ceiling_mode,
    json_extract(metadata_json, '$.ceiling') as ceiling,
    json_extract(metadata_json, '$.throwCeiling') as throw_ceiling
  FROM interaction_logs
  WHERE event_type = 'call_accounting' AND input_tokens > 60000 AND created_at >= ?
  ORDER BY input_tokens DESC LIMIT 5
`)
  .all(weekAgo);
console.log("\n=== Top 5 High-Token Calls (>60k est, 7d) ===");
console.log(JSON.stringify(topCalls, null, 2));

// 4. Throw-hit details (runaway calls)
const throwHits = db
  .prepare(`
  SELECT id, created_at, event_subtype as stage, input_tokens as est,
    json_extract(metadata_json, '$.bySegment.system') as sys_chars,
    json_extract(metadata_json, '$.bySegment.toolResults') as tool_chars,
    json_extract(metadata_json, '$.stage') as stage_field
  FROM interaction_logs
  WHERE event_type = 'call_accounting' AND json_extract(metadata_json, '$.throwHit') = 1 AND created_at >= ?
  ORDER BY input_tokens DESC LIMIT 5
`)
  .all(weekAgo);
console.log("\n=== Throw-Hit Calls (7d) ===");
console.log(JSON.stringify(throwHits, null, 2));

// 5. Error events
const errors = db
  .prepare(`
  SELECT id, created_at, event_subtype, input_tokens, 
    json_extract(metadata_json, '$.error') as err_msg,
    json_extract(metadata_json, '$.stage') as stage
  FROM interaction_logs
  WHERE event_type = 'error' AND created_at >= ?
  ORDER BY created_at DESC LIMIT 10
`)
  .all(weekAgo);
console.log("\n=== Error Events (7d) ===");
console.log(JSON.stringify(errors, null, 2));

// 6. Stalled turns
const stalls = db
  .prepare(`
  SELECT id, created_at, event_subtype,
    json_extract(metadata_json, '$.kind') as stall_kind,
    json_extract(metadata_json, '$.message') as stall_msg
  FROM interaction_logs
  WHERE event_type = 'stall_rescue' AND created_at >= ?
  ORDER BY created_at DESC LIMIT 10
`)
  .all(weekAgo);
console.log("\n=== Stall Rescues (7d) ===");
console.log(JSON.stringify(stalls, null, 2));

// 7. Grounding flags
const grounding = db
  .prepare(`
  SELECT id, created_at, event_subtype,
    json_extract(metadata_json, '$.verdict') as verdict,
    json_extract(metadata_json, '$.reasons') as reasons
  FROM interaction_logs
  WHERE event_type = 'grounding_flag' AND created_at >= ?
  ORDER BY created_at DESC LIMIT 10
`)
  .all(weekAgo);
console.log("\n=== Grounding Flags (7d) ===");
console.log(JSON.stringify(grounding, null, 2));

// 8. Overall cost by stage
const stageCost = db
  .prepare(`
  SELECT event_subtype as stage, COUNT(*) as calls, SUM(input_tokens) as total_est, AVG(input_tokens) as avg_est, MAX(input_tokens) as peak_est
  FROM interaction_logs
  WHERE event_type = 'call_accounting' AND created_at >= ?
  GROUP BY event_subtype
  ORDER BY total_est DESC
`)
  .all(weekAgo);
console.log("\n=== Cost by Stage (7d) ===");
console.log(JSON.stringify(stageCost, null, 2));
