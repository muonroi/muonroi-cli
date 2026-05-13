import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_PATH = path.join(process.env.MUONROI_CLI_HOME ?? path.join(os.homedir(), ".muonroi-cli"), "pil-budget.log");

export async function appendPilLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fs.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // best-effort, never throw
  }
}
