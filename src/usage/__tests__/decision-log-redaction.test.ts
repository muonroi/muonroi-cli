/**
 * Durable-sink redaction: `~/.muonroi-cli/usage/decision-log-<UTC>.jsonl`.
 *
 * `permission-mode.ts`'s `appendAudit` passes `meta: { context: event.context }`
 * verbatim, and `context.command` is the raw shell command the MODEL proposed. On
 * every yolo / permission override, an `export DEEPSEEK_API_KEY=…` or a
 * `curl -H "x-api-key: …"` was persisted here in plain text.
 *
 * Worth naming because the security notes in CLAUDE.md describe these audit
 * events as reaching the decision log with a "redacted cmd". No such redaction
 * existed anywhere in `src/` — the only thing the sandbox redacts is its
 * effective net/mounts (`pil/native-capabilities-workbook.ts:100`). The doc
 * promised a control that was never implemented, which is precisely the kind of
 * gap a written claim hides.
 *
 * `homeOverride` keeps the write inside a temp dir; the user's real
 * `~/.muonroi-cli` is never touched. Credentials are assembled AT RUNTIME so
 * `.husky/pre-commit`'s check-secrets.mjs stays honest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "../../utils/permission-mode.js";
import { appendDecisionLog, readDecisionLog } from "../decision-log.js";

function fakeProviderKey(): string {
  return ["sk", "proj"].join("-") + "-" + "d3c1si0n" + "V".repeat(26);
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

describe("appendDecisionLog — the audit trail never persists a credential verbatim", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-decisionlog-redact-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (err) {
      console.error(`[decision-log.test] temp dir cleanup failed for ${tmpHome}: ${(err as Error)?.message}`);
    }
  });

  function logFile(): string {
    return path.join(tmpHome, "usage", `decision-log-${todayUtc()}.jsonl`);
  }

  it("strips a key out of a model-proposed shell command in meta", async () => {
    const key = fakeProviderKey();

    await appendDecisionLog(
      {
        ts: Date.now(),
        sessionId: "sess-redact-1",
        kind: "yolo-override",
        taken: true,
        reason: "yolo-override for bash under yolo",
        meta: { context: { command: `curl -H "x-api-key: ${key}" https://api.example.com/v1/models` } },
      },
      tmpHome,
    );

    const persisted = fs.readFileSync(logFile(), "utf8");

    expect(persisted).not.toContain(key);
    // The audit must still say WHAT was approved and WHY.
    expect(persisted).toContain("yolo-override");
    expect(persisted).toContain("curl -H");
    expect(persisted).toContain("https://api.example.com/v1/models");
  });

  it("redacts an env-assignment command and keeps the row JSON-parseable", async () => {
    const key = "hf" + "_n0treal" + "T".repeat(26);

    await appendDecisionLog(
      {
        ts: Date.now(),
        sessionId: "sess-redact-2",
        kind: "permission-override",
        taken: true,
        reason: "permission-override for bash under auto-edit",
        meta: { context: { command: `export HF_TOKEN=${key} && bun run build` } },
      },
      tmpHome,
    );

    // readDecisionLog JSON.parses these lines back — a redaction that ate a
    // closing quote would silently empty the whole audit trail.
    const rows = await readDecisionLog(todayUtc(), tmpHome);
    expect(rows).toHaveLength(1);
    const cmd = (rows[0]!.meta as { context: { command: string } }).context.command;

    expect(cmd).not.toContain(key);
    expect(cmd).toBe("export HF_TOKEN=[REDACTED] && bun run build");
    expect(rows[0]!.kind).toBe("permission-override");
    expect(rows[0]!.taken).toBe(true);
  });

  it("covers the real appendAudit call path, not just a hand-built entry", async () => {
    const key = fakeProviderKey();

    // appendAudit is fire-and-forget and hardcodes the default home, so point
    // HOME at the temp dir for the duration.
    const savedHome = process.env.MUONROI_CLI_HOME;
    process.env.MUONROI_CLI_HOME = tmpHome;
    try {
      appendAudit({
        kind: "yolo-override",
        tool: "bash",
        mode: "yolo",
        context: { command: `export OPENAI_API_KEY=${key}` },
        ts: Date.now(),
      });
      // appendAudit intentionally does not await; drain the microtask + the fs IO.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      if (savedHome === undefined) delete process.env.MUONROI_CLI_HOME;
      else process.env.MUONROI_CLI_HOME = savedHome;
    }

    const persisted = fs.readFileSync(logFile(), "utf8");
    expect(persisted).not.toContain(key);
    expect(persisted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(persisted).toContain("yolo-override for bash under yolo");
  });
});
