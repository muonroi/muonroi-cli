// 7-day usage report for muonroi-cli
// Run: node scripts/_query-usage.cjs  (from project dir so better-sqlite3 resolves)
const dbPath =
  process.platform === "win32"
    ? "C:\\Users\\phila\\.muonroi-cli\\muonroi.db"
    : "/c/Users/phila/.muonroi-cli/muonroi.db";

const db = require("better-sqlite3")(dbPath);
const { stringify } = JSON;

function q(label, sql, params) {
  try {
    const rows = db.prepare(sql).all(params || []);
    console.log(`\n=== ${label} ===`);
    console.log(stringify(rows, null, 2));
  } catch (e) {
    console.error(`[${label}] ERROR:`, e.message);
  }
}

const since = "date('now','-7 days')";

// Q1: Event type breakdown per day
q(
  "Q1: Event types per day",
  `SELECT DATE(created_at) AS day, event_type,
          COUNT(*) AS cnt,
          SUM(input_tokens) AS est_tok,
          MAX(input_tokens) AS peak_est
   FROM interaction_logs
   WHERE created_at >= ${since}
   GROUP BY DATE(created_at), event_type
   ORDER BY day, cnt DESC`,
);

// Q2: Model breakdown per day
q(
  "Q2: Model usage per day",
  `SELECT DATE(created_at) AS day, model,
          COUNT(*) AS cnt,
          SUM(input_tokens) AS in_tok,
          SUM(output_tokens) AS out_tok,
          MAX(input_tokens) AS peak_in
   FROM usage_events
   WHERE created_at >= ${since}
   GROUP BY DATE(created_at), model
   ORDER BY day, cnt DESC`,
);

// Q3: Cost by pipeline stage
q(
  "Q3: Cost by stage (call_accounting)",
  `SELECT DATE(created_at) AS day,
          event_subtype AS stage,
          COUNT(*) AS calls,
          SUM(input_tokens) AS est_tok,
          MAX(input_tokens) AS peak_est,
          ROUND(AVG(CAST(json_extract(metadata_json, '$.bySegment.system')
            AS REAL) / NULLIF(CAST(json_extract(metadata_json, '$.chars') AS REAL),0)*100),1) AS sys_pct,
          ROUND(AVG(CAST(json_extract(metadata_json, '$.bySegment.history')
            AS REAL) / NULLIF(CAST(json_extract(metadata_json, '$.chars') AS REAL),0)*100),1) AS hist_pct,
          ROUND(AVG(CAST(json_extract(metadata_json, '$.bySegment.toolResults')
            AS REAL) / NULLIF(CAST(json_extract(metadata_json, '$.chars') AS REAL),0)*100),1) AS tool_pct
   FROM interaction_logs
   WHERE event_type = 'call_accounting' AND created_at >= ${since}
   GROUP BY DATE(created_at), event_subtype
   ORDER BY day, est_tok DESC`,
);

// Q4: 7-day overall totals
const totals = db
  .prepare(`SELECT
    COUNT(DISTINCT DATE(created_at)) AS active_days,
    COUNT(DISTINCT model) AS models_used,
    SUM(input_tokens) AS total_est_in,
    SUM(output_tokens) AS total_est_out,
    SUM(cost_micros) AS total_cost_micros,
    COUNT(*) AS total_calls
  FROM usage_events
  WHERE created_at >= ${since}`)
  .get();
console.log("\n=== Q4: 7-day overall totals ===");
console.log(stringify(totals, null, 2));

// Q5: Daily sessions & events
q(
  "Q5: Daily sessions & events",
  `SELECT DATE(created_at) AS day, source AS src,
          COUNT(DISTINCT session_id) AS sessions,
          COUNT(*) AS events
   FROM usage_events
   WHERE created_at >= ${since}
   GROUP BY DATE(created_at), source
   ORDER BY day, sessions DESC`,
);

// Q6: Cache hit ratio
q(
  "Q6: Cache hit ratio by model",
  `SELECT DATE(created_at) AS day, model,
          SUM(cache_read_tokens) AS cache_read_tok,
          SUM(cache_creation_tokens) AS cache_creation_tok,
          SUM(input_tokens) AS prompt_tok,
          COUNT(*) AS calls,
          ROUND(100.0 * SUM(cache_read_tokens)
            / NULLIF(SUM(cache_read_tokens + cache_creation_tokens + input_tokens),0), 1) AS cache_pct
   FROM usage_events
   WHERE created_at >= ${since}
   GROUP BY DATE(created_at), model
   ORDER BY day, calls DESC`,
);

// Q7: Decision log types
q(
  "Q7: Decision log by type",
  `SELECT DATE(created_at) AS day, decision_type, COUNT(*) AS cnt
   FROM decision_logs
   WHERE created_at >= ${since}
   GROUP BY DATE(created_at), decision_type
   ORDER BY day, cnt DESC`,
);

// Q8: Error outcomes
q(
  "Q8: Non-success outcomes",
  `SELECT DATE(created_at) AS day, event_type, outcome, COUNT(*) AS cnt
   FROM interaction_logs
   WHERE created_at >= ${since}
     AND outcome IS NOT NULL AND outcome != 'success'
   GROUP BY DATE(created_at), event_type, outcome
   ORDER BY day, cnt DESC
   LIMIT 40`,
);

// Q9: Top expensive single calls
q(
  "Q9: Top 10 most expensive single calls",
  `SELECT DATE(created_at) AS day, event_subtype AS stage, model,
          input_tokens AS est_in,
          output_tokens AS est_out,
          json_extract(metadata_json,'$.bySegment.system') AS sys_chars,
          json_extract(metadata_json,'$.bySegment.history') AS hist_chars,
          json_extract(metadata_json,'$.bySegment.toolResults') AS tool_chars
   FROM interaction_logs
   WHERE event_type = 'call_accounting'
     AND created_at >= ${since}
   ORDER BY input_tokens DESC
   LIMIT 10`,
);

// Q10: Per-model cost
q(
  "Q10: Cost by model (call_accounting)",
  `SELECT model,
          COUNT(*) AS calls,
          SUM(input_tokens) AS est_in,
          SUM(output_tokens) AS est_out,
          MAX(input_tokens) AS peak_est
   FROM interaction_logs
   WHERE event_type = 'call_accounting'
     AND created_at >= ${since}
   GROUP BY model
   ORDER BY est_in DESC`,
);

db.close();
