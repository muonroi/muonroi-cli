const path = "/c/Users/phila/.muonroi-cli/muonroi.db";
try {
  const { readFileSync } = await import("fs");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);

  // Q1: Per-day per-event_type breakdown
  const q1 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      event_type,
      COUNT(*) AS cnt,
      SUM(input_tokens) AS est_tok,
      MAX(input_tokens) AS peak_est
    FROM interaction_logs
    WHERE created_at >= date('now','-7 days')
    GROUP BY DATE(created_at), event_type
    ORDER BY day, event_type
  `)
    .all();
  console.log("=== Q1: Per-day event type breakdown ===");
  console.log(JSON.stringify(q1, null, 2));

  // Q2: Per-day per-model breakdown
  const q2 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      model_id,
      provider,
      COUNT(*) AS cnt,
      SUM(input_tokens) AS in_tok,
      SUM(output_tokens) AS out_tok,
      MAX(input_tokens) AS peak_in
    FROM usage_events
    WHERE created_at >= date('now','-7 days')
    GROUP BY DATE(created_at), model_id
    ORDER BY day, cnt DESC
  `)
    .all();
  console.log("\n=== Q2: Per-day model breakdown ===");
  console.log(JSON.stringify(q2, null, 2));

  // Q3: Cost attribution by stage (call_accounting)
  const q3 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      event_subtype AS stage,
      COUNT(*) AS calls,
      SUM(input_tokens) AS est_tok,
      MAX(input_tokens) AS peak_est,
      ROUND(AVG(CAST(json_extract(metadata_json, '$.bySegment.system') AS REAL) / NULLIF(CAST(json_extract(metadata_json, '$.chars') AS REAL), 0) * 100), 1) AS sys_pct,
      ROUND(AVG(CAST(json_extract(metadata_json, '$.bySegment.history') AS REAL) / NULLIF(CAST(json_extract(metadata_json, '$.chars') AS REAL), 0) * 100), 1) AS hist_pct,
      ROUND(AVG(CAST(json_extract(metadata_json, '$.bySegment.toolResults') AS REAL) / NULLIF(CAST(json_extract(metadata_json, '$.chars') AS REAL), 0) * 100), 1) AS tool_pct
    FROM interaction_logs
    WHERE event_type = 'call_accounting' AND created_at >= date('now','-7 days')
    GROUP BY DATE(created_at), event_subtype
    ORDER BY day, est_tok DESC
  `)
    .all();
  console.log("\n=== Q3: Cost by stage ===");
  console.log(JSON.stringify(q3, null, 2));

  // Q4: Overall totals
  const q4 = db
    .prepare(`
    SELECT 
      COUNT(DISTINCT DATE(created_at)) AS active_days,
      COUNT(DISTINCT model_id) AS models_used,
      SUM(input_tokens) AS total_est_in,
      SUM(output_tokens) AS total_est_out,
      COUNT(*) AS total_calls
    FROM usage_events
    WHERE created_at >= date('now','-7 days')
  `)
    .get();
  console.log("\n=== Q4: 7-day totals ===");
  console.log(JSON.stringify(q4, null, 2));

  // Q5: Session counts
  const q5 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      source AS src,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(*) AS events
    FROM usage_events
    WHERE created_at >= date('now','-7 days')
    GROUP BY DATE(created_at), source
    ORDER BY day, sessions DESC
  `)
    .all();
  console.log("\n=== Q5: Daily sessions by source ===");
  console.log(JSON.stringify(q5, null, 2));

  // Q6: Cache hit ratio
  const q6 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      model_id,
      provider,
      SUM(prompt_cache_hit_tokens) AS cache_hit_tok,
      SUM(COALESCE(prompt_cache_miss_tokens, prompt_tokens)) AS miss_tok,
      SUM(prompt_tokens) AS prompt_tok,
      COUNT(*) AS calls,
      ROUND(100.0 * SUM(prompt_cache_hit_tokens) / NULLIF(SUM(prompt_cache_hit_tokens + COALESCE(prompt_cache_miss_tokens, prompt_tokens)), 0), 1) AS cache_pct
    FROM usage_events
    WHERE created_at >= date('now','-7 days')
    GROUP BY DATE(created_at), model_id
    ORDER BY day, calls DESC
  `)
    .all();
  console.log("\n=== Q6: Cache hit ratio by model ===");
  console.log(JSON.stringify(q6, null, 2));

  // Q7: Decision log summary
  const q7 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      decision_type,
      COUNT(*) AS cnt
    FROM decision_logs
    WHERE created_at >= date('now','-7 days')
    GROUP BY DATE(created_at), decision_type
    ORDER BY day, cnt DESC
  `)
    .all();
  console.log("\n=== Q7: Decision log by type ===");
  console.log(JSON.stringify(q7, null, 2));

  // Q8: Error / failure rates
  const q8 = db
    .prepare(`
    SELECT 
      DATE(created_at) AS day,
      event_type,
      outcome,
      COUNT(*) AS cnt
    FROM interaction_logs
    WHERE created_at >= date('now','-7 days') AND outcome IS NOT NULL AND outcome != 'success'
    GROUP BY DATE(created_at), event_type, outcome
    ORDER BY day, cnt DESC
    LIMIT 40
  `)
    .all();
  console.log("\n=== Q8: Non-success outcomes ===");
  console.log(JSON.stringify(q8, null, 2));

  db.close();
} catch (e) {
  console.error("ERROR:", e.message);
}
