/**
 * Security primitives for tui.start:
 *   - validateStartArgs: argv allowlist
 *   - sanitizeEnv: strip dangerous env vars
 *   - validateCwd: ensure cwd is under home or repo root
 *   - validateMockLlmPath: ensure mock-llm path stays within repo root
 *
 * Spawn injection contract (HarnessSpawn / HarnessSpawnResult):
 *   The MCP server accepts a HarnessSpawn callback at construction time so the
 *   core package has zero knowledge of the concrete TUI transport (OpenTUI
 *   fd 3/4, named pipes, WebSocket, …). The consumer (muonroi-cli) provides the
 *   spawn implementation via createMcpHarnessServer({ spawn }).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDriver, type Driver } from "./driver.js";
import { createEventTee } from "./event-tee.js";
import type { LiveEvent, LiveFrame, VisualFrame } from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

// ---------------------------------------------------------------------------
// Spawn injection contract
// ---------------------------------------------------------------------------

/**
 * The result returned by a HarnessSpawn implementation.
 * Both the POSIX fd-3/4 and Windows named-pipe transports satisfy this shape.
 */
export interface HarnessSpawnResult {
  /** The child process — only pid and kill() are required. */
  // biome-ignore lint: intentionally broad to avoid importing NodeJS.Signals here
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proc: { pid?: number; kill: (signal?: any) => boolean };
  /** Send a single newline-terminated JSON line on the input channel. */
  sendLine: (line: string) => void;
  /** Subscribe to newline-terminated JSON lines from the output channel. Returns an unsubscribe fn. */
  onLine: (cb: (line: string) => void) => () => void;
  /** Resolves with the exit code when the child process exits. */
  exited: Promise<number>;
}

/** Describes the sanitised spawn request the server hands to the injected spawn fn. */
export interface HarnessSpawnRequest {
  command: string;
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** A function that spawns a TUI process and returns transport streams. */
export type HarnessSpawn = (req: HarnessSpawnRequest) => Promise<HarnessSpawnResult>;

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

/**
 * Build the child TUI's environment for tui.start.
 *
 * Starts from the driver's own env so PATH/HOME survive, overlays the
 * caller-supplied keys, THEN strips the dangerous ones. The merge-before-strip
 * order keeps the security posture (NODE_OPTIONS/LD_PRELOAD/… still removed)
 * while guaranteeing PATH is present: bun drops the fd 3/4 stdio channels when a
 * child is spawned with a partial env that lacks PATH, which yields a null
 * inWrite and crashes the whole driver on spawn. `base` defaults to process.env
 * and is injectable for tests.
 */
export function buildChildEnv(
  callerEnv: Record<string, string> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) merged[k] = v;
  }
  return sanitizeEnv({ ...merged, ...callerEnv });
}

const REPO_ROOT = process.cwd();

/**
 * Opt-in extra cwd roots for tui.start, layered ON TOP of the default
 * {home, repo-root} allowlist. The posture stays deny-by-default: only roots an
 * operator has explicitly listed are added. Two union sources:
 *
 *   1. env `MUONROI_HARNESS_EXTRA_ROOTS` — a path list separated by the OS path
 *      separator (";" on win32, ":" elsewhere) and/or commas.
 *   2. `<REPO_ROOT>/.muonroi-harness-roots.json` — `{ "roots": string[] }`.
 *
 * Rationale: the drive-harness needs to dogfood sibling ecosystem repos (e.g.
 * `D:\sources\Core\*`) that live outside both home and the muonroi-cli checkout.
 * Without an explicit opt-in those cwds are rejected, which blocks real-task
 * evaluation. Clean checkouts have neither the env nor the (gitignored) config
 * file, so behaviour is identical to the original home+repo-only boundary.
 */
export function loadExtraRoots(): string[] {
  const roots: string[] = [];
  const envVal = process.env.MUONROI_HARNESS_EXTRA_ROOTS;
  if (envVal) {
    // Split on the OS path separator or commas. On win32 the separator is ";"
    // (not ":") so drive letters like "D:\..." stay intact.
    const listSep = process.platform === "win32" ? ";" : ":";
    for (const part of envVal.split(new RegExp(`[${listSep},]`))) {
      const trimmed = part.trim();
      if (trimmed) roots.push(trimmed);
    }
  }
  const cfgPath = resolve(REPO_ROOT, ".muonroi-harness-roots.json");
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as { roots?: unknown };
      if (Array.isArray(parsed.roots)) {
        for (const r of parsed.roots) {
          if (typeof r === "string" && r.trim()) roots.push(r.trim());
        }
      }
    } catch (err) {
      console.error(`[harness/mcp-server] failed to parse ${cfgPath}: ${(err as Error)?.message}`);
    }
  }
  return roots;
}

