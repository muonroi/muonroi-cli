import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const output = new URL(process.argv[2] ?? "./local-selfverify-result.json", import.meta.url);
const client = new Client({ name: "pil-repair-verification", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "bun",
  args: ["dist/src/index.js", "tools-mcp"],
  cwd: process.cwd(),
  env: { ...process.env, MUONROI_INTERNAL_SHIM_OK: "1" },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-8000);
});
const report = { workspace: process.cwd(), startedAt: new Date().toISOString() };
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const data = JSON.parse(result.content.find((item) => item.type === "text").text);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
  return data;
};
try {
  await client.connect(transport);
  report.start = await call("selfverify_start", { mode: "tier1", since: "HEAD", max: 2, emit: false });
  console.log(JSON.stringify(report.start));
  const deadline = Date.now() + 240000;
  do {
    await delay(1000);
    report.status = await call("selfverify_status", { runId: report.start.runId });
  } while (report.status.status === "running" && Date.now() < deadline);
  if (report.status.status === "running") {
    await call("selfverify_cancel", { runId: report.start.runId });
    throw new Error("Local native selfverify exceeded 240s verification budget");
  }
  report.result = await call("selfverify_result", { runId: report.start.runId });
  console.log(JSON.stringify({ status: report.status.status, summary: report.result.summary }));
} catch (err) {
  report.error = err.message;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  report.stderrTail = stderr;
  report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
  await client.close();
}
