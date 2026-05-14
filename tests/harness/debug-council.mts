/**
 * Debug script: trace what fd3 emits after sending /council Tab ... Enter.
 * Run from WSL: bun run tests/harness/debug-council.mts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createLineSplitter } from "../../src/agent-harness/sidechannel.js";

const MOCK_KEY = ["test", "mock", "provider", "noop"].join("-");
const entry = resolve("src/index.ts");
const fixturesDir = resolve("tests/harness/fixtures/llm");

const spawnEnv = { ...process.env };
spawnEnv.SILICONFLOW_API_KEY = MOCK_KEY;

const proc: ChildProcess = spawn(
  "bun",
  ["run", entry, "--agent-mode", "--mock-llm", fixturesDir, "-k", MOCK_KEY, "-m", "deepseek-ai/DeepSeek-V4-Flash"],
  { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], env: spawnEnv },
);

proc.stderr?.on("data", (d: Buffer) => process.stderr.write("STDERR: " + d));

const fd3 = proc.stdio[3] as NodeJS.ReadableStream | null;
const fd4 = proc.stdio[4] as NodeJS.WritableStream | null;

const send = (obj: unknown) => {
  const line = JSON.stringify(obj) + "\n";
  fd4?.write(line);
  console.log("SENT:", JSON.stringify(obj));
};

const lines: string[] = [];
const splitter = createLineSplitter((line) => {
  lines.push(line);
  if (line.includes("council_phase") || line.includes("idle")) {
    console.log("FD3:", line.slice(0, 200));
  }
});

fd3?.on("data", (chunk: Buffer | string) =>
  splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for initial idle
await sleep(8000);
console.log("--- sending /council sequence ---");

send({ op: "type", text: "/council" });
await sleep(500);
send({ op: "press", key: "Tab" });
await sleep(2000);  // wait for React to re-render
send({ op: "type", text: "analyze trade-offs for the project" });
await sleep(500);
send({ op: "press", key: "Enter" });
await sleep(10000);

console.log("--- checking for council_phase ---");
const councilLines = lines.filter((l) => l.includes("council"));
console.log("council-related lines:", councilLines.length);
councilLines.slice(0, 5).forEach((l) => console.log("  ", l.slice(0, 200)));

proc.kill();
process.exit(councilLines.some((l) => l.includes("council_phase")) ? 0 : 1);
