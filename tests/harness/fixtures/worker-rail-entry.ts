// Resume two durable workers and a plan council without contacting providers or starting processes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../../src/storage/sessions.js";
import { appendMessages } from "../../../src/storage/transcript.js";
import { formatDelegationStarted } from "../../../src/utils/background-jobs.js";

const fixtureHome = process.env.MUONROI_WORKER_RAIL_HOME;
if (!fixtureHome || process.env.HOME !== fixtureHome || process.env.USERPROFILE !== fixtureHome) {
  throw new Error("worker rail fixture requires an isolated HOME and USERPROFILE");
}
const jobsDir = join(fixtureHome, ".muonroi-cli", "delegations", "rail-fixture");
mkdirSync(jobsDir, { recursive: true });
const session = new SessionStore(process.cwd()).createSession("deepseek-v4-flash", "agent", process.cwd());
const jobs = [
  {
    id: "steady-amber-fox",
    agent: "explore",
    toolName: "delegate",
    description: "Repo survey",
    prompt: "Inspect existing library resources.",
  },
  {
    id: "clever-silver-panda",
    agent: "explore",
    toolName: "delegate",
    description: "Docs survey",
    prompt: "Inspect documentation coverage.",
  },
  {
    id: "keen-emerald-badger",
    agent: "council",
    toolName: "flow_plan_review",
    description: "Flow plan review",
    prompt: "Review the current plan.",
  },
];
const outputFor = (job: (typeof jobs)[number]) =>
  job.agent === "council"
    ? JSON.stringify({
        ok: true,
        pending: true,
        receipt: {
          success: true,
          output: formatDelegationStarted(job.id),
          delegation: { id: job.id, agent: job.agent, description: job.description, status: "running" },
        },
      })
    : formatDelegationStarted(job.id);
appendMessages(session.id, [
  { role: "user", content: "Survey repository and documentation with two workers." },
  {
    role: "assistant",
    content: jobs.map((job) => ({
      type: "tool-call",
      toolCallId: job.id,
      toolName: job.toolName,
      input: job.agent === "council" ? {} : { agent: job.agent, description: job.description, prompt: job.prompt },
    })),
  },
  {
    role: "tool",
    content: jobs.map((job) => ({
      type: "tool-result",
      toolCallId: job.id,
      toolName: job.toolName,
      output: { type: "json", value: { success: true, output: outputFor(job) } },
    })),
  },
  { role: "assistant", content: "Two workers are surveying the repository." },
]);
for (const job of jobs) {
  writeFileSync(
    join(jobsDir, `${job.id}.json`),
    JSON.stringify({
      ...job,
      kind: job.agent === "council" ? "council" : undefined,
      model: session.model,
      cwd: process.cwd(),
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      parentSessionId: session.id,
      outputPath: join(jobsDir, `${job.id}.md`),
    }),
  );
}
process.argv.push("--session", session.id);
await import("../../../src/index.ts");
