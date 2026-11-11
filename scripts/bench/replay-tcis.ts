#!/usr/bin/env bun
/**
 * scripts/bench/replay-tcis.ts — replay the "build TCIS.MCP.Docs MCP server"
 * request through the real CLI and compare `usage flow-metrics` against the
 * recorded baseline session (docs/benchmarks/tcis-mcp-docs-baseline.md).
 *
 * What it does
 *   1. Reads the baseline session READ-ONLY: its cwd (the source repo) and its
 *      first human prompt, verbatim.
 *   2. Clones that repo into a fresh temp dir and checks out the commit the
 *      original request started from. The real working tree is never touched
 *      (`git clone --no-hardlinks` reads it; every write goes to the clone).
 *   3. Boots the CLI in agent mode inside the clone through the agent harness
 *      transport, types the prompt, and observes until the run settles or a
 *      guard trips: --budget-usd (spend so far: usage_events of the new
 *      session + cost-log rows its workers tagged) or --max-wall-min.
 *      Askcards are answered with their default (Enter) — the replay has no
 *      human; the baseline had one, so treat the comparison accordingly.
 *   4. On settle/abort: kills the TUI and any still-running worker of the new
 *      session, runs flow-metrics on it and prints baseline vs replay.
 *
 * Safety: a live run spends real money. It refuses to start unless you pass
 * either --mock-llm <dir> (no provider traffic, isolated temp HOME) or --live.
 *
 * Usage
 *   bun scripts/bench/replay-tcis.ts --mock-llm scripts/bench/fixtures/replay-mock
 *   bun scripts/bench/replay-tcis.ts --live --budget-usd 60 --max-wall-min 2880
 *
 * Options
 *   --baseline <prefix>     baseline session (default 4edc02516a92)
 *   --baseline-home <dir>   muonroi home of the baseline (default ~/.muonroi-cli)
 *   --commit <sha>          start commit (default cd596d4, see START_COMMIT)
 *   --prompt <text>         run THIS prompt instead of the baseline's first prompt; the run is then
 *                           reported on its own (no baseline comparison)
 *   --greenfield            work in a fresh empty git repo instead of cloning a source repo
 *   --source-repo <path>    override the repo to clone (default: baseline cwd)
 *   --mock-llm <dir>        mock model fixtures; isolates HOME in the temp dir
 *   --live                  allow real provider traffic in your normal HOME
 *   --model <id>            pass -m <id> to the CLI (default: your settings)
 *   --permission <mode>     pass --permission <mode> to the CLI (safe | auto-edit | yolo)
 *   --budget-usd <n>        abort when spend exceeds n (default 15)
 *   --max-wall-min <n>      abort after n minutes (default 120)
 *   --quiet-sec <n>         settled = no UI change AND no running worker for n s (default 90)
 *   --auto-continue <n>     when the run settles with the orchestrator waiting on a human, send
 *                           AUTO_CONTINUE_TEXT up to n times (default 0). The baseline had a human
 *                           who sent 37 steering messages ("bắt đầu làm theo recommend của bạn",
 *                           "bạn có toàn quyền…"); the count used is reported in the output.
 *   --resume-session <id>   resume an existing run instead of starting one: launch the CLI with
 *                           --session <id> in --cwd <dir> (the kept clone of the earlier run) and
 *                           send --resume-text (default "/ideal resume"). --budget-usd then counts
 *                           only spend made after this launch (the session already spent the rest).
 *   --cwd <dir>             working directory for --resume-session
 *   --resume-text <text>    what to send once the TUI is ready (default "/ideal resume")
 *   --out <file>            also write {baseline, replay, comparison} JSON
 *   --keep                  keep the temp clone/home for inspection
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDriver } from "@muonroi/agent-harness-core/driver";
import type { LiveEvent, LiveFrame } from "@muonroi/agent-harness-core/protocol";
import { createLineSplitter } from "@muonroi/agent-harness-core/transports/sidechannel";
import { spawnAgentTui } from "../../src/agent-harness/test-spawn.js";
import { computeFlowMetrics, formatFlowMetrics, openReadOnlyDatabase } from "../../src/cli/flow-metrics.js";
import { compareFlowMetrics, formatComparison } from "../../src/cli/flow-metrics-compare.js";

/**
 * HEAD of the source repo when the original request began. Evidence: worker
 * clever-amber-sparrow (parent 8a5bd89c2be0) ran `git log --oneline -8` at
 * 2026-11-02T03:04:20Z and worker lively-blue-otter (parent 4edc02516a92) at
 * 2026-11-02T14:56:48Z; both printed `cd596d4 docs: ngữ cảnh Step trong log
 * lỗi` on master. Caveat: at 03:04 the tree also had 8 modified tracked files
 * (none under TCIS.MCP.Docs) that no commit captures.
 */
