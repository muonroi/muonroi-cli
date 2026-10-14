const D = require("better-sqlite3");
const db = new D(require("os").homedir() + "/.muonroi-cli/muonroi.db", { readonly: true });
db.pragma("query_only = ON");
const args = process.argv.slice(2);
if (args[0] === "schema") {
  for (const t of ["sessions", "messages", "interaction_logs", "usage_events", "tool_calls", "tool_results"]) {
    console.log(t, JSON.stringify(db.prepare("pragma table_info(" + t + ")").all()));
  }
} else {
  const rows = db.prepare(args[0]).all(...args.slice(1));
  console.log(JSON.stringify(rows, null, 2));
}
db.close();
