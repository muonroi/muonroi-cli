import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const base = new URL("../../../../dist/src/", import.meta.url);
const originalCwd = process.cwd();
const keys = [
  "HOME",
  "USERPROFILE",
  "MUONROI_FORCE_ROUTING_CLASSIFY",
  "MUONROI_EE_BASE_URL",
  "MUONROI_TURN_IDLE_MS",
  "MUONROI_TURN_PROGRESS_PING_INTERVAL_MS",
  "MUONROI_PROVIDER_STALL_TIMEOUT_MS",
];
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const report = { runtime: typeof Bun === "undefined" ? "node" : "bun", cases: [] };
// A real CLI renderer/socket keeps the process alive; this socket-free fixture must do so too.
const keepAlive = setInterval(() => {}, 1000);
let closeDatabase;
try {
  for (const scenario of ["slow", "retry", "unresponsive", "cancel"]) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-acceptance-runtime-"));
    let handle;
    try {
      process.chdir(home);
      Object.assign(process.env, {
        HOME: home,
        USERPROFILE: home,
        MUONROI_FORCE_ROUTING_CLASSIFY: "1",
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
        MUONROI_TURN_IDLE_MS: "1000",
        MUONROI_TURN_PROGRESS_PING_INTERVAL_MS: "50",
        MUONROI_PROVIDER_STALL_TIMEOUT_MS: "10000",
      });
      await fs.mkdir(path.join(home, ".muonroi-cli"));
      await fs.writeFile(path.join(home, ".muonroi-cli", "settings.json"), JSON.stringify({ routerSubSessions: true }));
      const { Agent } = await import(new URL("orchestrator/orchestrator.js", base));
      const { installMockModel, textOnlyStream } = await import(new URL("agent-harness/mock-model.js", base));
      const { loadCatalog } = await import(new URL("models/registry.js", base));
      const { createHeadlessJsonlEmitter } = await import(new URL("headless/output.js", base));
      const db = await import(new URL("storage/db.js", base));
      closeDatabase = db.closeDatabase;
      closeDatabase();
      await loadCatalog();
      handle = installMockModel({
        fixture: {
          autoClassify: true,
          stream: [
            textOnlyStream("SPAWN_SUB_SESSION,0.98,controlled runtime handoff"),
            textOnlyStream("HELPER_EVIDENCE"),
            textOnlyStream("MAIN_FINAL"),
          ],
        },
      });
      const original = handle.model.doStream.bind(handle.model);
      let mainCalls = 0;
      let agent;
      handle.model.doStream = async (options) => {
        if (JSON.stringify(options.prompt).includes("[Helper receipt:") && options.tools?.length) {
          mainCalls++;
          if (scenario === "slow") await new Promise((r) => setTimeout(r, 2500));
          if (scenario === "unresponsive" || (scenario === "retry" && mainCalls === 1))
            return await new Promise(() => {});
          if (scenario === "cancel") {
            setTimeout(() => agent.abort(), 50);
            return await new Promise(() => {});
          }
          return {
            stream: new ReadableStream({
              start(c) {
                for (const p of textOnlyStream("MAIN_FINAL")) c.enqueue(p);
                c.close();
              },
            }),
          };
        }
        return original(options);
      };
      agent = new Agent("test-key", undefined, "deepseek-v4-flash", 2, { persistSession: true });
      const parentId = agent.getSessionId();
      const started = Date.now();
      const chunks = [];
      const emitter = createHeadlessJsonlEmitter(parentId);
      let jsonOutput = "";
      for await (const c of agent.processMessage("What is the sum of two and two?", emitter.observer)) {
        chunks.push(c);
        jsonOutput += emitter.consumeChunk(c).stdout ?? "";
      }
      jsonOutput += emitter.flush().stdout ?? "";
      const content = chunks
        .filter((c) => c.type === "content")
        .map((c) => c.content ?? "")
        .join("");
      const errors = chunks
        .filter((c) => c.type === "error")
        .map((c) => c.content ?? "")
        .join("");
      const receipt = JSON.stringify(
        db.getDatabase().prepare("SELECT message_json FROM messages WHERE session_id=?").all(parentId),
      ).includes("Helper receipt");
      const passed =
        agent.getSessionId() === parentId &&
        agent.abortController === null &&
        receipt &&
        !errors.includes("Turn ended by watchdog") &&
        (scenario === "unresponsive"
          ? mainCalls === 2 && errors.includes("Model not responding")
          : scenario === "cancel"
            ? mainCalls === 1 && content.includes("Cancelled")
            : content.includes("MAIN_FINAL") && mainCalls === (scenario === "retry" ? 2 : 1));
      const jsonPassed = ["slow", "retry"].includes(scenario) ? jsonOutput.includes("MAIN_FINAL") : true;
      report.cases.push({
        scenario,
        passed: passed && jsonPassed,
        jsonPassed,
        elapsedMs: Date.now() - started,
        mainCalls,
        receipt,
        content,
        errors,
      });
      console.log(JSON.stringify(report.cases.at(-1)));
      if (!passed || !jsonPassed) process.exitCode = 1;
    } finally {
      handle?.uninstall();
      closeDatabase?.();
      process.chdir(originalCwd);
      if (path.dirname(home) !== os.tmpdir() || !path.basename(home).startsWith("muonroi-acceptance-runtime-")) {
        console.error("Unexpected cleanup target; skipped removal");
        process.exitCode = 1;
      } else {
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    }
  }
} catch (err) {
  report.error = err.message;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.writeFile(
    new URL(process.argv[2] ?? "./compiled-acceptance.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
}
