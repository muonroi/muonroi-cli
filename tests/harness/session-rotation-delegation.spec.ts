import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@muonroi/agent-harness-core/driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnHarness } from "./helpers.js";

const requireSync = createRequire(import.meta.url);

describe("E2E Harness - Sub-Session Delegation & Silent Session Rotation", () => {
  let workDir: string;
  let fixDir: string;
  let homeDir: string;
  let dbPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "muonroi-sd-"));
    fixDir = join(workDir, "fix");
    homeDir = join(workDir, "home");
    mkdirSync(fixDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    dbPath = join(homeDir, ".muonroi-cli", "muonroi.db");
  });

  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("triggers SPAWN_SUB_SESSION: creates child session linked to parent, and absorbs summary", async () => {
    // 1. Write the fixture.
    // Round 0 (Classifier): returns SPAWN_SUB_SESSION
    // Round 1 (Sub-session prompt run): returns final structured output
    const fixture = {
      model: {
        provider: "mock",
        modelId: "mock-deepseek",
        stream: [
          [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "SPAWN_SUB_SESSION,0.98,complex task that needs tool usage" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
          [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t2" },
            {
              type: "text-delta",
              id: "t2",
              delta:
                "Key Changes: created verification script\nVerification Details: run verified\nResult Summary: completed task successfully.",
            },
            { type: "text-end", id: "t2" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
        ],
      },
    };
    writeFileSync(join(fixDir, "fixture.json"), JSON.stringify(fixture), "utf8");

    // 2. Spawn TUI harness
    const ctx = await spawnHarness({
      fixturesDir: fixDir,
      cwd: homeDir,
      env: {
        MUONROI_FORCE_ROUTING_CLASSIFY: "1",
        MUONROI_NO_SHELL_HOLD: "1",
        // Force EE unreachable so the routing classifier round-trip is the
        // deterministic mock path (no EE-informed variance / network latency).
        // On CI the default EE URL is reachable, adding latency + nondeterminism
        // that stalled the sub-session spawn/rotate flow past its budget so the
        // child session never committed → DB assertion failed.
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      },
    });

    // CI cold-boot (25–46s under 2-core contention) can exceed a 15s idle gate.
    await ctx.driver.wait_for({ idle: true, timeoutMs: 60_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });

    // Type the prompt
    ctx.driver.type("create verification script");
    ctx.driver.press("Enter");

    // Wait for LLM response
    await ctx.driver.wait_for({ selector: "role=log", timeoutMs: 30_000 });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });

    // Exit gracefully to ensure DB commits
    ctx.driver.type("/exit");
    ctx.driver.press("Enter");

    await new Promise<void>((resolve) => {
      ctx.proc.once("exit", () => resolve());
      setTimeout(() => {
        ctx.proc.kill();
        resolve();
      }, 5000);
    });

    // 3. Verify SQLite DB state
    expect(existsSync(dbPath)).toBe(true);
    const BetterSqlite3 = requireSync("better-sqlite3");
    const db = new BetterSqlite3(dbPath);

    // Verify session linkage
    const sessions = db
      .prepare("SELECT id, parent_session_id, status FROM sessions ORDER BY created_at DESC")
      .all() as any[];
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // The most recently created session should be the sub-session (child) and have a parent_session_id pointing to the parent.
    const child = sessions[0];
    const parent = sessions[1];
    expect(child.parent_session_id).toBe(parent.id);

    // Verify parent's message has absorbed the final sub-session outcome
    const parentMessages = db
      .prepare("SELECT role, message_json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(parent.id) as any[];
    const assistantMsgs = parentMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    const lastAssistantMsg = JSON.parse(assistantMsgs[assistantMsgs.length - 1].message_json);
    const content = lastAssistantMsg.content;
    const textContent =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((c: any) => c.text || c.content || "").join("")
          : "";
    expect(textContent).toContain("Result Summary: completed task successfully.");

    db.close();
    ctx.cleanup();
  }, 150_000);

  it("triggers ROTATE_SESSION: rotates session silently when threshold exceeded", async () => {
    // Round 0 (Classifier): ROTATE_SESSION
    // Round 1 (New session): prompt run
    const fixture = {
      model: {
        provider: "mock",
        modelId: "mock-deepseek",
        stream: [
          [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ROTATE_SESSION,0.95,user switches topic" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
          [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t2" },
            { type: "text-delta", id: "t2", delta: "Switched session details." },
            { type: "text-end", id: "t2" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
        ],
      },
    };
    const specFixDir = join(workDir, "fix-rotate");
    mkdirSync(specFixDir, { recursive: true });
    writeFileSync(join(specFixDir, "fixture.json"), JSON.stringify(fixture), "utf8");

    const specHomeDir = join(workDir, "home-rotate");
    mkdirSync(specHomeDir, { recursive: true });
    const specDbPath = join(specHomeDir, ".muonroi-cli", "muonroi.db");

    // Spawn TUI harness
    const ctx = await spawnHarness({
      fixturesDir: specFixDir,
      cwd: specHomeDir,
      env: {
        MUONROI_FORCE_ROUTING_CLASSIFY: "1",
        MUONROI_NO_SHELL_HOLD: "1",
        // Force EE unreachable so the routing classifier round-trip is the
        // deterministic mock path (no EE-informed variance / network latency).
        // On CI the default EE URL is reachable, adding latency + nondeterminism
        // that stalled the sub-session spawn/rotate flow past its budget so the
        // child session never committed → DB assertion failed.
        MUONROI_EE_BASE_URL: "http://127.0.0.1:1",
      },
    });

    // CI cold-boot (25–46s under 2-core contention) can exceed a 15s idle gate.
    await ctx.driver.wait_for({ idle: true, timeoutMs: 60_000 });
    await ctx.driver.wait_for({ selector: "role=textbox", timeoutMs: 10_000 });

    ctx.driver.type("switch to a different topic");
    ctx.driver.press("Enter");

    await ctx.driver.wait_for({ selector: "role=log", timeoutMs: 30_000 });
    await ctx.driver.wait_for({ idle: true, timeoutMs: 30_000 });

    ctx.driver.type("/exit");
    ctx.driver.press("Enter");

    await new Promise<void>((resolve) => {
      ctx.proc.once("exit", () => resolve());
      setTimeout(() => {
        ctx.proc.kill();
        resolve();
      }, 5000);
    });

    expect(existsSync(specDbPath)).toBe(true);
    const BetterSqlite3 = requireSync("better-sqlite3");
    const db = new BetterSqlite3(specDbPath);

    const sessions = db.prepare("SELECT id, parent_session_id FROM sessions ORDER BY created_at DESC").all() as any[];
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // The rotated session should point to the old session
    expect(sessions[0].parent_session_id).toBe(sessions[1].id);

    db.close();
    ctx.cleanup();
  }, 150_000);
});
