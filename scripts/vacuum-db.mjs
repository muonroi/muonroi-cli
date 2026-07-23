import { Database } from "bun:sqlite";

const dbPath = process.argv[2] || "/c/Users/phila/.muonroi-cli/muonroi.db";
const db = new Database(dbPath);
db.exec("VACUUM;");
db.close();
console.log("VACUUM done for", dbPath);
