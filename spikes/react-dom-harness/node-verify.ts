/**
 * Node-only proof of concept (fallback when Playwright hangs on Windows/Git-Bash).
 * Exercises the registry + snapshot-loop logic directly, without a browser.
 *
 * Acceptance:
 *   - Frame 1: btn registered → nodes=[{id:"btn",role:"button",name:"Click"}]
 *   - Frame 2: btn unregistered → nodes=[]
 *   - No 3rd frame (hash-dedup: identical registry state re-snapshot must not emit)
 *   Prints "PASS: 2 frames, no dup" and exits 0, or prints FAIL + exits 1.
 */
import { createRegistry } from "./src/registry";

const registry = createRegistry();
const frames: string[] = [];

let lastHash = "";
let seq = 0;
const PROTOCOL_VERSION = "0.1.0" as const;

function captureFrame(): void {
  const nodes = registry.snapshot();
  const hash = JSON.stringify(nodes);
  if (hash === lastHash) return; // dedup — identical state
  lastHash = hash;
  const frame = { mode: "live" as const, version: PROTOCOL_VERSION, seq: ++seq, ts: Date.now(), nodes };
  frames.push(JSON.stringify(frame));
}

// --- Simulate mount/unmount cycle ---

// Mount: register the button
const unregister = registry.register({ id: "btn", role: "button", name: "Click" });
captureFrame(); // should emit frame 1

// Identical state — re-snapshot must NOT emit (dedup)
captureFrame();
captureFrame();

// Unmount: unregister
unregister();
captureFrame(); // should emit frame 2

// Another no-op re-snapshot
captureFrame();

// --- Validate ---
const parsed = frames.map((f) => JSON.parse(f));
const frame1 = parsed[0];
const frame2 = parsed[1];

let ok = true;
if (frames.length !== 2) {
  console.error(`FAIL: got ${frames.length} distinct frames (expected 2)`);
  ok = false;
}
if (ok && (frame1?.nodes?.length !== 1 || frame1?.nodes?.[0]?.id !== "btn")) {
  console.error("FAIL: frame 1 does not contain btn node");
  ok = false;
}
if (ok && frame2?.nodes?.length !== 0) {
  console.error("FAIL: frame 2 does not have empty nodes");
  ok = false;
}
if (ok && frame1?.version !== "0.1.0") {
  console.error(`FAIL: wrong version in frame 1: ${frame1?.version}`);
  ok = false;
}
if (ok && frame1?.mode !== "live") {
  console.error(`FAIL: wrong mode in frame 1: ${frame1?.mode}`);
  ok = false;
}

if (ok) {
  console.log("PASS: 2 frames, no dup");
  console.log("Frame 1:", JSON.stringify(parsed[0], null, 2));
  console.log("Frame 2:", JSON.stringify(parsed[1], null, 2));
  process.exit(0);
} else {
  process.exit(1);
}
