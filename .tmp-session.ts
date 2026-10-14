import { Database } from "bun:sqlite";

const db = new Database(process.env.USERPROFILE + "/.muonroi-cli/muonroi.db", { readonly: true });

console.log("=== Does session 526a83cf22df exist at all? ===");
for (const t of ["sessions", "messages"]) {
  try {
    const r = db.query(`SELECT COUNT(*) n FROM ${t} WHERE session_id LIKE '526a83cf22df%'`).get() as any;
    console.log(t, JSON.stringify(r));
  } catch (e) {
    console.log(t, "ERR", (e as Error).message);
  }
}
console.log("\n=== Oldest / newest call_accounting row (retention check) ===");
console.log(
  JSON.stringify(
    db
      .query(
        `SELECT MIN(created_at) oldest, MAX(created_at) newest, COUNT(*) n FROM interaction_logs WHERE event_type='call_accounting'`,
      )
      .get(),
  ),
);
console.log("\n=== interaction_logs retention config in settings? env? ===");
console.log(JSON.stringify(db.query(`SELECT COUNT(*) n FROM interaction_logs`).get()));
