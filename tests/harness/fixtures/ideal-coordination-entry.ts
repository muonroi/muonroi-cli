// Boot the TUI on a known, empty main session so a spec can drop a running
// worker record owned by that session into the delegations store AFTER it has
// typed `/ideal start` (the run attributes jobs by start time). No provider is
// contacted (--mock-llm) and no worker is started by this entry.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../../src/storage/sessions.js";

const fixtureHome = process.env.MUONROI_IDEAL_COORD_HOME;
if (!fixtureHome || process.env.HOME !== fixtureHome || process.env.USERPROFILE !== fixtureHome) {
  throw new Error("ideal coordination fixture requires an isolated HOME and USERPROFILE");
}
const jobsDir = join(fixtureHome, ".muonroi-cli", "delegations", "ideal-coordination-fixture");
mkdirSync(jobsDir, { recursive: true });
const model = process.env.MUONROI_IDEAL_COORD_MODEL ?? "deepseek-v4-flash";
// MUONROI_IDEAL_COORD_RESUME=<session id> boots the SAME session again in a
// fresh process (a CLI restart / `--session` resume) instead of seeding a new one.
const resumeId = process.env.MUONROI_IDEAL_COORD_RESUME;
const sessionId = resumeId ?? new SessionStore(process.cwd()).createSession(model, "agent", process.cwd()).id;
writeFileSync(join(fixtureHome, "ideal-session.json"), JSON.stringify({ sessionId, jobsDir }));
process.argv.push("--session", sessionId);
await import("../../../src/index.ts");