export function validateCwd(cwd: string): { ok: true } | { ok: false; reason: string } {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return { ok: false, reason: "cwd does not exist or unreadable" };
  }
  const sep = process.platform === "win32" ? "\\" : "/";
  const allowedRoots = [realpathSync(homedir()), realpathSync(REPO_ROOT)];
  for (const extra of loadExtraRoots()) {
    try {
      allowedRoots.push(realpathSync(extra));
    } catch (err) {
      console.error(`[harness/mcp-server] extra cwd root unresolved, skipping: ${extra} (${(err as Error)?.message})`);
    }
  }
  for (const root of allowedRoots) {
    if (real === root || real.startsWith(root + sep)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "cwd escapes home, repo root, and configured extra roots" };
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

const FEATURES = [
  "capabilities",
  "snapshot",
  "press",
  "type",
  "wait_for",
  "query",
  "expect",
  "render_text",
  "render_visual",
  "snapshot_visual",
  "cell",
  "visual_quality",
] as const;

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

  server.registerTool(
    "tui.render_visual",
    {
      description:
        "Render the ACTUAL rendered cell grid as plain text — the characters a human reads on screen. Unlike tui.render_text (semantic tree), this reflects the real render. Requires agent-mode with the renderer attached.",
      inputSchema: {},
    },
    async () => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: d.render_visual() }] };
    },
  );

  server.registerTool(
    "tui.snapshot_visual",
    {
      description:
        "Return the latest VisualFrame — the real rendered cell grid with per-cell char + fg/bg hex + attribute bits. null until the renderer emits one.",
      inputSchema: {},
    },
    async () => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: JSON.stringify(d.snapshot_visual()) }] };
    },
  );

  server.registerTool(
    "tui.cell",
    {
      description:
        "Decode the rendered cell at (row, col): char + fg/bg hex + attribute bits, from the latest VisualFrame. Use to assert the colors/formatting a human actually sees.",
      inputSchema: { row: z.number().int().min(0), col: z.number().int().min(0) },
    },
    async ({ row, col }) => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: JSON.stringify(d.visual_cell(row, col)) }] };
    },
  );

  server.registerTool(
    "tui.visual_quality",
    {
      description:
        "Heuristic visual-quality report over the rendered grid: near-empty-row ratio, blank-row runs, whitespace density, mojibake, a 0-100 score and issues[]. Catches 'messy render' the semantic tree cannot see.",
      inputSchema: {},
    },
    async () => {
      const d = getDriver();
      if (!d) return noDriver();
      return { content: [{ type: "text" as const, text: JSON.stringify(d.visual_quality()) }] };
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
      // Full protocol event set (minus the idle sentinel) so an external agent can
      // observe lifecycle events — council/sprint/route/askcard, not just toasts.
      // The Driver accepts any kind; this enum is the MCP-boundary validation.
      inputSchema: {
        kind: z.enum([
          "toast",
          "stream.delta",
          "llm-token",
          "llm-done",
          "council-step",
          "council-speaker",
          "council-turn-length",
          "askcard-open",
          "askcard-answered",
          "askcard-cancel",
          "sprint-stage",
          "sprint-halt",
          "sprint-plan-committed",
          "route-decision",
          "steer-inject",
          "usage",
          "grounding-flag",
          "ee-timeout",
          "ee-error",
          "stream-retry",
          "disconnect",
        ]),
      },
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the MCP harness server with an injected spawn implementation.
 *
 * The caller provides `spawn`, a function that satisfies HarnessSpawn.
 * The security boundary checks (argv allowlist, env strip, cwd containment,
 * mock-llm path containment, Windows guard) all remain here in core — they
 * are transport-agnostic policy and must not be bypassed.
 *
 * @example
 *   // In muonroi-cli/src/index.ts:
 *   const server = createMcpHarnessServer({ spawn: opentuiSpawn });
 *   await server.connect(new StdioServerTransport());
 */
export function createMcpHarnessServer({ spawn }: { spawn: HarnessSpawn }): McpServer {
  const server = new McpServer({ name: "muonroi-harness-driver", version: "0.1.0" });
  let currentDriver: Driver | null = null;
  let currentPid: number | undefined;
  const onStop = () => {
    currentDriver = null;
    currentPid = undefined;
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

      // --- Security boundary checks (must not be removed or bypassed) ---
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
      // See buildChildEnv: merge process.env (keeps PATH so bun allocates the
      // fd 3/4 transport) with caller keys, then strip dangerous vars.
      const sanitizedEnv = buildChildEnv(input.env ?? {});

      // Build final arg list.
      const finalArgs = [...input.args];
      if (input.mockLlmDir && !finalArgs.some((a) => a.startsWith("--mock-llm"))) {
        finalArgs.push("--mock-llm", input.mockLlmDir);
      }
      if (!finalArgs.includes("--agent-mode")) finalArgs.push("--agent-mode");

      const entry = `${process.cwd()}/src/index.ts`;

      // Delegate to the injected spawn implementation — the core package has no
      // knowledge of the concrete transport (fd 3/4, named pipes, WebSocket …).
      let spawnResult: HarnessSpawnResult;
      try {
        spawnResult = await spawn({
          command: "bun",
          argv: ["run", entry, ...finalArgs],
          env: sanitizedEnv,
          cwd: input.cwd,
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

      const { proc, sendLine, onLine } = spawnResult;

      const driver = createDriver({
        sendKey: (k: string) => sendLine(JSON.stringify({ op: "press", key: k })),
        sendType: (t: string) => sendLine(JSON.stringify({ op: "type", text: t })),
      });

      // Optional JSONL event sink for external milestone watchers (null unless
      // MUONROI_HARNESS_EVENT_LOG is set). Ephemeral kinds carry an at-emit
      // visual snapshot so flash events aren't lost before an agent wakes.
      const eventTee = createEventTee(() => driver.render_visual(), process.env["MUONROI_HARNESS_EVENT_LOG"]);

      // onLine already delivers complete newline-stripped lines — no extra
      // splitting required.
      const unsub = onLine(makeLineHandler(driver, eventTee));
      spawnResult.exited.then(() => {
        unsub();
        if (currentPid === proc.pid) {
          currentDriver = null;
          currentPid = undefined;
        }
      });

      currentDriver = driver;
      currentPid = proc.pid;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, pid: proc.pid }) }] };
    },
  );

  registerReadTools(server, () => currentDriver);
  registerActionTools(server, () => currentDriver);
  registerAsyncTools(server, () => currentDriver, { onStop });

  return server;
}

