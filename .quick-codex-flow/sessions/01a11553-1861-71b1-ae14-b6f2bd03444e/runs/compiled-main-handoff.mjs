import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-compiled-main-"));
const previousCwd = process.cwd();
const previousEnv = Object.fromEntries(
  ["HOME", "USERPROFILE", "MUONROI_FORCE_ROUTING_CLASSIFY", "MUONROI_EE_BASE_URL"].map((key) => [
    key,
    process.env[key],
  ]),
);
let handle;
let closeDatabase;
try {
  process.chdir(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MUONROI_FORCE_ROUTING_CLASSIFY = "1";
  process.env.MUONROI_EE_BASE_URL = "http://127.0.0.1:1";
  await fs.mkdir(path.join(home, ".muonroi-cli"));
  await fs.writeFile(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: true }));
  const { Agent } = await import("../../../../dist/src/orchestrator/orchestrator.js");
  const { installMockModel, textOnlyStream } = await import("../../../../dist/src/agent-harness/mock-model.js");
  const { loadCatalog } = await import("../../../../dist/src/models/registry.js");
  const dbModule = await import("../../../../dist/src/storage/db.js");
  closeDatabase = dbModule.closeDatabase;
  await loadCatalog();
  handle = installMockModel({
    fixture: {
      autoClassify: true,
      stream: [
        textOnlyStream("SPAWN_SUB_SESSION,0.98,controlled runtime handoff"),
        textOnlyStream("HELPER_EVIDENCE: two plus two equals four."),
        textOnlyStream("MAIN_FINAL: verified answer is four."),
      ],
    },
  });
  const agent = new Agent("test-key", undefined, "deepseek-v4-flash", 2, { persistSession: true });
  const parentId = agent.getSessionId();
  const chunks = [];
  for await (const chunk of agent.processMessage("What is the sum of two and two?")) chunks.push(chunk);
  const output = chunks
    .filter((chunk) => chunk.type === "content")
    .map((chunk) => chunk.content ?? "")
    .join("");
  const db = dbModule.getDatabase();
  const parent = db.prepare("SELECT message_json FROM messages WHERE session_id = ?").all(parentId);
  const child = db
    .prepare("SELECT id, kind, parent_session_id FROM sessions WHERE parent_session_id = ?")
    .all(parentId);
  let requestedBackgroundRounds;
  agent.delegations.start = async (_request, options) => {
    requestedBackgroundRounds = options.maxToolRounds;
    return { success: true, output: "Isolated manager budget probe; no worker spawned." };
  };
  await agent.runDelegation({
    agent: "explore",
    description: "budget propagation probe",
    prompt: "probe",
    maxToolRounds: 60,
  });
  const report = {
    runtime: typeof Bun === "undefined" ? "node" : "bun",
    parentId,
    restoredParentId: agent.getSessionId(),
    output,
    child,
    parentHasReceipt: JSON.stringify(parent).includes("Helper receipt"),
    parentHasMainAnswer: JSON.stringify(parent).includes("MAIN_FINAL"),
    contentIsMainOnly: output.includes("MAIN_FINAL") && !output.includes("HELPER_EVIDENCE"),
    modelCalls: handle.calls.length,
    requestedBackgroundRounds,
  };
  await fs.writeFile(
    new URL(process.argv[2] ?? "./compiled-main-handoff.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (
    !report.contentIsMainOnly ||
    !report.parentHasReceipt ||
    !report.parentHasMainAnswer ||
    report.child.length !== 1 ||
    report.parentId !== report.restoredParentId ||
    report.requestedBackgroundRounds !== 60
  )
    process.exitCode = 1;
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  handle?.uninstall();
  closeDatabase?.();
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith("muonroi-compiled-main-")) {
    console.error("Unexpected cleanup target; skipped removal");
    process.exitCode = 1;
  } else {
    await fs.rm(home, { recursive: true, force: true });
  }
}
