import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sourceFingerprint } from "../../../src/orchestrator/review-evidence.js";

const home = process.env.MUONROI_GIT_FIXTURE_HOME;
const target = process.env.MUONROI_GIT_FIXTURE_TARGET;
if (!home || !target || process.env.HOME !== home || process.env.USERPROFILE !== home)
  throw new Error("Git snapshot fixture requires isolated home and explicit target");
await import("../../../src/index.ts");
const runGit = promisify(execFile);
let last = "",
  busy = false;
let lastBeat = performance.now(),
  maxGapMs = 0,
  beats = 0;
setInterval(() => {
  const now = performance.now();
  if (busy) {
    maxGapMs = Math.max(maxGapMs, now - lastBeat);
    beats++;
  }
  lastBeat = now;
}, 10);
setInterval(async () => {
  const control = join(home, "git-trigger.txt");
  if (busy || !existsSync(control)) return;
  const command = readFileSync(control, "utf8").trim();
  if (command === last) return;
  last = command;
  busy = true;
  lastBeat = performance.now();
  maxGapMs = 0;
  beats = 0;
  const started = performance.now();
  const receipt: Record<string, unknown> = { command, target };
  try {
    if (command === "async-git")
      receipt.output = (
        await runGit("git", ["-C", target, "rev-parse", "--show-toplevel"], {
          timeout: 10000,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        })
      ).stdout.trim();
    else receipt.output = await sourceFingerprint(target);
  } catch (error) {
    const err = error as Error & { code?: string; signal?: string };
    console.error("Git snapshot fixture probe failed:", err.message);
    receipt.error = { message: err.message, code: err.code, signal: err.signal };
  } finally {
    receipt.elapsedMs = performance.now() - started;
    receipt.maxGapMs = Math.max(maxGapMs, performance.now() - lastBeat);
    receipt.beats = beats;
    writeFileSync(join(home, `git-${command}.json`), JSON.stringify(receipt));
    busy = false;
  }
}, 50);
