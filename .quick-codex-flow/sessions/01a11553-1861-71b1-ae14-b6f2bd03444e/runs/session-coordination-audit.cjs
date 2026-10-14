const D = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = new D(path.join(os.homedir(), ".muonroi-cli", "muonroi.db"), { readonly: true });
db.pragma("query_only = ON");
const end = new Date().toISOString();
const start = new Date(Date.parse(end) - 7 * 86400000).toISOString();
const all = (sql, ...args) => db.prepare(sql).all(...args);
const report = db.transaction(() => ({
  window: { start, end },
  sessions: all(
    `SELECT kind,status,count(*) n FROM sessions WHERE created_at>=? AND created_at<? GROUP BY kind,status`,
    start,
    end,
  ),
  parents: all(
    `SELECT parent_session_id,kind,status,count(*) children FROM sessions WHERE created_at>=? AND created_at<? AND parent_session_id IS NOT NULL GROUP BY parent_session_id,kind,status ORDER BY children DESC`,
    start,
    end,
  ),
  rootTree: all(
    `WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM sessions WHERE id=? UNION ALL SELECT s.id,t.depth+1 FROM sessions s JOIN tree t ON s.parent_session_id=t.id)
    SELECT s.id,s.parent_session_id,s.root_session_id,s.kind,s.status,s.model,s.created_at,s.updated_at,t.depth,
    (SELECT count(*) FROM messages m WHERE m.session_id=s.id) messages,
    (SELECT count(*) FROM tool_calls c WHERE c.session_id=s.id) tools,
    (SELECT count(*) FROM interaction_logs l WHERE l.session_id=s.id AND l.event_type='error') errors
    FROM sessions s JOIN tree t ON s.id=t.id ORDER BY s.created_at`,
    "cde402aafc74",
  ),
  coordinationTools: all(
    `SELECT tool_name,status,count(*) n FROM tool_calls WHERE started_at>=? AND started_at<? AND tool_name IN ('task','delegate','delegation_list','delegation_read','delegation_kill','consult_parent_session') GROUP BY tool_name,status ORDER BY tool_name`,
    start,
    end,
  ),
  subagentAccounting: all(
    `SELECT session_id,count(*) calls,max(input_tokens) peak_est FROM interaction_logs WHERE event_type='call_accounting' AND event_subtype='subagent' AND created_at>=? AND created_at<? GROUP BY session_id ORDER BY calls DESC LIMIT 8`,
    start,
    end,
  ),
}))();
db.close();
const root = path.join(os.homedir(), ".muonroi-cli", "delegations");
report.delegations = [];
if (fs.existsSync(root))
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, dir.name)).filter((x) => x.endsWith(".json"))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(root, dir.name, name), "utf8"));
        let pidExists = null;
        if (r.pid) {
          try {
            process.kill(r.pid, 0);
            pidExists = true;
          } catch {
            pidExists = false;
          }
        }
        report.delegations.push({
          id: r.id,
          project: dir.name,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          pid: r.pid,
          pidExists,
          parentSessionId: r.parentSessionId ?? r.parent_session_id ?? null,
          notified: !!r.notifiedAt,
        });
      } catch (err) {
        console.error(`Invalid delegation record ${dir.name}/${name}: ${err.message}`);
      }
    }
  }
fs.writeFileSync(path.join(__dirname, "session-coordination-data.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