const START_COMMIT = "cd596d4";
const BASELINE_SESSION = "4edc02516a92";

const { values: opt } = parseArgs({
  options: {
    baseline: { type: "string", default: BASELINE_SESSION },
    "baseline-home": { type: "string" },
    commit: { type: "string", default: START_COMMIT },
    prompt: { type: "string" },
    greenfield: { type: "boolean", default: false },
    "source-repo": { type: "string" },
    "mock-llm": { type: "string" },
    live: { type: "boolean", default: false },
    model: { type: "string" },
    permission: { type: "string" },
    "budget-usd": { type: "string", default: "15" },
    "max-wall-min": { type: "string", default: "120" },
    "quiet-sec": { type: "string", default: "90" },
    "auto-continue": { type: "string", default: "0" },
    out: { type: "string" },
    "resume-session": { type: "string" },
    cwd: { type: "string" },
    "resume-text": { type: "string", default: "/ideal resume" },
    keep: { type: "boolean", default: false },
  },
});

const log = (msg: string) => process.stderr.write(`[replay ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

function fail(msg: string): never {
  log(`ERROR: ${msg}`);
  process.exit(1);
}

if (!opt["mock-llm"] && !opt.live) fail("refusing to run: pass --mock-llm <dir> (free) or --live (spends real money)");
if (opt["mock-llm"] && opt.live) fail("--mock-llm and --live are mutually exclusive");
const budgetUsd = Number(opt["budget-usd"]);
const maxWallMs = Number(opt["max-wall-min"]) * 60_000;
const quietMs = Number(opt["quiet-sec"]) * 1000;
const autoContinueMax = Number(opt["auto-continue"]);
/** Neutral stand-in for the baseline human's most common steering messages. */
const AUTO_CONTINUE_TEXT =
  "Bạn có toàn quyền quyết định — cứ làm theo đề xuất của bạn và tiếp tục cho đến khi hoàn thành.";
if (!(budgetUsd > 0) || !(maxWallMs > 0) || !(quietMs > 0))
  fail("--budget-usd, --max-wall-min, --quiet-sec must be > 0");
const resumeSession = opt["resume-session"];
if (resumeSession && !opt.cwd) fail("--resume-session needs --cwd <dir> (the kept clone of the earlier run)");
if (resumeSession && (opt.prompt || opt.greenfield)) fail("--resume-session excludes --prompt and --greenfield");

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const baselineHome = opt["baseline-home"] ?? process.env.MUONROI_CLI_HOME ?? join(homedir(), ".muonroi-cli");
const baselineDb = join(baselineHome, "muonroi.db");

// ---------------------------------------------------------------------------
// 1. Baseline: cwd + first human prompt (read-only)
// ---------------------------------------------------------------------------

function messageText(messageJson: string): { text: string; internal: boolean } {
  const m = JSON.parse(messageJson) as {
    content?: string | Array<{ type?: string; text?: string }>;
    providerOptions?: { muonroi?: { internalActivity?: boolean } };
  };
  const text =
    typeof m.content === "string"
      ? m.content
      : (m.content ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");
  return { text, internal: m.providerOptions?.muonroi?.internalActivity === true };
}

function readBaseline(): { sessionId: string; cwd: string; prompt: string } {
  const db = openReadOnlyDatabase(baselineDb);
  try {
    const rows = db
      .prepare(`SELECT id, cwd_at_start AS cwd FROM sessions WHERE id LIKE ? LIMIT 2`)
      .all(`${opt.baseline}%`) as Array<{ id: string; cwd: string }>;
    if (rows.length !== 1) fail(`baseline prefix '${opt.baseline}' matched ${rows.length} sessions in ${baselineDb}`);
    const session = rows[0]!;
    const users = db
      .prepare(`SELECT message_json AS mj FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq ASC`)
      .all(session.id) as Array<{ mj: string }>;
    const first = users.map((u) => messageText(u.mj)).find((u) => !u.internal && u.text.trim());
    if (!first) fail(`baseline session ${session.id} has no human prompt`);
    return { sessionId: session.id, cwd: session.cwd, prompt: first.text };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 2. Workspace: clone at the start commit
// ---------------------------------------------------------------------------

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function prepareClone(sourceRepo: string, commit: string, root: string): string {
  const dir = join(root, "repo");
  log(`cloning ${sourceRepo} → ${dir} (source working tree is only read)`);
  git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", sourceRepo, dir]);
  const full = git(["rev-parse", "--verify", `${commit}^{commit}`], dir);
  git(["checkout", "--quiet", "--detach", full], dir);
  log(`checked out ${full}`);
  return dir;
}

// ---------------------------------------------------------------------------
// 3. Observation helpers (read-only DB + delegation records)
// ---------------------------------------------------------------------------

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function findSessions(dbPath: string, cwd: string): string[] {
  if (!existsSync(dbPath)) return [];
  const db = openReadOnlyDatabase(dbPath);
  try {
    const rows = db
      .prepare(`SELECT id, cwd_at_start AS cwd FROM sessions WHERE created_at >= ? ORDER BY created_at ASC`)
      .all(new Date(startedAt - 60_000).toISOString()) as Array<{ id: string; cwd: string }>;
    return rows.filter((r) => sameDir(r.cwd, cwd)).map((r) => r.id);
  } finally {
    db.close();
  }
}

function sumStored(dbPath: string, ids: string[]): { usd: number; assistantMessages: number } {
  if (ids.length === 0 || !existsSync(dbPath)) return { usd: 0, assistantMessages: 0 };
  const db = openReadOnlyDatabase(dbPath);
  try {
    const ph = ids.map(() => "?").join(",");
    const usd =
      ((
        db
          .prepare(`SELECT COALESCE(SUM(cost_micros),0) AS c FROM usage_events WHERE session_id IN (${ph})`)
          .get(...ids) as {
          c: number;
        }
      ).c ?? 0) / 1_000_000;
    const assistantMessages = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id IN (${ph}) AND role = 'assistant'`)
        .get(...ids) as {
        n: number;
      }
    ).n;
    return { usd, assistantMessages };
  } finally {
    db.close();
  }
}

