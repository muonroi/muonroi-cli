const D = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");
const d = new D(path.join(require("node:os").homedir(), ".muonroi-cli", "muonroi.db"), { readonly: true });
d.pragma("query_only=ON");
const ids = ["0a64c9560662", "63031454205e"];
const schema = Object.fromEntries(
  ["interaction_logs", "messages", "tool_calls"].map((t) => [t, d.prepare("PRAGMA table_info(" + t + ")").all()]),
);
const rows = Object.fromEntries(
  ["sessions", "interaction_logs", "messages", "tool_calls"].map((t) => [
    t,
    d.prepare("SELECT * FROM " + t + " WHERE " + (t === "sessions" ? "id" : "session_id") + " IN (?,?)").all(...ids),
  ]),
);
fs.writeFileSync(path.join(__dirname, "acceptance-audit.json"), JSON.stringify({ schema, rows }, null, 2));
console.log(JSON.stringify(schema));
console.log("counts", Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])));
for (const r of rows.interaction_logs.filter((r) => r.session_id === ids[0]))
  console.log(JSON.stringify(r).slice(0, 2400));
d.close();
