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
  // Log all frames (truncated) for inspection
  if (line.includes('"mode":"live"')) {
    // Extract just the nodes portion to see composer value
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const nodes = (msg.nodes as unknown[]) ?? [];
      const composer = nodes.find((n: unknown) => (n as Record<string, unknown>).id === "composer");
      if (composer) {
        console.log("COMPOSER:", JSON.stringify(composer).slice(0, 200));
      }
    } catch { /* */ }
  }
});

fd3?.on("data", (chunk: Buffer | string) =>
  splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait for initial idle
await sleep(8000);
console.log("--- test A: type /council, Escape, then type full command ---");

// Approach A: type a non-space char first so slash-menu doesn't open,
// then type the rest of the command, then Backspace to remove the prefix.
// handleCommand("/council topic") reads the trimmed text.
// "/" at start of input only opens slash menu if text.trim() === "".
// So typing "x" first, then backspace to delete it... but Backspace deletes
// the char before cursor. Instead, let's use a completely different approach:
// type the full text with "x" prefix, then send 45 Backspaces to clear it,
// then type from scratch. Too complex.
//
// Simplest approach: just add a printable prefix char then Backspace.
send({ op: "type", text: "x" });  // non-empty input — '/' won't open slash menu
await sleep(200);
send({ op: "press", key: "Backspace" }); // delete 'x'
await sleep(200);
// Now input is empty — but we need to type "/" immediately as part of the full string.
// Actually, we need "/council analyze..." as a SINGLE op:type call.
// The slash menu opens on the "/" char key press (key.sequence === "/").
// op:type sends each char as keyForChar(ch), and for "/" that means
// { name: "/", sequence: "/", raw: "/" } — matches key.sequence === "/".
// BUT wait: what if input is NOT empty when "/" arrives?
// We typed "x" then Backspace. Input is empty again when "/" arrives.
// We need the "/" to arrive when input is NOT empty.
// New idea: type "x/council analyze..." — when "/" arrives, input has "x" → menu stays closed.
// Then we need "x" at the front... handleCommand trims but doesn't strip leading letters.
// "x/council topic" would NOT be recognized as a slash command.
//
// ACTUAL INSIGHT: We should use the input-bridge "type" operation differently.
// op:type sends each char via keyForChar. But we can send "op:type" for the
// whole string "/council analyze..." as long as the slash menu isn't triggered.
//
// The real question: CAN we disable slash menu opening for programmatic input?
// No — app.tsx checks key.sequence === "/" which is set by keyForChar.
//
// CONCLUSION: We need to send the full command via a SINGLE injection that
// bypasses the slash menu entirely. The only way is to directly set the textarea
// value and trigger Enter. But the driver API doesn't support that.
//
// ALTERNATIVE: Use the input-bridge to send Enter BEFORE the type call,
// so the sequence is: (1) type "/council" (opens menu, filter="council"),
// (2) Enter (selects "council" from menu → inserts "/council " into textarea,
//     no topic typed yet so nothing dispatched yet),
// (3) type topic text "analyze trade-offs for the project",
// (4) Enter again (now submits the full command).
send({ op: "press", key: "Backspace" }); // undo the above
await sleep(200);
// Reset with Enter approach:
send({ op: "type", text: "/council" });
await sleep(500);
send({ op: "press", key: "Enter" });   // selects "council" from menu → inserts "/council "
await sleep(500);
send({ op: "type", text: "analyze trade-offs for the project" });
await sleep(300);
send({ op: "press", key: "Enter" });   // submits "/council analyze trade-offs for the project"
await sleep(10000);

console.log("--- checking for council_phase ---");
const councilLines = lines.filter((l) => l.includes("council"));
console.log("council-related lines:", councilLines.length);
councilLines.slice(0, 5).forEach((l) => console.log("  ", l.slice(0, 200)));

proc.kill();
process.exit(councilLines.some((l) => l.includes("council_phase")) ? 0 : 1);