/**
 * Build the onLine sidechannel handler: parse each JSON line, ingest frames /
 * visuals / idle / events into the driver, and tee events to the optional JSONL
 * sink. Extracted (and exported) so the frame/event/tee wiring is unit-testable
 * without a live TUI or an MCP protocol handshake.
 *
 * @param driver   the driver to ingest into (only _ingest is used).
 * @param eventTee optional sink from createEventTee (null → no tee).
 */
export function makeLineHandler(
  driver: Pick<Driver, "_ingest">,
  eventTee: ((event: LiveEvent) => void) | null,
): (line: string) => void {
  return (line: string) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.mode === "live") driver._ingest({ kind: "frame", frame: msg as unknown as LiveFrame });
      else if (msg.mode === "visual") driver._ingest({ kind: "visual", frame: msg as unknown as VisualFrame });
      else if (msg.t === "idle") driver._ingest({ kind: "idle" });
      else if (msg.t === "event") {
        const event = msg as unknown as LiveEvent;
        driver._ingest({ kind: "event", event });
        // Tee AFTER ingest so render_visual reflects the frame at this event.
        eventTee?.(event);
      }
    } catch {
      // ignore malformed lines
    }
  };
}

/**
 * Run the MCP harness driver over stdio with the OpenTUI spawn implementation
 * injected by the consumer.
 *
 * @param spawn  A HarnessSpawn implementation that matches the HarnessSpawn contract.
 *               muonroi-cli passes opentuiSpawn; other consumers can provide their own.
 */
export async function runHarnessDriver(spawn: HarnessSpawn): Promise<void> {
  const server = createMcpHarnessServer({ spawn });
  await server.connect(new StdioServerTransport());
}
