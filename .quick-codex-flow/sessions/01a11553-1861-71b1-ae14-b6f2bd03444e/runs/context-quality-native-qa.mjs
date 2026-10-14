import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Drive the exact native tools over MCP from the tested workspace build.
// The externally configured npx server lacks agent-harness-core/selector.
const client = new Client({ name: "context-quality-native-qa", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "bun",
  args: ["dist/src/index.js", "tools-mcp"],
  cwd: process.cwd(),
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const decode = (result) => JSON.parse(result.content.find((block) => block.type === "text").text);
try {
  await client.connect(transport);
  const roster = await client.listTools();
  for (const name of ["selfverify_start", "selfverify_status", "selfverify_result"]) {
    if (!roster.tools.some((tool) => tool.name === name)) throw new Error(`Missing native tool: ${name}`);
  }
  const { runId } = decode(
    await client.callTool({ name: "selfverify_start", arguments: { mode: "tier1", max: 1, emit: false } }),
  );
  console.log(JSON.stringify({ runId, server: "workspace dist/src/index.js tools-mcp" }));
  let status;
  const deadline = Date.now() + 60_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = decode(await client.callTool({ name: "selfverify_status", arguments: { runId } }));
    if (Date.now() >= deadline) throw new Error(`Native QA deadline exceeded: ${JSON.stringify(status)}`);
  } while (status.status === "running");
  if (status.status === "error") throw new Error(`Native QA failed: ${status.error}`);
  const result = decode(await client.callTool({ name: "selfverify_result", arguments: { runId } }));
  writeFileSync(new URL("context-quality-selfverify.json", import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ runId, summary: result.report?.summary ?? result.summary }));
  const summary = result.report?.summary ?? result.summary;
  if (!summary || summary.failed || summary.inconclusive || summary.passed < 1)
    throw new Error("Native QA did not establish a pass");
} catch (err) {
  console.error("Workspace native selfverify failed:", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
