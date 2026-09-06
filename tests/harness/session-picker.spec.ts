import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnHarness } from "./helpers";

describe("resume picker collapses conversation trees", () => {
  let home: string;
  let harness: Awaited<ReturnType<typeof spawnHarness>>;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-resume-e2e-"));
    // Seed a rotation tree + a sub-agent + a stub into the temp DB BEFORE launch.
    // Use the same storage layer the app uses so the schema/migrations match.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const { SessionStore } = await import("../../src/storage/sessions.js");
    const { getDatabase, closeDatabase } = await import("../../src/storage/db.js");
    const store = new SessionStore(home);
    const root = store.createSession("gpt", "agent", home);
    store.setTitle(root.id, "Refactor auth flow");
    const leaf = store.createSession("gpt", "agent", home);
    store.linkChild(leaf.id, root.id, "rotation");
    const sub = store.createSession("gpt", "agent", home);
    store.linkChild(sub.id, root.id, "subagent");
    // Give each a message so the resume filter surfaces the tree.
    const db = getDatabase();
    for (const sid of [root.id, leaf.id, sub.id]) {
      db.prepare(
        "INSERT INTO messages (session_id, seq, role, message_json, created_at, status) VALUES (?,1,'user','{}',?,'completed')",
      ).run(sid, new Date().toISOString());
    }
    closeDatabase();

    harness = await spawnHarness({ cwd: home, env: { HOME: home, USERPROFILE: home } });
    // Gate on the readiness signal, NOT on idle. `wait_for({idle:true})` is
    // captured-start based and resolves on an empty pre-mount frame — measured
    // here at ~90 ms, roughly 330 ms BEFORE the React input bridge registers.
    // That is why this spec failed 3/3 at retry:0: the leading "/" of "/resume"
    // was sent into the window and discarded, so the slash menu never opened and
    // Enter had nothing to select. A retry only "fixed" it because beforeAll
    // spawns once, so the second attempt reused the already-warm process.
    // `input-ready` is one-shot and replay-safe (the driver scans its buffered
    // event ring), so this resolves whether it arrives before or after the call.
    await harness.driver.wait_for({ event: "input-ready", timeoutMs: 30_000 });
    await harness.driver.wait_for({ idle: true, timeoutMs: 20_000 });
  }, 60_000);

  afterAll(async () => {
    harness?.proc?.kill();
    // Wait up to 1 second for the process to terminate and release file descriptors.
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      if (harness?.proc) {
        harness.proc.on("exit", done);
        harness.proc.on("close", done);
      }
      setTimeout(done, 1000);
    });

    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("shows one collapsed row for the tree, no (untitled)/{} noise", async () => {
    // Type char-by-char so the slash-menu filter state commits through React
    // between keystrokes (an uncontrolled composer does not re-render on a
    // single bulk insert, leaving the menu's selectedIndex on a stale item —
    // Enter then selects the wrong command). Settle before Enter.
    for (const ch of "/resume") {
      harness.driver.type(ch);
      await new Promise((r) => setTimeout(r, 30));
    }
    await harness.driver.wait_for({ idle: true, timeoutMs: 3_000 }).catch(() => undefined);
    harness.driver.press("Enter");
    await harness.driver.wait_for({ selector: "id=session-picker", timeoutMs: 8_000 });

    const items = harness.driver.queryAll("role=listitem");
    // Exactly one row: the collapsed tree. Sub-agent excluded; leaf collapsed
    // into the root; no empty-stub sessions.
    expect(items.length).toBe(1);
    const name = items[0]?.name ?? "";
    expect(name).toContain("Refactor auth flow"); // root title, inherited
    expect(name).not.toContain("(untitled)");
    expect(name).not.toContain("{}");
  });
});
