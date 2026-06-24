import { Database } from "bun:sqlite";

const db = new Database(`${process.env.USERPROFILE}/.muonroi-cli/muonroi.db`);

// Get tables
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("Tables:", tables.map((t) => t.name).join(", "));

// Get session tool calls
const sessionId = "0d26affb24eb";
const calls = db
  .query(`
  SELECT id, tool_name, created_at, status
  FROM tool_calls
  WHERE session_id = ?
  ORDER BY id
`)
  .all(sessionId);
console.log(JSON.stringify(calls, null, 2));

// Count by tool
const counts = db
  .query(`
  SELECT tool_name, COUNT(*) as cnt
  FROM tool_calls
  WHERE session_id = ?
  GROUP BY tool_name
  ORDER BY cnt DESC
`)
  .all(sessionId);
console.log("Counts:", JSON.stringify(counts, null, 2));

db.close();
