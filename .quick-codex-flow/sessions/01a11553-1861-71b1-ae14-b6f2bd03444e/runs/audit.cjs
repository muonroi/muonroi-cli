const D = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const db = new D(require("os").homedir() + "/.muonroi-cli/muonroi.db", { readonly: true });
db.pragma("query_only = ON");
const end = "2026-10-07T07:46:02.335Z";
const start = new Date(Date.parse(end) - 7 * 86400000).toISOString();
const sid = "cde402aafc74";
const all = (sql, ...p) => db.prepare(sql).all(...p);
const report = db.transaction(() => {
  const tree = all(
    `WITH RECURSIVE tree(id) AS (SELECT id FROM sessions WHERE id=? UNION ALL SELECT s.id FROM sessions s JOIN tree t ON s.parent_session_id=t.id) SELECT s.* FROM sessions s JOIN tree t ON t.id=s.id`,
    sid,
  );
  const ids = tree.map((x) => x.id),
    slots = ids.map(() => "?").join(",");
  return {
    window: { start, end },
    counts: {
      createdSessions: all("SELECT count(*) AS n FROM sessions WHERE created_at>=? AND created_at<?", start, end),
      activeInteractionSessions: all(
        "SELECT count(DISTINCT session_id) AS n FROM interaction_logs WHERE created_at>=? AND created_at<?",
        start,
        end,
      ),
      eventTypes: all(
        "SELECT event_type,count(*) AS n FROM interaction_logs WHERE created_at>=? AND created_at<? GROUP BY event_type ORDER BY n DESC",
        start,
        end,
      ),
      tools: all("SELECT count(*) AS n FROM tool_calls WHERE started_at>=? AND started_at<?", start, end),
      usage: all("SELECT count(*) AS n FROM usage_events WHERE created_at>=? AND created_at<?", start, end),
    },
    accounting: all(
      `SELECT event_subtype stage,count(*) calls,round(avg(input_tokens)) avg_est,max(input_tokens) peak_est,sum(input_tokens) total_est,
      sum(json_extract(metadata_json,'$.throwHit')=1) throw_hits,sum(json_extract(metadata_json,'$.ceilingHit')=1) warn_hits,
      round(100.0*sum(json_extract(metadata_json,'$.bySegment.system'))/sum(json_extract(metadata_json,'$.chars')),1) sys_pct,
      round(100.0*sum(json_extract(metadata_json,'$.bySegment.history'))/sum(json_extract(metadata_json,'$.chars')),1) hist_pct,
      round(100.0*sum(json_extract(metadata_json,'$.bySegment.toolResults'))/sum(json_extract(metadata_json,'$.chars')),1) tool_pct
      FROM interaction_logs WHERE event_type='call_accounting' AND created_at>=? AND created_at<? GROUP BY event_subtype ORDER BY peak_est DESC`,
      start,
      end,
    ),
    highCalls: all(
      `SELECT id,session_id,created_at,event_subtype,input_tokens,metadata_json FROM interaction_logs WHERE event_type='call_accounting' AND created_at>=? AND created_at<? AND (input_tokens>60000 OR json_extract(metadata_json,'$.throwHit')=1) ORDER BY input_tokens DESC LIMIT 12`,
      start,
      end,
    ),
    errors: all(
      `SELECT * FROM interaction_logs WHERE event_type IN ('error','stall_rescue','grounding_flag') AND created_at>=? AND created_at<? ORDER BY created_at`,
      start,
      end,
    ),
    actualUsage: all(
      `SELECT source,count(*) calls,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,max(input_tokens) peak_input,sum(cost_micros)/1000000.0 recorded_cost FROM usage_events WHERE created_at>=? AND created_at<? GROUP BY source ORDER BY recorded_cost DESC`,
      start,
      end,
    ),
    tree,
    sessionEvents: all(`SELECT * FROM interaction_logs WHERE session_id IN (${slots}) ORDER BY created_at,id`, ...ids),
    sessionMessages: all(
      `SELECT session_id,seq,role,status,created_at,length(message_json) chars,substr(message_json,1,1000) excerpt FROM messages WHERE session_id IN (${slots}) ORDER BY created_at,seq`,
      ...ids,
    ),
    sessionTools: all(
      `SELECT t.id,t.session_id,t.message_seq,t.tool_name,t.status,t.started_at,t.completed_at,length(r.output_json) output_chars,r.success FROM tool_calls t LEFT JOIN tool_results r ON r.tool_call_row_id=t.id WHERE t.session_id IN (${slots}) ORDER BY t.started_at`,
      ...ids,
    ),
    sessionUsage: all(`SELECT * FROM usage_events WHERE session_id IN (${slots}) ORDER BY created_at`, ...ids),
  };
})();
db.close();
fs.writeFileSync(path.join(__dirname, "snapshot.json"), JSON.stringify(report, null, 2));
for (const key of [
  "window",
  "counts",
  "accounting",
  "highCalls",
  "errors",
  "actualUsage",
  "tree",
  "sessionMessages",
  "sessionTools",
  "sessionUsage",
])
  console.log(key, JSON.stringify(report[key], null, 2));
console.log(
  "sessionEvents",
  JSON.stringify(
    report.sessionEvents.filter((x) => x.session_id === sid),
    null,
    2,
  ),
);
