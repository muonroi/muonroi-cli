import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegationManager } from "../../../../src/orchestrator/delegations.ts";
import { BashTool } from "../../../../src/tools/bash.ts";
import { createBuiltinTools } from "../../../../src/tools/registry.ts";

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "muonroi-coordination-probe-"));
const base = path.basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, "-");
const project = `${base}-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`;
const dir = path.join(os.homedir(), ".muonroi-cli", "delegations", project);
const job = path.join(dir, "probe.json");
const managerA = new DelegationManager(() => cwd);
const managerB = new DelegationManager(() => cwd);
const report: Record<string, unknown> = {};
try {
  await fs.mkdir(dir, { recursive: true });
  const record = {
    id: "probe",
    agent: "explore",
    description: "synthetic control probe",
    prompt: "no provider calls",
    cwd,
    model: "probe-only",
    sandboxMode: "off",
    maxToolRounds: 2,
    maxTokens: 100,
    status: "running",
    startedAt: "2020-01-01T00:00:00.000Z",
    pid: 2147483000,
    outputPath: path.join(dir, "probe.md"),
  };
  await fs.writeFile(job, JSON.stringify(record));
  try {
    process.kill(record.pid, 0);
    report.syntheticPidExists = true;
  } catch (err) {
    report.syntheticPidExists = false;
    report.pidCheckError = (err as Error).message;
  }
  report.deadPidListed = (await managerA.list())[0];
  await fs.writeFile(job, JSON.stringify({ ...record, status: "complete", summary: "synthetic complete" }));
  report.otherManagerNotifications = await managerB.consumeNotifications();
  report.originalManagerNotifications = await managerA.consumeNotifications();

  const bash = new BashTool(cwd);
  const routed: string[] = [];
  const tools = createBuiltinTools(bash, "agent", {
    runTask: async () => {
      routed.push("foreground");
      return { success: true, output: "foreground stub" };
    },
    runDelegation: async (request) => {
      routed.push("background");
      return managerA.start(request, { model: "probe-only", sandboxMode: "off", maxToolRounds: 2, maxTokens: 100 });
    },
  });
  report.longGeneralRoute = await tools.task.execute!(
    { agent: "general", description: "probe", prompt: "probe", maxToolRounds: 26 },
    {} as any,
  );
  report.routed = routed;
  await bash.cleanup();
  await fs.writeFile(new URL("./delegation-control-probe.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Both paths were allocated solely by this probe; do not touch existing delegation records.
  if (
    path.dirname(dir) !== path.join(os.homedir(), ".muonroi-cli", "delegations") ||
    !project.startsWith("muonroi-coordination-probe-")
  ) {
    console.error("Unexpected cleanup target; skipped removal");
    process.exitCode = 1;
  } else {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
