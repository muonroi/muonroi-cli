// Resume a main session whose orchestrator has just dispatched one background
// worker (task tool-call + receipt in the transcript, running job record owned by
// this session). The spec then finishes the worker on disk; the TUI's own idle
// tick must deliver the completion and wake the orchestrator. No provider is
// contacted (--mock-llm) and no worker process is started.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../../src/storage/sessions.js";
import { appendMessages } from "../../../src/storage/transcript.js";
import { formatDelegationStarted } from "../../../src/utils/background-jobs.js";

const fixtureHome = process.env.MUONROI_INLINE_COMPLETION_HOME;
if (!fixtureHome || process.env.HOME !== fixtureHome || process.env.USERPROFILE !== fixtureHome) {
  throw new Error("inline completion fixture requires an isolated HOME and USERPROFILE");
}
const jobId = process.env.MUONROI_INLINE_COMPLETION_JOB ?? "brisk-teal-otter";
const jobsDir = join(fixtureHome, ".muonroi-cli", "delegations", "inline-fixture");
mkdirSync(jobsDir, { recursive: true });
const model = process.env.MUONROI_INLINE_COMPLETION_MODEL ?? "deepseek-v4-flash";
const session = new SessionStore(process.cwd()).createSession(model, "agent", process.cwd());
const task = {
  agent: "general",
  description: "Implement the parser",
  prompt: "role: implementer; scope: src/parser.ts; return: changed lines and test evidence.",
  writeScope: ["src/parser.ts"],
};
appendMessages(session.id, [
  { role: "user", content: "Implement the parser with a worker." },
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "dispatch-1", toolName: "task", input: task }],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "dispatch-1",
        toolName: "task",
        output: { type: "json", value: { success: true, output: formatDelegationStarted(jobId) } },
      },
    ],
  },
  { role: "assistant", content: "A worker is implementing the parser; I will continue when it reports." },
]);
writeFileSync(
  join(jobsDir, `${jobId}.json`),
  JSON.stringify({
    id: jobId,
    kind: "task",
    ...task,
    model,
    cwd: process.cwd(),
    sandboxMode: "off",
    maxToolRounds: 4,
    maxTokens: 1000,
    status: "running",
    // The TUI's own pid keeps reconcile() from declaring the job dead.
    pid: process.pid,
    startedAt: new Date().toISOString(),
    parentSessionId: session.id,
    outputPath: join(jobsDir, `${jobId}.md`),
  }),
);
writeFileSync(join(fixtureHome, "inline-session.json"), JSON.stringify({ sessionId: session.id, jobId, jobsDir }));
process.argv.push("--session", session.id);
await import("../../../src/index.ts");
