/**
 * Security primitives for tui.start:
 *   - validateStartArgs: argv allowlist
 *   - sanitizeEnv: strip dangerous env vars
 *   - validateCwd: ensure cwd is under home or repo root
 *   - validateMockLlmPath: ensure mock-llm path stays within repo root
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDriver, type Driver } from "../agent-harness/driver.js";
import type { LiveEvent, LiveFrame } from "../agent-harness/protocol.js";
import { PROTOCOL_VERSION } from "../agent-harness/protocol.js";
import { createLineSplitter } from "../agent-harness/sidechannel.js";
import { spawnAgentTui } from "../agent-harness/test-spawn.js";

const ARG_ALLOW = /^(--agent-[a-z-]+(=.*)?|--mock-llm(=.+)?|--profile=[a-zA-Z0-9_-]+)$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_STRIP = new Set([
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_FRAMEWORK_PATH",
  "NODE_PATH",
]);

export function validateStartArgs(args: string[]): { ok: true } | { ok: false; bad: string } {
  for (const a of args) {
    if (!ARG_ALLOW.test(a)) return { ok: false, bad: a };
  }
  return { ok: true };
}

export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_STRIP.has(k)) continue;
    if (!ENV_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const REPO_ROOT = process.cwd();

export function validateCwd(cwd: string): { ok: true } | { ok: false; reason: string } {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return { ok: false, reason: "cwd does not exist or unreadable" };
  }
  const home = realpathSync(homedir());
  const root = realpathSync(REPO_ROOT);
  const sep = process.platform === "win32" ? "\\" : "/";
  if (real === home || real.startsWith(home + sep)) {
    return { ok: true };
  }
  if (real === root || real.startsWith(root + sep)) {
    return { ok: true };
  }
  return { ok: false, reason: "cwd escapes home and repo root" };
}

export function validateMockLlmPath(value: string): boolean {
  const resolved = isAbsolute(value) ? value : resolve(REPO_ROOT, value);
  let real: string;
  try {
    real = existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return false;
  }
  const root = realpathSync(REPO_ROOT);
  const sep = process.platform === "win32" ? "\\" : "/";
  return real === root || real.startsWith(root + sep);
}

const FEATURES = ["capabilities", "snapshot", "press", "type", "wait_for", "query", "expect", "render_text"] as const;

export function buildCapabilitiesPayload(): { protocol: string; features: readonly string[] } {
  return {
    protocol: PROTOCOL_VERSION,
    features: FEATURES,
  };
}

export function registerReadTools(server: McpServer, getDriver: () => Driver | null): void {
  const noDriver = () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ error: "no_driver", message: "Call tui.start first" }) }],
    isError: true,
  });

  server.registerTool("tui.snapshot", { description: "Return the latest LiveFrame.", inputSchema: {} }, async () => {
    const d = getDriver();
    if (!d) return noDriver();
    return { content: [{ type: "text" as const, text: JSON.stringify(d.snapshot()) }] };
  });

  server.registerTool(
    "tui.changes_since",
    {
      description: "Return current frame if seq > given seq, else null.",
      inputSchema: { seq: z.number().int().min(0) },
    },
    async ({ seq }) => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: JSON.stringify(d.changes_since(seq)) }] };
    },
  );

  server.registerTool(
    "tui.query",
    {
      description: "Return the single node matching selector (null if 0; throws on multi).",
      inputSchema: { selector: z.string().max(500) },
    },
    async ({ selector }) => {
      const d = getDriver();
      if (!d) return noDriver();
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(d.query(selector)) }] };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: "ambiguous", message: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tui.query_all",
    {
      description: "Return all nodes matching selector.",
      inputSchema: { selector: z.string().max(500) },
    },
    async ({ selector }) => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: JSON.stringify(d.queryAll(selector)) }] };
    },
  );

  server.registerTool(
    "tui.count",
    {
      description: "Return number of nodes matching selector.",
      inputSchema: { selector: z.string().max(500) },
    },
    async ({ selector }) => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: String(d.count(selector)) }] };
    },
  );

  server.registerTool(
    "tui.render_text",
    { description: "ASCII debug render of the current frame.", inputSchema: {} },
    async () => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: d.render_text() }] };
    },
  );
}

export function registerActionTools(server: McpServer, getDriver: () => Driver | null): void {
  const noDriver = () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ error: "no_driver", message: "Call tui.start first" }) }],
    isError: true,
  });

  server.registerTool(
    "tui.press",
    {
      description: "Send a single key to the TUI.",
      inputSchema: { key: z.string().max(64) },
    },
    async ({ key }) => {
      const d = getDriver();
      if (!d) return noDriver();
      d.press(key);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  server.registerTool(
    "tui.press_sequence",
    {
      description: "Send a sequence of keys to the TUI.",
      inputSchema: { keys: z.array(z.string().max(64)).max(100) },
    },
    async ({ keys }) => {
      const d = getDriver();
      if (!d) return noDriver();
      d.press_sequence(keys);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  server.registerTool(
    "tui.type",
    {
      description: "Type literal text into the focused element.",
      inputSchema: { text: z.string().max(10_000) },
    },
    async ({ text }) => {
      const d = getDriver();
      if (!d) return noDriver();
      d.type(text);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  server.registerTool(
    "tui.focus",
    {
      description: "Move focus to the node matched by selector (must match exactly one).",
      inputSchema: { selector: z.string().max(500) },
    },
    async ({ selector }) => {
      const d = getDriver();
      if (!d) return noDriver();
      try {
        d.focus(selector);
        return { content: [{ type: "text" as const, text: "ok" }] };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: "focus_failed", message: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );
}

export type AsyncToolDeps = {
  onStop: () => void;
};

export function registerAsyncTools(server: McpServer, getDriver: () => Driver | null, deps: AsyncToolDeps): void {
  const noDriver = () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ error: "no_driver", message: "Call tui.start first" }) }],
    isError: true,
  });

  const waitConditionShape = {
    selector: z.string().max(500).optional(),
    idle: z.boolean().optional(),
  };

  server.registerTool(
    "tui.wait_for",
    {
      description: "Wait until a selector matches or the TUI is idle (or both for all=).",
      inputSchema: {
        selector: z.string().max(500).optional(),
        idle: z.boolean().optional(),
        all: z.array(z.object(waitConditionShape)).max(10).optional(),
        timeoutMs: z.number().int().min(0).max(60_000).optional(),
      },
    },
    async (input) => {
      const d = getDriver();
      if (!d) return noDriver();
      try {
        await d.wait_for(input as Parameters<typeof d.wait_for>[0]);
        return { content: [{ type: "text" as const, text: "ok" }] };
      } catch (e) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: "timeout", message: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "tui.expect",
    {
      description: "Evaluate a predicate against the first node matched by selector.",
      inputSchema: { selector: z.string().max(500), predicate: z.unknown() },
    },
    async ({ selector, predicate }) => {
      const d = getDriver();
      if (!d) return noDriver();
      const ok = d.expect(selector, predicate);
      return { content: [{ type: "text" as const, text: String(ok) }] };
    },
  );

  server.registerTool(
    "tui.last_event",
    {
      description: "Return the most recent event of the given kind (null if none).",
      inputSchema: { kind: z.enum(["toast", "stream.delta"]) },
    },
    async ({ kind }) => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: JSON.stringify(d.last_event(kind)) }] };
    },
  );

  server.registerTool(
    "tui.stop",
    {
      description: "Stop the child TUI process.",
      inputSchema: {},
    },
    async () => {
      deps.onStop();
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );
}

export async function runHarnessDriver(): Promise<void> {
  const server = new McpServer({ name: "muonroi-harness-driver", version: "0.1.0" });
  let currentDriver: Driver | null = null;
  let childProc: ChildProcess | null = null;
  const onStop = () => {
    childProc?.kill();
    childProc = null;
    currentDriver = null;
  };

  server.registerTool(
    "tui.capabilities",
    {
      description: "Report the harness protocol version and supported feature list.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(buildCapabilitiesPayload()),
        },
      ],
    }),
  );

  server.registerTool(
    "tui.start",
    {
      description: "Spawn the muonroi-cli TUI in agent-mode with sanitized argv/env.",
      inputSchema: {
        args: z.array(z.string().max(200)).max(20),
        cwd: z.string().max(2000).optional(),
        env: z.record(z.string(), z.string()).optional(),
        mockLlmDir: z.string().max(500).optional(),
      },
    },
    async (input) => {
      if (currentDriver) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "already_started" }) }],
          isError: true,
        };
      }
      const argCheck = validateStartArgs(input.args);
      if (!argCheck.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "argv_rejected", bad: argCheck.bad }) }],
          isError: true,
        };
      }
      if (input.cwd) {
        const cwdCheck = validateCwd(input.cwd);
        if (!cwdCheck.ok) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ error: "cwd_rejected", reason: cwdCheck.reason }) },
            ],
            isError: true,
          };
        }
      }
      if (input.mockLlmDir && !validateMockLlmPath(input.mockLlmDir)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "mock_llm_rejected" }) }],
          isError: true,
        };
      }
      const sanitizedEnv = sanitizeEnv(input.env ?? {});

      // Build final arg list.
      const finalArgs = [...input.args];
      if (input.mockLlmDir && !finalArgs.some((a) => a.startsWith("--mock-llm"))) {
        finalArgs.push("--mock-llm", input.mockLlmDir);
      }
      if (!finalArgs.includes("--agent-mode")) finalArgs.push("--agent-mode");

      const entry = process.cwd() + "/src/index.ts";

      // Use the cross-platform spawn helper. On POSIX this uses fd 3/4;
      // on Windows it uses named pipes (MUONROI_HARNESS_OUT_PIPE / IN_PIPE).
      let spawnResult: Awaited<ReturnType<typeof spawnAgentTui>>;
      try {
        spawnResult = await spawnAgentTui([entry, ...finalArgs], {
          spawnOpts: {
            cwd: input.cwd,
            env: { ...sanitizedEnv },
            shell: false,
          },
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "spawn_failed", message: String(err) }),
            },
          ],
          isError: true,
        };
      }

      const { proc, inWrite, outRead } = spawnResult;

      const driver = createDriver({
        sendKey: (k: string) => {
          inWrite.write(JSON.stringify({ op: "press", key: k }) + "\n");
        },
        sendType: (t: string) => {
          inWrite.write(JSON.stringify({ op: "type", text: t }) + "\n");
        },
      });
      const splitter = createLineSplitter((line: string) => {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.mode === "live") driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
          else if (msg.t === "idle") driver._ingest({ kind: "idle" });
          else if (msg.t === "event") driver._ingest({ kind: "event", event: msg as unknown as LiveEvent });
        } catch {
          // ignore malformed lines
        }
      });
      outRead.on("data", (chunk: Buffer | string) => {
        splitter(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });

      currentDriver = driver;
      childProc = proc;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, pid: proc.pid }) }] };
    },
  );

  registerReadTools(server, () => currentDriver);
  registerActionTools(server, () => currentDriver);
  registerAsyncTools(server, () => currentDriver, { onStop });

  await server.connect(new StdioServerTransport());
}