/** Worker spend: cost-log rows the worker processes tagged with a parent session of ours. */
function workerSpend(home: string, ids: Set<string>): number {
  const dir = join(home, "usage");
  if (!existsSync(dir)) return 0;
  const days = new Set<string>();
  for (let t = startedAt - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000)
    days.add(new Date(t).toISOString().slice(0, 10));
  let usd = 0;
  for (const day of days) {
    const file = join(dir, `cost-log-${day}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.includes("parentSessionId")) continue;
      try {
        const row = JSON.parse(line) as { parentSessionId?: string; estimatedUsd?: number; ts?: number };
        if (row.parentSessionId && ids.has(row.parentSessionId) && (row.ts ?? 0) >= startedAt)
          usd += row.estimatedUsd ?? 0;
      } catch (err) {
        log(`skipping malformed cost-log line in ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return usd;
}

function runningWorkers(home: string, ids: Set<string>): Array<{ id: string; pid?: number }> {
  const root = join(home, "delegations");
  if (!existsSync(root)) return [];
  const out: Array<{ id: string; pid?: number }> = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const name of readdirSync(join(root, project.name))) {
      if (!name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(root, project.name, name), "utf8")) as {
          id: string;
          status: string;
          pid?: number;
          parentSessionId?: string;
        };
        if (r.status === "running" && r.parentSessionId && ids.has(r.parentSessionId))
          out.push({ id: r.id, pid: r.pid });
      } catch (err) {
        // A record mid-rewrite (temp+rename) can be read torn; the next poll re-reads it.
        log(`delegation record ${name} unreadable this poll: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return out;
}

function killTree(pid: number, label: string): void {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
    log(`killed ${label} (pid ${pid})`);
  } catch (err) {
    // Already exited is the common case here; anything else is worth seeing.
    log(`kill ${label} (pid ${pid}) did not apply: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const startedAt = Date.now();

async function main(): Promise<void> {
  // --prompt runs an arbitrary task: no baseline session, no comparison.
  const baseline = opt.prompt || resumeSession ? undefined : readBaseline();
  const prompt = resumeSession ? opt["resume-text"]! : (opt.prompt ?? baseline!.prompt);
  const root = resumeSession
    ? resolve(opt.cwd!, "..")
    : mkdtempSync(join(tmpdir(), opt.prompt ? "task-run-" : "tcis-replay-"));
  let cwd: string;
  if (resumeSession) {
    cwd = resolve(opt.cwd!);
    if (!existsSync(cwd)) fail(`--cwd ${cwd} does not exist`);
    log(`resuming session ${resumeSession} in ${cwd}`);
  } else if (opt.greenfield) {
    cwd = join(root, "repo");
    mkdirSync(cwd, { recursive: true });
    git(["init", "--quiet"], cwd);
    git(
      ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "--quiet", "--allow-empty", "-m", "init"],
      cwd,
    );
    log(`greenfield repo ${cwd}`);
  } else {
    const sourceRepo = opt["source-repo"] ?? baseline?.cwd;
    if (!sourceRepo) fail("--prompt without --greenfield needs --source-repo");
    cwd = prepareClone(sourceRepo, opt.commit!, root);
  }
  log(`${baseline ? `baseline ${baseline.sessionId}; ` : ""}prompt (${prompt.length} chars):`);
  log(`  ${JSON.stringify(prompt)}`);

  const mock = opt["mock-llm"] ? resolve(opt["mock-llm"]) : undefined;
  const userHome = mock ? join(root, "home") : homedir();
  if (mock) mkdirSync(userHome, { recursive: true });
  const runHome = mock ? join(userHome, ".muonroi-cli") : baselineHome;
  const runDb = join(runHome, "muonroi.db");

  const env: Record<string, string> = { ...(process.env as Record<string, string>), MUONROI_INTERNAL_SHIM_OK: "1" };
  if (mock) {
    Object.assign(env, {
      HOME: userHome,
      USERPROFILE: userHome,
      MUONROI_CLI_HOME: runHome,
      // Placeholder key so the onboarding modal does not open; never sent (mock intercepts).
      DEEPSEEK_API_KEY: ["muonroi", "replay", "mock", "deepseek", "key"].join("-"),
    });
  }
  const args = [join(repoRoot, "src/index.ts"), "--agent-mode", ...(mock ? ["--mock-llm", mock] : [])];
  if (opt.model) args.push("-m", opt.model);
  // --permission safe|auto-edit|yolo overrides the user setting for this run (safe exercises approval cards).
  if (opt.permission) args.push("--permission", opt.permission);
  if (resumeSession) args.push("--session", resumeSession);
  log(`launching CLI (${mock ? `mock ${mock}` : "LIVE"}) in ${cwd}`);
  const { proc, inWrite, outRead } = await spawnAgentTui(args, { spawnOpts: { env, cwd } });

  const driver = createDriver({
    sendKey: (k) => inWrite.write(`${JSON.stringify({ op: "press", key: k })}\n`),
    sendType: (t) => inWrite.write(`${JSON.stringify({ op: "type", text: t })}\n`),
  });
  let lastChangeAt = Date.now();
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    log(`CLI exited (code ${code})`);
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const text = d.toString().trim();
    if (text) log(`cli stderr: ${text.slice(0, 300)}`);
  });
  const splitter = createLineSplitter((line) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      log(`non-JSON sidechannel line ignored: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (msg.mode === "live") {
      lastChangeAt = Date.now();
      driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
    } else if (msg.t === "idle") driver._ingest({ kind: "idle" });
    else if (msg.t === "event") {
      const ev = msg as unknown as LiveEvent;
      driver._ingest({ kind: "event", event: ev });
      if ("kind" in ev && ev.kind === "askcard-open") {
        log(`askcard opened — accepting its default (no human in a replay)`);
        setTimeout(() => driver.press("Enter"), 1500);
      }
    }
  });
  outRead.on("data", (c: Buffer | string) => splitter(typeof c === "string" ? Buffer.from(c) : c));

  await driver.wait_for({ idle: true, timeoutMs: 60_000 });
  log("TUI ready; sending the baseline prompt");
  driver.type(prompt);
  driver.press("Enter");

  let reason = "settled";
  let ids: string[] = [];
  let autoContinues = 0;
  // A worker finishing is activity too: its completion wakes the orchestrator a
  // moment later. Measuring quiet from the last UI frame alone killed run
  // a2a6d27eb5ca right as its last worker finished, before the wake-up turn.
  let lastWorkerSeenAt = Date.now();
  let spendAtLaunch: number | undefined;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    ids = findSessions(runDb, cwd);
    if (resumeSession && !ids.includes(resumeSession)) ids = [resumeSession, ...ids];
    const idSet = new Set(ids);
    const stored = sumStored(runDb, ids);
    const totalSpend = stored.usd + workerSpend(runHome, idSet);
    // Resume: the budget covers only what this launch spends (the session already spent the rest).
    spendAtLaunch ??= totalSpend;
    const spend = resumeSession ? totalSpend - spendAtLaunch : totalSpend;
    const running = runningWorkers(runHome, idSet);
    const elapsed = Date.now() - startedAt;
    if (spend > budgetUsd) {
      reason = `budget: spent $${spend.toFixed(2)} > $${budgetUsd}`;
      break;
    }
    if (elapsed > maxWallMs) {
      reason = `wall: ${(elapsed / 60_000).toFixed(1)} min > ${opt["max-wall-min"]} min`;
      break;
    }
    if (exited) {
      reason = "cli-exited";
      break;
    }
    if (running.length > 0) lastWorkerSeenAt = Date.now();
    const quietFor = Date.now() - Math.max(lastChangeAt, lastWorkerSeenAt);
    if (quietFor > quietMs && running.length === 0 && stored.assistantMessages > 0) {
      if (autoContinues < autoContinueMax) {
        autoContinues++;
        log(`settled waiting on a human — auto-continue ${autoContinues}/${autoContinueMax}`);
        driver.type(AUTO_CONTINUE_TEXT);
        driver.press("Enter");
        lastChangeAt = Date.now();
        continue;
      }
      break;
    }
    if (elapsed % 60_000 < 5_000)
      log(
        `t+${Math.round(elapsed / 60_000)}m spend=$${spend.toFixed(2)} sessions=${ids.length} running-workers=${running.length}`,
      );
  }
  log(`stopping: ${reason}`);
  for (const w of runningWorkers(runHome, new Set(ids))) if (w.pid) killTree(w.pid, `worker ${w.id}`);
  if (!exited && proc.pid) killTree(proc.pid, "CLI");
  // Windows: opening the DB right after the kill fails SQLITE_IOERR until the
  // process has really exited (measured on run a2a6d27eb5ca).
  const exitDeadline = Date.now() + 30_000;
  while (!exited && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 250));
  if (!exited) log("CLI did not report exit within 30s; reading the DB anyway");

  if (ids.length === 0) fail(`no session was recorded for ${cwd} in ${runDb}`);
  const replayId = ids[0]!;
  const after = await withIoRetry(() => computeFlowMetrics(replayId, { home: runHome, db: runDb }));
  if (!baseline) {
    process.stdout.write(
      `\nRun ${replayId} (${reason}; auto-continues ${autoContinues})\n${formatFlowMetrics(after)}\n`,
    );
    if (opt.out) {
      writeFileSync(opt.out, JSON.stringify({ reason, autoContinues, prompt, cwd, replay: after }, null, 2));
      log(`wrote ${opt.out}`);
    }
    if (opt.keep) log(`kept ${root}`);
    return;
  }
  const before = await withIoRetry(() =>
    computeFlowMetrics(baseline.sessionId, { home: baselineHome, db: baselineDb }),
  );
  const rows = compareFlowMetrics(before, after);
  process.stdout.write(
    `\nReplay ${replayId} (${reason}; auto-continues ${autoContinues}) vs baseline ${baseline.sessionId}\n${formatComparison(
      rows,
      {
        baseline: baseline.sessionId,
        replay: replayId,
      },
    )}\n`,
  );
  if (opt.out) {
    writeFileSync(
      opt.out,
      JSON.stringify({ reason, autoContinues, baseline: before, replay: after, comparison: rows }, null, 2),
    );
    log(`wrote ${opt.out}`);
  }
  if (opt.keep) log(`kept ${root}`);
  else {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      log(`temp cleanup incomplete (${root}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)),
);

/** Retry a DB read a few times on a transient SQLite I/O error (file still held by an exiting process). */
async function withIoRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 5 || !/disk I\/O error|SQLITE_IOERR|SQLITE_BUSY|database is locked/i.test(msg)) throw err;
      log(`DB read failed (${msg}); retry ${attempt}/4 in 2s`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
