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
  if (line.includes("council_phase") || line.includes('"t":"idle"') || line.includes('"t":"event"')) {
    console.log("FD3:", line.slice(0, 300));
  }
  // Log ALL frame diffs to see what nodes change
  if (line.includes('"mode":"live"')) {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const nodes = (msg.nodes as unknown[]) ?? [];
      const patches = (msg.patches as unknown[]) ?? [];
      const removes = (msg.removes as unknown[]) ?? [];
      if (nodes.length + patches.length + removes.length > 0) {
        console.log("FRAME diff: nodes=" + nodes.length + " patches=" + patches.length + " removes=" + removes.length);
        for (const n of nodes as Record<string, unknown>[]) {
          console.log("  NODE:", JSON.stringify(n).slice(0, 200));
        }
        for (const p of patches as Record<string, unknown>[]) {
          console.log("  PATCH:", JSON.stringify(p).slice(0, 200));
        }
      }
    } catch { /* */ }
  }
});

fd3?.on("data", (chunk: Buffer | string) =>
  splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Log ALL fd3 lines (to see everything, including non-frame events)
fd3?.on("data", (chunk: Buffer | string) => {
  // Already handled by splitter
});

// Wait for initial idle
await sleep(8000);
console.log("--- sending: /council analyze... Enter (full command, no Tab) ---");

// Type the full command. The slash menu opens on "/" but once the filter has
// no matching items, app.tsx lets Enter fall through to the textarea submit
// handler (fix: filteredSlashItems empty → no key.preventDefault on Enter).
send({ op: "type", text: "/council analyze trade-offs for the project" });
// Wait for React to commit slashSearchQuery state updates before sending Enter
// — otherwise filteredSlashItems is stale (full list) and Enter selects "exit".
await sleep(3000);
send({ op: "press", key: "Enter" });
await sleep(20000);

console.log("--- checking for council_phase ---");
const councilLines = lines.filter((l) => l.includes("council"));
console.log("council-related lines:", councilLines.length);
councilLines.slice(0, 5).forEach((l) => console.log("  ", l.slice(0, 300)));

proc.kill();
process.exit(councilLines.some((l) => l.includes("council_phase")) ? 0 : 1);
