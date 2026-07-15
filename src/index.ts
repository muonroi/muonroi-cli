#!/usr/bin/env bun
// SECURITY: Redactor must be the FIRST import. installGlobalPatches() wraps
// console.* before any subsequent import side-effect or log can emit an API key.
// See: PROV-07, Pitfall 2 (HIGH severity API key leakage).
import { redactor } from "./utils/redactor.js";

redactor.installGlobalPatches();

import { readFileSync } from "node:fs";
import { InvalidArgumentError, program } from "commander";
import { createInterface } from "readline";

// Version is generated at build time by scripts/sync-version.cjs from
// package.json. Inlining as a constant avoids three failure modes:
//   - Node ESM rejecting `import pkg from "../package.json"` without assertion
//   - bun --compile virtual fs not resolving readFileSync paths
//   - Stripping package.json from published files list
import { PACKAGE_DESCRIPTION, PACKAGE_VERSION } from "./generated/version.js";

const packageJson = { version: PACKAGE_VERSION, description: PACKAGE_DESCRIPTION };

import { hydrateChatEnvFromKeychain } from "./chat/chat-keychain.js";
import { setRenderSink } from "./ee/render.js";
import {
  type CouncilAnswersFile,
  type CouncilAutoAnswerer,
  createHeadlessCouncilAutoAnswerer,
  handleCouncilChunk,
  parseCouncilAnswersFile,
} from "./headless/council-answers";
import {
  createHeadlessJsonlEmitter,
  createHeadlessTextEmitter,
  type HeadlessOutputFormat,
  isHeadlessOutputFormat,
  renderHeadlessPrelude,
} from "./headless/output";
import { loadCatalog, normalizeModelId } from "./models/registry.js";
// Plan 00-07: boot-order modules — AbortContext + PendingCallsLog (TUI-01, TUI-03, TUI-04).
import { createAbortContext } from "./orchestrator/abort.js";
import { completeDelegation, failDelegation, loadDelegation } from "./orchestrator/delegations";
import { Agent } from "./orchestrator/orchestrator";
import { createPendingCallsLog } from "./orchestrator/pending-calls.js";
import { loadKeyForProvider, setKeyForProvider } from "./providers/keychain.js";
import { detectProviderForModel } from "./providers/runtime.js";
import type { ProviderId } from "./providers/types.js";
import { loadConfig } from "./storage/config.js";
import { loadUsage } from "./storage/usage-cap.js";
import { startScheduleDaemon } from "./tools/schedule";
import type { StreamChunk } from "./types/index.js";
import { processAtMentions } from "./utils/at-mentions.js";
import { runScriptManagedUninstall } from "./utils/install-manager";
import type { PermissionMode } from "./utils/permission-mode.js";
import { getApiKey, getBaseURL, getCurrentModel, saveUserSettings } from "./utils/settings";
import { runUpdate } from "./utils/update-checker";
import { buildVerifyPrompt, getVerifyCliError } from "./verify/entrypoint";

// Hydrate chat secrets (no-op now: secrets live in the environment/env-store)
await hydrateChatEnvFromKeychain();

const exitCleanlyOnSigterm = () => {
  process.exit(0);
};

process.on("SIGTERM", exitCleanlyOnSigterm);

// Set true while the interactive TUI owns the terminal (raw mode + alternate
// screen). When it is mounted, writing to stdout/stderr corrupts OpenTUI's
// framebuffer and a process.exit(1) tears the whole UI down — surfacing to the
// user as "kicked out of the TUI". A single stray unhandledRejection (e.g. a
// slash handler whose DB read throws and rejects with no .catch) must not be
// allowed to do that; while _tuiActive is set we log to crash.log and keep the
// process alive. Headless / CLI paths keep the original fail-fast behaviour.
let _tuiActive = false;

export function setTuiActive(active: boolean): void {
  _tuiActive = active;
  (globalThis as Record<string, unknown>).__muonroiTuiActive = active;
}

export function appendCrashLog(label: string, msg: string): void {
  try {
    require("fs").appendFileSync(
      require("path").join(require("os").homedir(), ".muonroi-cli", "crash.log"),
      `[${new Date().toISOString()}] ${label}: ${msg}\n`,
    );
  } catch {
    /* crash.log is best-effort diagnostics; the logger itself must never throw */
  }
}

process.on("uncaughtException", (err) => {
  appendCrashLog("UNCAUGHT", err.stack || err.message);
  console.error("Fatal:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  appendCrashLog("REJECTION", msg);
  // TUI mounted → do NOT corrupt the framebuffer with console.error and do NOT
  // exit. The rejection is logged; the renderer stays up so the user keeps
  // their session (see slash-dispatch .catch handlers in app.tsx, which also
  // surface the failure in-band).
  if (_tuiActive) {
    return;
  }
  if (reason instanceof Error) {
    console.error("Unhandled rejection:", reason.stack || reason.message);
  } else if (reason && typeof reason === "object") {
    console.error("Unhandled rejection:", JSON.stringify(reason, Object.getOwnPropertyNames(reason)));
  } else {
    console.error("Unhandled rejection:", String(reason));
  }
  process.exit(1);
});

// ── EE render sink wiring (CQ-16a) ─────────────────────────────────────────
// Single-orchestrator-at-a-time invariant holds (no multi-session concurrency in v1.6).
// Sink routes experience_warning chunks into the active orchestrator's chat stream.
// When no active stream (headless / idle): drop silently — never leak to stderr in TUI.
let _activeEeYield: ((chunk: StreamChunk) => void) | null = null;

export function setActiveEeYield(fn: ((chunk: StreamChunk) => void) | null): void {
  _activeEeYield = fn;
}

setRenderSink((lineOrChunk) => {
  if (!_activeEeYield) return; // drop silently when no TUI active
  const chunk: StreamChunk =
    typeof lineOrChunk === "string"
      ? { type: "experience_warning" as StreamChunk["type"], content: lineOrChunk }
      : lineOrChunk;
  _activeEeYield(chunk);
});

/**
 * First-run wizard: prompts for API key interactively when none is configured.
 * Output goes to stderr so it doesn't pollute piped stdout.
 * Returns the trimmed key or null if user cancels / stdin is not a TTY.
 */
// Provider console URLs are sourced from providers/capabilities.ts via ProviderCapabilities.consoleSignupURL().

/**
 * Try to find an API key for the model the CLI is about to run with.
 * Resolution: per-provider env var (env-store), else OAuth sentinel.
 * Returns null if nothing usable is configured anywhere.
 */
async function resolveKeyForModel(modelId: string): Promise<string | null> {
  // Test escape hatch: harness specs that need to assert the API-key modal
  // appearance (api-key.spec.ts) set MUONROI_TEST_NO_KEYCHAIN=1 to suppress
  // the dev machine's real keychain entry from masking the unauthenticated
  // boot path. Honoured ONLY in tests — never read in production flows.
  if (process.env.MUONROI_TEST_NO_KEYCHAIN === "1") return null;
  const provider = detectProviderForModel(modelId);
  try {
    const k = await loadKeyForProvider(provider);
    if (k) return k;
  } catch {
    /* fall through to wizard */
  }
  return null;
}

/**
 * True when the active model's provider is authenticated via OAuth tokens
 * (subscription login) instead of an API key. Lets the boot flow skip the
 * first-run wizard for OAuth-only setups like a freshly logged-in ChatGPT
 * subscription.
 */
async function hasOAuthForModel(modelId: string): Promise<boolean> {
  if (process.env.MUONROI_TEST_NO_KEYCHAIN === "1") return false;
  const provider = detectProviderForModel(modelId);
  try {
    const { getOAuthProviderConfig } = await import("./providers/auth/registry.js");
    const cfg = await getOAuthProviderConfig(provider);
    if (!cfg) return false;
    const tokens = await cfg.loadTokensWithRefresh();
    return !!tokens?.accessToken;
  } catch {
    return false;
  }
}

async function startInteractive(
  apiKey: string | undefined,
  baseURL: string,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  session?: string,
  initialMessage?: string,
  permissionMode: PermissionMode = "safe",
  injectHalt = false,
  injectHaltSprint = false,
) {
  // ── Plan 00-07 boot order ──────────────────────────────────────────────────
  // 1. redactor.installGlobalPatches() — already at top of file (line 6).
  // 2. loadConfig + loadUsage (validates storage paths, logs usage cap state).
  const [config, usage] = await Promise.all([loadConfig(), loadUsage()]);
  void config; // Phase 0: plumbed but not yet surfaced in TUI status bar (TUI-05, Phase 1).
  void usage; // Phase 0: same — cap guard will gate on this in plan 00-06+ / Phase 1.

  // 3. Load API key for the active provider — enrolls into redactor.
  const activeModel = getCurrentModel();
  const activeProvider = detectProviderForModel(activeModel);
  const providerKey = await loadKeyForProvider(activeProvider).catch(() => undefined);
  void providerKey; // Agent also loads key internally; this run is for early redactor enrollment.

  // Web-research migration prompt — runs once per install for existing users
  // who never saw the first-run wizard's research step. Skip in non-interactive
  // mode (--prompt, --verify, headless harnesses).
  if (process.stdin.isTTY) {
    try {
      const { loadUserSettings } = await import("./utils/settings.js");
      if (loadUserSettings().webResearchPrompted !== true) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
        try {
          const { runResearchMigrationPrompt } = await import("./mcp/research-onboarding.js");
          await runResearchMigrationPrompt({
            askChoice: ask,
            askText: ask,
            log: (m) => process.stderr.write(m),
          });
        } finally {
          rl.close();
        }
      }
    } catch (err) {
      process.stderr.write(`\nWarning: research migration prompt failed: ${(err as Error).message}\n`);
    }
  }

  // 5-6. createPendingCallsLog + createAbortContext — wired before Agent so
  //       the Agent receives them via AgentOptions (Pitfall 9, TUI-04).
  //   Session ID is not available until Agent opens SQLite; use a stable
  //   pre-session sentinel "pre-session" for the pending-calls log.
  //   After Agent is constructed we promote to the real session ID.
  const orchestratorAbort = createAbortContext();

  // 7. SIGINT handler — must be registered BEFORE mountTUI so Ctrl+C fires
  //    abort before OpenTUI's own handler chains.  The handler is non-blocking:
  //    it only sets the abort signal; OpenTUI's teardown flushes terminal state
  //    on its own reconciler path.
  process.on("SIGINT", () => {
    orchestratorAbort.abort("SIGINT");
    // OpenTUI will receive its own SIGINT / Ctrl+C via exitOnCtrlC:false;
    // onExit below handles the cleanup sequence.
  });

  // ── Construct Agent (opens SQLite, loads transcript, wires abort + pending) ─
  // PendingCallsLog: use session selector as provisional ID; Agent will have
  // the real session ID after construction.
  const provisionalSessionId = session ?? "latest";
  const pendingCalls = createPendingCallsLog(provisionalSessionId);
  // Reconcile any orphaned .tmp files from a prior crash (Pitfall 9).
  const reconciled = await pendingCalls.reconcile();
  if (reconciled.abandoned > 0) {
    console.warn(`[muonroi-cli] reconciled ${reconciled.abandoned} abandoned tool calls from prior session`);
  }

  const { warmMcpClients } = await import("./mcp/client-pool.js");
  const { loadMcpServers } = await import("./utils/settings.js");
  await warmMcpClients(loadMcpServers(), !session);

  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    batchApi,
    abortContext: orchestratorAbort,
    pendingCalls,
    permissionMode,
  });
  // ── /Plan 00-07 boot order ────────────────────────────────────────────────

  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { createElement } = await import("react");
  const { App } = await import("./ui/app");
  const { relaunchWithSession } = await import("./ui/utils/relaunch");

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // OpenTUI defaults openConsoleOnError:true — its process-level
    // unhandledRejection/uncaughtException handler then calls console.show(),
    // which focuses the debug console overlay and captures ALL keypresses.
    // The overlay's keybindings have no hide/close action, so a stray rejection
    // (e.g. a provider dropping a streaming socket) traps the user in a console
    // they cannot dismiss. We surface errors in-band instead — keep it off.
    // Toggle it deliberately with F12 (wired below).
    openConsoleOnError: false,
    // We manage SIGINT ourselves (orchestrator abort → agent cleanup → renderer destroy).
    // Prevent OpenTUI from registering its own SIGINT/SIGTERM handler which would
    // call renderer.destroy() prematurely and race with our orderly shutdown.
    exitSignals: [],
    // Lets terminals (Kitty, iTerm2, WezTerm, …) report Command as `super` on KeyEvent — needed for ⌘C in the TUI.
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
    },
  });

  // Agent-mode: hand the renderer to the harness so it can snapshot the ACTUAL
  // rendered cell grid (colors + attributes) via VisualFrame, not just the
  // semantic tree. No-op outside agent-mode (runtime undefined).
  {
    const agentRt = (globalThis as Record<string, unknown>).__muonroiAgentRuntime as
      | { attachRenderer?: (r: unknown) => void }
      | undefined;
    agentRt?.attachRenderer?.(renderer);
  }

  // The TUI now owns the terminal — route fatal-handler behaviour away from
  // process.exit(1) (see the unhandledRejection handler above). Cleared in
  // restoreTerminalSync() the moment we begin tearing the terminal back down.
  setTuiActive(true);

  // Deliberate debug-console toggle. With openConsoleOnError:false the overlay
  // never auto-pops, so F12 is the ONLY way in — and, crucially, back out:
  // console.toggle() hides it when it is visible+focused, so it can never trap.
  try {
    renderer.keyInput?.on("keypress", (key: { name?: string }) => {
      if (key?.name === "f12") renderer.console.toggle();
    });
  } catch {
    /* keyInput/console are best-effort dev affordances — never block boot */
  }

  /**
   * Restore terminal to main-screen mode before the process exits.
   *
   * On some terminals (WezTerm, especially under MINGW64/Git Bash), the native
   * destroyRenderer() call inside renderer.destroy() does not reliably flush
   * the Kitty-keyboard-disable and alternate-screen-exit escape sequences
   * before process.exit() kills the runtime.  This leaves the terminal in a
   * half-restored state where subsequent shell output is interpreted as raw
   * escape codes, producing the "jumping numbers" effect.
   *
   * The fix explicitly writes the restore sequences from JS and adds a brief
   * flush delay before process.exit().
   */
  function restoreTerminalSync(): void {
    // Terminal is being handed back — restore fail-fast crash behaviour so a
    // throw during/after teardown still exits cleanly instead of hanging.
    setTuiActive(false);
    try {
      // 1. Disable Kitty keyboard protocol if enabled.
      if (typeof (renderer as any).disableKittyKeyboard === "function") {
        (renderer as any).disableKittyKeyboard();
      }
      // 2. Restore terminal modes (bracketed paste, cursor, etc.).
      if (typeof (renderer as any).lib?.restoreTerminalModes === "function") {
        (renderer as any).lib.restoreTerminalModes((renderer as any).rendererPtr);
      }
    } catch {
      // best-effort — terminal restore must never throw
    }
  }

  // WezTerm closes the pane/window when the foreground process exits.
  // Detect WezTerm via env vars and hold the process open briefly so the
  // user can see the terminal before the window disappears.
  const isWezTerm =
    !!process.env.WEZTERM_PANE ||
    !!process.env.WEZTERM_EXECUTABLE ||
    !!process.env.WEZTERM_CONFIG_FILE ||
    !!process.env.WEZTERM_UNIX_SOCKET ||
    process.env.TERM_PROGRAM === "WezTerm" ||
    process.env.TERM_PROGRAM === "wezterm" ||
    process.env.MUONROI_FORCE_SHELL_HOLD === "1";

  // Restore the terminal to a clean main-screen state: undo Kitty keyboard,
  // raw mode, mouse tracking, bracketed paste, and alt-screen. Shared by the
  // /exit path AND the session-resume relaunch — a relaunch that skips this
  // leaves the child (and, once the parent exits, the shell) with a terminal
  // still in mouse-tracking/alt-screen mode, so stray escape bytes get parsed
  // by the shell as a bogus command ("'…' is not recognized … operable
  // program or batch file").
  function restoreTerminalForHandoff(): void {
    // Restore terminal state from JS before the native destroyRenderer runs
    restoreTerminalSync();

    renderer.destroy();

    // Use synchronous writes to stdout's underlying fd so escape codes flush
    // before the child inherits stdin — async process.stdout.write() can buffer
    // past the spawn() boundary, leaving the terminal in mouse-tracking mode.
    const writeSync = (seq: string) => {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        fs.writeSync(1, seq);
      } catch {
        /* fall back to async */
        try {
          process.stdout.write(seq);
        } catch {
          /* noop */
        }
      }
    };
    try {
      // 1. Take stdin out of raw mode + pause it so no buffered keystrokes
      //    (or in-flight mouse-event bytes) hit the child.
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* noop */
        }
      }
      try {
        process.stdin.pause();
      } catch {
        /* noop */
      }
      try {
        (process.stdin as unknown as { unref?: () => void }).unref?.();
      } catch {
        /* noop */
      }
      // 2. Disable extended-coords first (1006/1015/1005), then the basic
      //    tracking modes (1003→1002→1000). Wrong order leaves the terminal
      //    emitting SGR-formatted events after the base modes are off.
      writeSync("\x1B[?1006l\x1B[?1015l\x1B[?1005l");
      writeSync("\x1B[?1003l\x1B[?1002l\x1B[?1000l");
      writeSync("\x1B[?2004l\x1B[?25h"); // bracketed paste off, cursor on
      writeSync("\x1B[?1049l\x1B[0m\x1B[!p"); // exit alt-screen, reset SGR, soft reset
    } catch {
      // best-effort
    }
  }

  // Resume a different session by restarting the CLI bound to --session <id>.
  // Routes through the SAME teardown as /exit, then supervises the child so the
  // shell never reclaims the foreground mid-restart (which corrupted the
  // terminal and dropped the user back to a broken prompt).
  const onRelaunch = (sessionId: string) => {
    void agent.cleanup().finally(() => {
      restoreTerminalForHandoff();
      // Let the terminal process the restore sequences before the child takes
      // over stdin (mirrors the /exit shell-hold timing).
      setTimeout(() => {
        try {
          relaunchWithSession(sessionId, { supervise: true });
        } catch (err) {
          console.error(`[relaunch] failed: ${(err as Error)?.message ?? err}`);
          process.exit(1);
        }
      }, 80);
    });
  };

  const onExit = () => {
    void agent.cleanup().finally(() => {
      restoreTerminalForHandoff();
      const writeSync = (seq: string) => {
        try {
          (require("node:fs") as typeof import("node:fs")).writeSync(1, seq);
        } catch {
          try {
            process.stdout.write(seq);
          } catch {
            /* noop */
          }
        }
      };

      // WezTerm (and similar single-pane terminals) closes the window when
      // the foreground process exits. To keep the pane usable after `/exit`,
      // we hand control over to an interactive shell instead of exiting.
      // Disable with MUONROI_NO_SHELL_HOLD=1.
      const holdMode = process.env.MUONROI_NO_SHELL_HOLD === "1" ? "exit" : isWezTerm ? "shell" : "exit";
      if (holdMode === "shell") {
        // Defer spawn so the disable sequences are processed by the terminal
        // BEFORE the child shell takes over stdin. Without this, the child
        // can race with the in-flight disable codes and inherit a still-
        // mouse-tracking terminal (visible as "35;145;26M" garbage at the
        // shell prompt when the user moves the mouse).
        setTimeout(() => {
          try {
            const { spawn } = require("node:child_process") as typeof import("node:child_process");
            const isWin = process.platform === "win32";
            const shellCmd =
              process.env.MUONROI_EXIT_SHELL ||
              process.env.SHELL ||
              (isWin ? process.env.COMSPEC || "cmd.exe" : "/bin/bash");
            writeSync("\nSession ended. Returning to shell — type `exit` to close this pane.\n\n");
            const child = spawn(shellCmd, [], { stdio: "inherit", shell: false });
            child.on("exit", (code) => process.exit(code ?? 0));
            child.on("error", () => process.exit(0));
          } catch {
            setTimeout(() => process.exit(0), 16);
          }
        }, 80);
      } else {
        // Give the OS a tick to flush stdout before we exit.
        setTimeout(() => process.exit(0), 16);
      }
    });
  };

  createRoot(renderer).render(
    createElement(App, {
      agent,
      startupConfig: {
        apiKey,
        baseURL,
        model: agent.getModel(),
        sandboxMode: "off",
        sandboxSettings: {},
        maxToolRounds,
        version: packageJson.version,
        injectHalt,
        injectHaltSprint,
      },
      initialMessage,
      onExit,
      onRelaunch,
    }),
  );
}

async function runHeadless(
  prompt: string,
  apiKey: string,
  baseURL: string,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  format: HeadlessOutputFormat,
  session?: string,
  permissionMode: PermissionMode = "safe",
  councilAutoAnswer?: CouncilAutoAnswerer | null,
) {
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    batchApi,
    permissionMode,
  });
  const prelude = renderHeadlessPrelude(format, agent.getSessionId() || undefined);
  if (prelude.stdout) process.stdout.write(prelude.stdout);
  if (prelude.stderr) process.stderr.write(prelude.stderr);

  function writeSafe(stream: NodeJS.WriteStream, data: string): void {
    try {
      stream.write(data);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
      throw e;
    }
  }

  // Council askcards have no TUI to render them in headless mode. When
  // auto-answer is enabled, resolve the responder promises with either the
  // scripted answer or `defaultIndex` — otherwise the process hangs forever.
  const councilSink = {
    respondToQuestion: (id: string, a: string) => agent.respondToCouncilQuestion(id, a),
    respondToPreflight: (id: string, ok: boolean) => agent.respondToCouncilPreflight(id, ok),
  };
  function maybeAutoAnswer(chunk: {
    type: string;
    councilQuestion?: import("./types/index.js").CouncilQuestionData;
    councilPreflight?: { preflightId: string };
  }): void {
    const auditLine = handleCouncilChunk(chunk, councilAutoAnswer ?? null, councilSink);
    if (auditLine) writeSafe(process.stderr, `${auditLine}\n`);
  }

  try {
    const { enhancedMessage } = processAtMentions(prompt, process.cwd());

    if (format === "json") {
      const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(agent.getSessionId() || undefined);
      for await (const chunk of agent.processMessage(enhancedMessage, observer)) {
        maybeAutoAnswer(chunk);
        const writes = consumeChunk(chunk);
        if (writes.stdout) writeSafe(process.stdout, writes.stdout);
        if (writes.stderr) writeSafe(process.stderr, writes.stderr ?? "");
      }
      const tail = flush();
      if (tail.stdout) writeSafe(process.stdout, tail.stdout);
      if (tail.stderr) writeSafe(process.stderr, tail.stderr ?? "");
      return;
    }

    const textEmitter = createHeadlessTextEmitter();
    for await (const chunk of agent.processMessage(enhancedMessage)) {
      maybeAutoAnswer(chunk);
      const writes = textEmitter.consumeChunk(chunk);
      if (writes.stdout) writeSafe(process.stdout, writes.stdout);
      if (writes.stderr) writeSafe(process.stderr, writes.stderr);
    }
    const textTail = textEmitter.flush();
    if (textTail.stdout) writeSafe(process.stdout, textTail.stdout);
    if (textTail.stderr) writeSafe(process.stderr, textTail.stderr ?? "");
  } finally {
    await agent.cleanup();
  }
}

function loadCouncilAnswersOrExit(filePath: string): CouncilAnswersFile {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parseCouncilAnswersFile(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot load --council-answers file "${filePath}": ${msg}`);
    process.exit(1);
  }
}

function changeDirectoryOrExit(directory: string | undefined) {
  if (!directory) {
    return;
  }

  try {
    process.chdir(directory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot change to directory ${directory}: ${msg}`);
    process.exit(1);
  }
}

type CliOptions = Record<string, string | boolean | undefined>;

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function runBackgroundDelegation(jobPath: string, options: CliOptions) {
  let output = "";
  let agent: Agent | undefined;

  try {
    const delegation = await loadDelegation(jobPath);

    const baseURL = stringOption(options.baseUrl) || getBaseURL();
    const explicitModel = stringOption(options.model) || delegation.model;
    const model = explicitModel ? normalizeModelId(explicitModel) : undefined;

    // Resolve API key: explicit flag > legacy env/settings.apiKey > per-provider keychain
    // (matches the foreground flow — delegations were previously broken when the user
    // only had a per-provider key in the environment, e.g. deepseek.)
    let apiKey = stringOption(options.apiKey) || getApiKey();
    if (!apiKey) {
      const modelForResolve = model ?? delegation.model ?? getCurrentModel("agent");
      const keychainKey = await resolveKeyForModel(modelForResolve);
      if (keychainKey) {
        apiKey = keychainKey;
      } else if (await hasOAuthForModel(modelForResolve)) {
        apiKey = "oauth";
      }
    }
    if (!apiKey) {
      throw new Error(
        "API key required. Set MUONROI_API_KEY, use --api-key, save it to ~/.muonroi-cli/user-settings.json, " +
          "or run 'muonroi-cli keys login <provider>' for subscription OAuth.",
      );
    }
    const maxToolRounds =
      parseInt(stringOption(options.maxToolRounds) || String(delegation.maxToolRounds), 10) || delegation.maxToolRounds;
    agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
      persistSession: false,
      batchApi: Boolean(delegation.batchApi ?? options.batchApi === true),
    });
    const result = await agent.runTaskRequest({
      agent: delegation.agent,
      description: delegation.description,
      prompt: delegation.prompt,
    });

    output = (result.output || "").trim();

    if (!result.success) {
      await failDelegation(jobPath, result.output || result.error || "Background delegation failed.", output);
      return;
    }

    await completeDelegation(jobPath, output, result.task?.summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await failDelegation(jobPath, msg, output);
    } catch {
      // Best effort — background tasks should fail silently if persistence is unavailable.
    }
    process.exit(1);
  } finally {
    await agent?.cleanup();
  }
}

async function persistApiKeyToKeychain(rawKey: string, modelHint?: string): Promise<boolean> {
  const provider = detectProviderForModel(modelHint ?? getCurrentModel("agent"));
  try {
    return await setKeyForProvider(provider, rawKey);
  } catch {
    return false;
  }
}

function resolveConfig(options: CliOptions) {
  const apiKey = stringOption(options.apiKey) || getApiKey();
  const baseURL = stringOption(options.baseUrl) || getBaseURL();
  const explicitModel = stringOption(options.model);
  const model = explicitModel ? normalizeModelId(explicitModel) : undefined;
  // PIL-L6 v2 — default cap lowered 400 → 100 after session 127140a47b56
  // (a single debug turn ran 275 LLM calls over 21 min, $0.63 cost, never
  // converged). 100 rounds still covers legitimate multi-file refactor/debug
  // work; runaway loops abort with the "Reached max tool rounds" error
  // surface so the user can adjust scope. Override via --max-tool-rounds CLI
  // flag or MUONROI_MAX_TOOL_ROUNDS env.
  const maxToolRounds = parseInt(stringOption(options.maxToolRounds) || "100", 10) || 100;

  if (typeof options.apiKey === "string" && process.env.MUONROI_TEST_NO_PERSIST !== "1") {
    // Persist to the env-store (per-provider) instead of plaintext settings.json.
    // Fire-and-forget: env-store write is sync; the key is also set in process.env so it
    // works for this run via `apiKey` above and the user can re-supply it next invocation.
    void persistApiKeyToKeychain(options.apiKey, stringOption(options.model)).catch(() => {});
  }
  if (typeof options.model === "string") saveUserSettings({ defaultModel: normalizeModelId(options.model) });

  return { apiKey, baseURL, model, maxToolRounds };
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    console.error(
      "Error: API key required. Set MUONROI_API_KEY env var, use --api-key, or save to ~/.muonroi-cli/user-settings.json",
    );
    process.exit(1);
  }

  return apiKey;
}

function parseHeadlessOutputFormat(value: string): HeadlessOutputFormat {
  if (isHeadlessOutputFormat(value)) {
    return value;
  }

  throw new InvalidArgumentError(`Invalid headless format "${value}". Expected "text" or "json".`);
}

program
  .name("muonroi-cli")
  .description("AI coding agent — built with Bun and OpenTUI")
  .version(packageJson.version)
  .argument("[message...]", "Initial message to send")
  .option("-k, --api-key <key>", "API key")
  .option("-u, --base-url <url>", "API base URL")
  .option("-m, --model <model>", "Model to use")
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("-p, --prompt <prompt>", "Run a single prompt headlessly")
  .option("--verify", "Run the built-in verify flow headlessly")
  .option("--format <format>", "Headless output format: text or json", parseHeadlessOutputFormat, "text")
  .option("-s, --session <id>", "Continue a saved session by id, or use 'latest'")
  .option("--background-task-file <path>", "Run a persisted background delegation")
  .option("--max-tool-rounds <n>", "Max tool execution rounds (ultimate runaway safety net)", "120")
  .option("--batch-api", "Use xAI Batch API for model calls (async, lower cost)")
  .option(
    "--permission <mode>",
    "Permission mode: safe (confirm all), auto-edit (auto-approve file ops), yolo (auto-approve all)",
    "safe",
  )
  .option("-y, --yes", "Headless: auto-answer council askcards with their default option and approve preflights")
  .option("--council-answers <file>", "Headless: JSON file with scripted council answers per phase (FIFO)")
  .option("--update", "Update muonroi-cli to the latest version and exit")
  .option("--smoke-boot-only", "CI smoke: validate loadConfig + loadUsage and exit 0 — no keychain access")
  .option("--agent-mode", "Enable agent harness mode (JSONL sidechannel)")
  .option("--agent-cols <n>", "Terminal columns in agent-mode", (v) => parseInt(v, 10), 120)
  .option("--agent-rows <n>", "Terminal rows in agent-mode", (v) => parseInt(v, 10), 40)
  .option("--agent-idle-ms <n>", "Idle quiescence window (ms)", (v) => parseInt(v, 10), 50)
  .option("--agent-fake-clock", "Use deterministic frame-counter clock")
  .option("--mock-llm <dir>", "Use fixture-based mock LLM from <dir> instead of real provider (E2E testing)")
  .option("--inject-halt", "TEST SEAM: render a synthetic halt recovery card after boot (harness E2E only)")
  .option(
    "--inject-halt-sprint",
    "TEST SEAM: render a synthetic sprint-failed recovery card after boot (harness E2E only)",
  )
  .action(async (message: string[], options) => {
    // Agent-mode: start the sidechannel runtime BEFORE any TUI or model work.
    // The runtime is exposed on globalThis so the renderer wiring (Task 1.6c)
    // can pick it up without a direct import dependency.
    if (options.agentMode) {
      const { startAgentMode } = await import("@muonroi/agent-harness-opentui");
      const runtime = await startAgentMode({
        cols: options.agentCols as number,
        rows: options.agentRows as number,
        idleMs: options.agentIdleMs as number,
        fakeClock: !!options.agentFakeClock,
      });
      (globalThis as Record<string, unknown>).__muonroiAgentRuntime = runtime;
    }

    // Mock-LLM: load fixture directory and inject into globalThis BEFORE any
    // provider call. Dynamic import keeps startup lean when flag is absent.
    if (typeof options.mockLlm === "string") {
      const { createMockLlm } = await import("@muonroi/agent-harness-core/mock-llm");
      (globalThis as Record<string, unknown>).__muonroiMockLlm = createMockLlm({ dir: options.mockLlm });

      // Phase H1: AI-SDK-level mock. If any fixture declares a `model` block
      // it is installed so `resolveModelRuntime` returns it instead of the
      // real provider model. This enables cost-leak verification (G1, F1,
      // B3/B4, C1) through the orchestrator's streamText path.
      //
      // Failure mode (silent until 2026-05-26): the original
      // `.catch(() => null)` swallowed every load error — directory
      // missing, JSON parse fail, no `model` block in any file — and
      // the orchestrator silently fell back to the real provider, which
      // failed because tests use a FAKE_KEY. The dump file then contained
      // `[]`, producing the cryptic "expected 0 to be greater than or
      // equal to 3" failures in cost-leak-b3/b4 TUI specs. Logging every
      // failure path makes the root cause visible in CI stderr.
      const { loadMockModelFromDir } = await import("./agent-harness/mock-model.js");
      const modelHandle = await loadMockModelFromDir(options.mockLlm).catch((err) => {
        process.stderr.write(
          `[muonroi-cli] mock-llm: loadMockModelFromDir(${options.mockLlm}) threw: ${
            err instanceof Error ? `${err.name}: ${err.message}` : String(err)
          }\n`,
        );
        return null;
      });
      if (!modelHandle) {
        // The user explicitly passed `--mock-llm <dir>` — they EXPECT the
        // mock to be installed. Silent fallback to the real provider is the
        // wrong default for test environments. Refuse to continue so the
        // failure is loud, not a dump full of zero calls.
        process.stderr.write(
          `[muonroi-cli] mock-llm: no fixture in ${options.mockLlm} declared a {model:...} block — refusing to fall back to real provider. ` +
            `Verify the fixture JSON has a top-level "model" key with a "stream" array.\n`,
        );
        // Exit code chosen to differ from the AI SDK's typical 1/2 so test
        // harnesses can distinguish "mock didn't install" from "test
        // assertion failed". 78 = EX_CONFIG per BSD sysexits.
        process.exit(78);
      }
      if (modelHandle) {
        // Install all three globals atomically so the runtime sees a
        // consistent picture: model + the OAuth-registry-equivalent
        // unsupportedParams / defaultProviderOptions parsed from the fixture.
        const g = globalThis as Record<string, unknown>;
        g.__muonroiMockModel = modelHandle.model;
        g.__muonroiMockUnsupportedParams = modelHandle.unsupportedParams;
        g.__muonroiMockDefaultProviderOptions = modelHandle.defaultProviderOptions;

        // Phase H3 — exfiltrate recordings to a file at exit so the parent
        // vitest spec can assert across the child-process boundary. Activated
        // only when MUONROI_MOCK_MODEL_DUMP is set; otherwise no-op.
        const dumpPath = process.env.MUONROI_MOCK_MODEL_DUMP;
        if (typeof dumpPath === "string" && dumpPath.length > 0) {
          const { dumpRecordings } = await import("./agent-harness/mock-model.js");
          let dumped = false;
          const doDump = (): void => {
            if (dumped) return;
            dumped = true;
            try {
              dumpRecordings(dumpPath, modelHandle.model);
            } catch (err) {
              // Last-ditch: surface on stderr so the parent test can see why.
              process.stderr.write(`[muonroi-cli] dumpRecordings failed: ${String(err)}\n`);
            }
          };
          // Continuous dump: write after every streamText completes so tests
          // can read the dump without relying on a graceful exit handler. On
          // Windows + Bun + named pipes, `process.on("exit")` handlers may
          // not fire when process.exit() is called from deep async chains
          // (observed empirically — exit event reaches the parent, but the
          // exit-handler callbacks in the child never run). Patching
          // doStream guarantees the dump exists after at least one call.
          const writeDumpAlways = (): void => {
            try {
              dumpRecordings(dumpPath, modelHandle.model);
            } catch {
              // ignore — best-effort
            }
          };
          const origDoStream = modelHandle.model.doStream.bind(modelHandle.model);
          modelHandle.model.doStream = async (options: unknown) => {
            // biome-ignore lint/suspicious/noExplicitAny: AI SDK call options
            const r = await origDoStream(options as any);
            writeDumpAlways();
            return r;
          };
          process.on("exit", doDump);
          process.on("SIGINT", () => {
            doDump();
            process.exit(130);
          });
          process.on("SIGTERM", () => {
            doDump();
            process.exit(143);
          });
        }
      }
    }

    // CI smoke affordance — exit cleanly WITHOUT invoking the provider.
    // Deliberately exits BEFORE provider key loading — CI runners have no keychain configured.
    if (options.smokeBootOnly) {
      const [_cfg, _usg] = await Promise.all([loadConfig(), loadUsage()]);
      console.log("[muonroi-cli] smoke-boot-only — config + usage loaded; exiting 0.");
      process.exit(0);
    }

    if (options.update) {
      console.log("Checking for updates...");
      const result = await runUpdate(packageJson.version);
      console.log(result.output);
      process.exitCode = result.success ? 0 : 1;
      return;
    }

    changeDirectoryOrExit(options.directory);

    // Boot model registry BEFORE any key resolution path runs —
    // detectProviderForModel consults the catalog's alias map to route model
    // ids to the correct provider. With an empty registry it falls back to a
    // prefix match and the CLI may load the wrong provider's key. Affects both
    // runBackgroundDelegation and the main interactive/headless path below.
    let catalogLoadFailed = false;
    await loadCatalog().catch(() => {
      catalogLoadFailed = true;
    });

    // Load the env-store (~/.muonroi-cli/.env) into process.env and migrate any
    // legacy keychain/settings keys BEFORE any key resolution. Best-effort.
    try {
      const { loadEnvFileIntoProcess } = await import("./providers/env-store.js");
      loadEnvFileIntoProcess();
      const { migrateLegacyKeysToEnv } = await import("./providers/keychain.js");
      await migrateLegacyKeysToEnv();
    } catch (err) {
      console.error(`[muonroi-cli] env-store init failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (options.backgroundTaskFile) {
      await runBackgroundDelegation(options.backgroundTaskFile, options);
      return;
    }

    const config = resolveConfig(options);

    // One auth mode per provider (OAuth XOR API key): if the resolved model's
    // provider has an OAuth token, OAuth wins OUTRIGHT — a stored API key
    // (env/flag/settings) is ignored, never blended. Only when there is no
    // OAuth token do we fall back to the provider's env API key. The "oauth"
    // sentinel satisfies downstream gating (which only checks for a truthy
    // apiKey); the runtime injects Bearer headers.
    {
      const modelForResolve = config.model ?? getCurrentModel("agent");
      if (await hasOAuthForModel(modelForResolve)) {
        config.apiKey = "oauth";
      } else if (!config.apiKey) {
        const envKey = await resolveKeyForModel(modelForResolve);
        if (envKey) config.apiKey = envKey;
      }
    }

    // First run with no credentials does NOT block: boot straight into the TUI.
    // The in-chat provider picker (/providers, /login) handles auth on demand.
    // Headless (`--prompt`/`--verify`) with no key still fails via requireApiKey.
    const isInteractive = !options.prompt && !options.verify && process.stdin.isTTY;

    // Bootstrap EE auth (loads serverBaseUrl + token from ~/.experience/config.json)
    const { loadEEAuthToken, getCachedServerBaseUrl } = await import("./ee/auth.js");
    await loadEEAuthToken().catch(() => {});

    // First-run EE setup (interactive, once per install): if no EE server is
    // configured, offer to connect one + write ~/.experience/config.json so the
    // agent's record/recall/feedback loop has a brain. One-time, flag-gated.
    if (isInteractive) {
      try {
        const { loadUserSettings, saveUserSettings } = await import("./utils/settings.js");
        if (loadUserSettings().eeSetupPrompted !== true && !getCachedServerBaseUrl()) {
          const { firstRunEESetup } = await import("./ee/ee-onboarding.js");
          const wrote = await firstRunEESetup();
          if (wrote) await loadEEAuthToken().catch(() => {});
          saveUserSettings({ eeSetupPrompted: true });
        }
      } catch (err) {
        if (process.env.MUONROI_DEBUG)
          console.error(`[muonroi-cli] EE first-run setup skipped: ${(err as Error)?.message}`);
      }
    }

    // Auto-detect EE client mode (thin / thin-degraded / fat / disabled).
    // Result is cached for downstream callsites (PIL layers, bridge.searchByText)
    // so each request doesn't re-probe.
    const { detectEEClientMode, describeMode } = await import("./ee/client-mode.js");
    detectEEClientMode()
      .then(async (info) => {
        if (process.env.MUONROI_EE_DEBUG === "1") {
          console.error(`[muonroi-cli] ${describeMode(info)}`);
        }
        // WhoAmI thin-client fallback: once the mode is cached, derive the working-style
        // profile from the behavioral brain and prime the sync cache so the PIL picks it
        // up from the next turn. Fire-and-forget, fail-open — never blocks boot.
        const { warmWhoAmIFromBrain } = await import("./ee/bridge.js");
        await warmWhoAmIFromBrain();
      })
      .catch(() => {});

    // Patch zod-to-json-schema for Zod v4 compat (fixes tool calls for DeepSeek etc.)
    const { patchZodToJsonSchema } = await import("./providers/patch-zod-schema.js");
    patchZodToJsonSchema();

    // Catalog already loaded above (before key resolution). Read the
    // populated registry now to surface any load failure to the user.
    const { MODELS: loadedModels, getModelInfo: lookupModel } = await import("./models/registry.js");

    // No models loaded — check root cause
    if (loadedModels.length === 0) {
      if (catalogLoadFailed) {
        console.error(
          "\x1b[31mCould not load the model catalog. The installation may be corrupted.\x1b[0m\n" +
            "  The file \x1b[33mdist/models/catalog.json\x1b[0m was not found.\n" +
            "\nTry reinstalling:\n" +
            "  \x1b[33mnpm install -g muonroi-cli\x1b[0m\n" +
            "  # or: \x1b[33mbun install -g muonroi-cli\x1b[0m\n" +
            "\nIf building from source:\n" +
            "  \x1b[33mbun run build\x1b[0m\n",
        );
      } else if (config.apiKey) {
        console.error(
          "\x1b[31mAPI key is invalid or expired. No models could be loaded.\x1b[0m\n" +
            "Update your key:\n" +
            "  muonroi-cli -k YOUR_NEW_KEY\n" +
            "  # or: export MUONROI_API_KEY=YOUR_NEW_KEY\n" +
            `\nGet a key at: https://docs.muonroi.com/docs/cli/providers`,
        );
      } else {
        console.error(
          "\x1b[31mNo API key configured and no models could be loaded.\x1b[0m\n" +
            "Set your key:\n" +
            "  muonroi-cli -k YOUR_API_KEY\n" +
            "  # or: export MUONROI_API_KEY=YOUR_API_KEY\n" +
            `\nGet a key at: https://docs.muonroi.com/docs/cli/providers`,
        );
      }
      process.exit(1);
    }

    // Validate configured model exists in loaded registry — fallback to first available
    if (loadedModels.length > 0) {
      const { getCurrentModel } = await import("./utils/settings.js");
      const effectiveModel = config.model || getCurrentModel();
      if (effectiveModel && !lookupModel(effectiveModel)) {
        console.error(
          `\x1b[31mModel "${effectiveModel}" is not available (may be retired or not in your plan).\x1b[0m\n`,
        );
        console.error("Available models:\n");
        for (const m of loadedModels.slice(0, 15)) {
          console.error(`  \x1b[36m${m.id}\x1b[0m — ${m.name}`);
        }
        if (loadedModels.length > 15) {
          console.error(`  ... and ${loadedModels.length - 15} more (run \`muonroi-cli models\` to see all)`);
        }
        console.error(
          "\n\x1b[33mSet your model:\x1b[0m\n" +
            "  muonroi-cli -m MODEL_ID\n" +
            "  # or add to ~/.muonroi-cli/user-settings.json:\n" +
            '  # { "defaultModel": "MODEL_ID" }\n',
        );
        process.exit(1);
      }
    }

    const councilAnswersFile =
      typeof options.councilAnswers === "string" ? loadCouncilAnswersOrExit(options.councilAnswers) : undefined;
    // Headless (`-p` / `--verify`) has no TUI to render council askcards, so the
    // answerer is ALWAYS active (auto-proceeds with the recommended option). This
    // is why a council-triggering prompt no longer hangs without `--yes`. A
    // `--council-answers` file still customizes per-phase answers.
    const councilAutoAnswer = createHeadlessCouncilAutoAnswerer({
      file: councilAnswersFile,
    });

    if (options.verify) {
      const verifyError = getVerifyCliError({ hasPrompt: Boolean(options.prompt), hasMessageArgs: message.length > 0 });
      if (verifyError) {
        console.error(verifyError);
        process.exit(1);
      }

      await runHeadless(
        buildVerifyPrompt(process.cwd()),
        requireApiKey(config.apiKey),
        config.baseURL,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        options.format,
        options.session,
        options.permission as PermissionMode,
        councilAutoAnswer,
      );
      return;
    }

    if (options.prompt) {
      await runHeadless(
        options.prompt,
        requireApiKey(config.apiKey),
        config.baseURL,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        options.format,
        options.session,
        options.permission as PermissionMode,
        councilAutoAnswer,
      );
      return;
    }

    const initialMessage = message.length > 0 ? message.join(" ") : undefined;
    await startInteractive(
      config.apiKey,
      config.baseURL,
      config.model,
      config.maxToolRounds,
      options.batchApi === true,
      options.session,
      initialMessage,
      options.permission as PermissionMode,
      options.injectHalt === true,
      options.injectHaltSprint === true,
    );
  });

program
  .command("models")
  .description("List available models")
  .action(async () => {
    console.log("\nLoading model catalog...\n");
    await loadCatalog();
    const { MODELS } = await import("./models/registry.js");
    for (const m of MODELS) {
      const tags = [
        m.reasoning ? "reasoning" : "non-reasoning",
        m.multiAgent ? "multi-agent" : null,
        m.responsesOnly ? "responses-only" : null,
      ].filter(Boolean);
      const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      console.log(`  \x1b[36m${m.id}\x1b[0m — ${m.name}${suffix}`);
      console.log(
        `    ${m.description} | ${formatContext(m.contextWindow)} context | $${m.inputPrice}/$${m.outputPrice} per 1M tokens`,
      );
      if ((m.aliases?.length ?? 0) > 0) {
        console.log(`    aliases: ${(m.aliases ?? []).join(", ")}`);
      }
    }
    console.log();
  });

program
  .command("update")
  .description("Update muonroi-cli to the latest release")
  .action(async () => {
    console.log("Checking for updates...");
    const result = await runUpdate(packageJson.version);
    console.log(result.output);
    process.exitCode = result.success ? 0 : 1;
  });

program
  .command("uninstall")
  .description("Remove a script-installed muonroi-cli binary and optional data")
  .option("--dry-run", "Show what would be removed without removing it")
  .option("--force", "Skip the confirmation prompt")
  .option("--keep-config", "Keep ~/.muonroi-cli config files")
  .option("--keep-data", "Keep ~/.muonroi-cli data files")
  .action(async (options) => {
    const result = await runScriptManagedUninstall({
      dryRun: options.dryRun === true,
      force: options.force === true,
      keepConfig: options.keepConfig === true,
      keepData: options.keepData === true,
    });
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

program
  .command("daemon")
  .description("Start the schedule daemon to run scheduled tasks")
  .option("--background", "Detach and run in the background")
  .action(async (options) => {
    if (options.background) {
      const result = await startScheduleDaemon(process.cwd());
      console.log(
        result.alreadyRunning
          ? `Schedule daemon already running (pid: ${result.status.pid ?? "unknown"}).`
          : `Schedule daemon started in the background (pid: ${result.pid ?? "unknown"}).`,
      );
      return;
    }

    process.off("SIGTERM", exitCleanlyOnSigterm);
    const { SchedulerDaemon } = await import("./daemon/scheduler");
    const daemon = new SchedulerDaemon();
    await daemon.start();
  });

program
  .command("doctor")
  .description("Run health checks for muonroi-cli dependencies and services")
  .action(async () => {
    const { loadEEAuthToken } = await import("./ee/auth.js");
    await loadEEAuthToken().catch(() => {});
    const { runDoctor, formatDoctorReport } = await import("./ops/doctor.js");
    const results = await runDoctor();
    console.log("\nmuonroi-cli doctor\n");
    console.log(formatDoctorReport(results, packageJson.version));
    const hasFail = results.some((r) => r.status === "fail");
    process.exit(hasFail ? 1 : 0);
  });

program
  .command("bug-report")
  .description("Generate anonymized diagnostic bundle for issue submission")
  .action(async () => {
    const { buildBugReport, formatBugReport } = await import("./ops/bug-report.js");
    const bundle = await buildBugReport();
    console.log(formatBugReport(bundle));
  });

const keys = program
  .command("keys")
  .description("Manage provider API keys as environment variables (set, list, delete)");

keys
  .command("set <provider>")
  .description("Prompt for a provider API key and store it as an environment variable")
  .action(async (provider: string) => {
    const { runKeysSet } = await import("./cli/keys.js");
    await runKeysSet(provider);
  });

keys
  .command("list")
  .description("Show provider keys currently set in the environment (masked)")
  .action(async () => {
    const { runKeysList } = await import("./cli/keys.js");
    await runKeysList();
  });

keys
  .command("delete <provider>")
  .description("Delete a stored provider key from the environment")
  .action(async (provider: string) => {
    const { runKeysDelete } = await import("./cli/keys.js");
    await runKeysDelete(provider);
  });

keys
  .command("login <provider>")
  .description("Log in to a provider via OAuth subscription (supported: openai, xai).")
  .action(async (provider: string) => {
    const { runKeysLogin } = await import("./cli/keys.js");
    await runKeysLogin(provider);
  });

keys
  .command("logout <provider>")
  .description("Log out of an OAuth provider and revoke stored tokens")
  .action(async (provider: string) => {
    const { runKeysLogout } = await import("./cli/keys.js");
    await runKeysLogout(provider);
  });

keys
  .command("export <file>")
  .description("Export all provider keys to an encrypted portable bundle (move between devices)")
  .action(async (file: string) => {
    const { runKeysExport } = await import("./cli/keys.js");
    await runKeysExport(file);
  });

keys
  .command("import <file>")
  .description("Import an encrypted bundle of provider keys (created by 'keys export')")
  .action(async (file: string) => {
    const { runKeysImport } = await import("./cli/keys.js");
    await runKeysImport(file);
  });

keys
  .command("set-chat <id>")
  .description(
    "Set a chat-service secret (discord-token, discord-guild-id, slack-token, slack-team-id) in the environment",
  )
  .action(async (id: string) => {
    const { runChatKeySet } = await import("./cli/keys.js");
    if (!["discord-token", "discord-guild-id", "slack-token", "slack-team-id"].includes(id)) {
      console.error(`Unknown chat secret '${id}'. Valid: discord-token, discord-guild-id, slack-token, slack-team-id`);
      process.exit(1);
    }
    const value = (
      await new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(`Paste ${id} value (hidden): `, (answer) => {
          rl.close();
          resolve(answer);
        });
      })
    ).trim();
    if (!value) {
      console.error("Aborted (empty value).");
      process.exit(1);
    }
    await runChatKeySet(id as any, value);
  });

const usage = program.command("usage").description("Inspect cost ledger and find spend bloat");

usage
  .command("report")
  .description("Aggregate per-call cost log + product ledger to find where spend grew")
  .option("--by <dim>", "Group by: callsite | role | phase | model | provider", "callsite")
  .option("--date <yyyy-mm-dd>", "Restrict cost-log to a single UTC date")
  .option("--run <productRunId>", "Restrict product ledger to one runId")
  .option("--source <src>", "cost-log | product | both", "both")
  .option("--breakdown", "Show orchestrator system-prompt / tools / messages breakdown")
  .option("--json", "Emit aggregated rows as JSON")
  .action(
    async (opts: { by: string; date?: string; run?: string; source: string; breakdown?: boolean; json?: boolean }) => {
      const { runUsageReport } = await import("./cli/usage-report.js");
      await runUsageReport({
        by: opts.by as "callsite" | "role" | "phase" | "model" | "provider",
        date: opts.date,
        runId: opts.run,
        source: opts.source as "cost-log" | "product" | "both",
        breakdown: opts.breakdown,
        json: opts.json,
      });
    },
  );

usage
  .command("pil")
  .description("Attribute system-prompt size growth to PIL layers (intent/personality/EE/GSD/context)")
  .option("--date <yyyy-mm-dd>", "Restrict to a single UTC date")
  .option("--top <n>", "Show top N largest prompts", "5")
  .option("--json", "Emit aggregated rows as JSON")
  .action(async (opts: { date?: string; top: string; json?: boolean }) => {
    const { runPilReport } = await import("./cli/pil-report.js");
    await runPilReport({
      date: opts.date,
      top: parseInt(opts.top, 10) || 5,
      json: opts.json,
    });
  });

usage
  .command("forensics <sessionPrefix>")
  .description(
    "Per-event token + cache breakdown for a session (joins usage_events ∪ interaction_logs). Use to verify Phase A/B/C cost-optimization caps.",
  )
  .option("--json", "Emit summary as JSON")
  .action(async (sessionPrefix: string, opts: { json?: boolean }) => {
    const { runCostForensics } = await import("./cli/cost-forensics.js");
    await runCostForensics({ prefix: sessionPrefix, json: opts.json });
  });

usage
  .command("experience")
  .description(
    "Cross-session anti-mù telemetry: how often compaction elides tool outputs and whether the agent recovers them (gates the deferred auto-protect re-architecture).",
  )
  .option("--limit <n>", "Number of most-recent sessions to aggregate", "100")
  .option("--json", "Emit aggregate as JSON")
  .action(async (opts: { limit: string; json?: boolean }) => {
    const { runExperienceReport } = await import("./cli/experience-report.js");
    await runExperienceReport({ limit: parseInt(opts.limit, 10) || 100, json: opts.json });
  });

usage
  .command("security-audit")
  .description(
    "Security posture: yolo/permission overrides, high-risk cmds, shuru audits + cost (from decision-log events)",
  )
  .option("--since <date|7d|1h|30m>", "Restrict to UTC date or relative window")
  .option("--json", "Emit as JSON")
  .option("--format <fmt>", "table | json | md", "table")
  .action(async (opts: { since?: string; json?: boolean; format?: string }) => {
    const { runSecurityAudit } = await import("./cli/usage-report.js");
    await runSecurityAudit({ since: opts.since, json: opts.json, format: opts.format as any });
  });

usage
  .command("perf-regression")
  .description("Perf snapshot + estimator drift (compare baseline stub for later)")
  .option("--compare <file>", "Baseline file for delta")
  .option("--json", "Emit JSON")
  .action(async (opts: { compare?: string; json?: boolean }) => {
    const { runPerfRegression } = await import("./cli/usage-report.js");
    await runPerfRegression({ compare: opts.compare, json: opts.json });
  });

const mcp = program.command("mcp").description("Manage MCP server configuration");

mcp
  .command("setup-research")
  .description("Configure web research (native fetch_url + web_search; optional MCPs for context7/muonroi-docs)")
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
    try {
      const { runResearchOnboarding } = await import("./mcp/research-onboarding.js");
      const result = await runResearchOnboarding({
        askYesNo: ask,
        askText: ask,
        log: (m) => process.stderr.write(m),
      });
      process.stderr.write(`\nDone. Tavily ${result.tavilyEnabled ? "enabled" : "skipped"}.\n`);
    } finally {
      rl.close();
    }
  });

mcp
  .command("set <id>")
  .description("Prompt for an MCP API key (e.g. tavily) and store it as an environment variable")
  .action(async (id: string) => {
    const { runMcpKeysSet } = await import("./cli/keys.js");
    await runMcpKeysSet(id);
  });

program
  .command("mcp-driver")
  .description("Run the agent-harness MCP driver over stdio")
  .action(async () => {
    const { runHarnessDriver } = await import("@muonroi/agent-harness-core/mcp-server");
    const { opentuiSpawn } = await import("./mcp/opentui-spawn.js");
    await runHarnessDriver(opentuiSpawn);
  });

program
  .command("tools-mcp")
  .description("Run the muonroi native-tools MCP server over stdio (self-verify; more tools later)")
  .action(async () => {
    const { runToolsMcpServer } = await import("./mcp/tools-server.js");
    await runToolsMcpServer();
  });

program
  .command("self-verify")
  .description(
    "Harness-Verified Self-QA: spawn a child muonroi-cli, drive it through scenarios derived from git diff, and emit regression specs for every passing run",
  )
  .option("--since <ref>", "Git base ref for the diff window", "HEAD~1")
  .option("--max <n>", "Maximum number of scenarios to run", "8")
  .option("--no-emit", "Do not write tests/harness/auto/*.spec.ts on pass")
  .option("--out <dir>", "Override the emitted-spec directory")
  .option("--json", "Print machine-readable JSON report to stdout")
  .option(
    "--agentic",
    "Tier 2: outer LLM drives the child interactively (reads frame deltas + events, decides next step). Requires --goal and --model.",
  )
  .option("--goal <text>", "Free-form goal for agentic mode (e.g. 'open agents modal and add a researcher')")
  .option("--llm <id>", "LLM model id for agentic mode (e.g. 'deepseek-v4-flash')")
  .option("--turns <n>", "Max agentic turns", "20")
  .action(
    async (opts: {
      since: string;
      max: string;
      emit?: boolean;
      out?: string;
      json?: boolean;
      agentic?: boolean;
      goal?: string;
      llm?: string;
      turns: string;
    }) => {
      const log = opts.json ? () => {} : (m: string) => console.log(m);

      if (opts.agentic) {
        if (!opts.goal || !opts.llm) {
          console.error("--agentic requires both --goal and --llm");
          process.exit(2);
        }
        const { runAgenticLoop, createLLMBrain } = await import("./self-qa/agentic-loop.js");
        const brain = await createLLMBrain({ modelId: opts.llm });
        const report = await runAgenticLoop({
          goal: opts.goal,
          brain,
          maxTurns: Number.parseInt(opts.turns, 10) || 20,
          log,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          console.log(
            `\n[self-verify agentic] verdict=${report.verdict} | ${report.turns.length} turns | ${report.totalDurationMs}ms`,
          );
          console.log(`  reason: ${report.reason}`);
        }
        process.exit(report.verdict === "fail" ? 1 : 0);
      }

      const { runSelfVerify } = await import("./self-qa/index.js");
      const report = await runSelfVerify({
        baseRef: opts.since,
        maxScenarios: Number.parseInt(opts.max, 10) || 8,
        emitSpecs: opts.emit !== false,
        specOutDir: opts.out,
        log,
      });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        const s = report.summary;
        console.log(
          `\n[self-verify] ${s.passed}/${s.total} passed | ${s.failed} failed | ${s.inconclusive} inconclusive | ${report.durationMs}ms`,
        );
        if (report.emittedSpecs.length > 0) {
          console.log(`[self-verify] Emitted ${report.emittedSpecs.length} regression spec(s):`);
          for (const path of report.emittedSpecs) console.log(`  ${path}`);
        }
      }
      process.exit(report.summary.failed > 0 ? 1 : 0);
    },
  );

program
  .command("export-transcripts")
  .description("One-shot dump of SQLite session history → ~/.experience/muonroi-cli-sessions/ for EE backfill")
  .option("--days <n>", "Only export sessions updated within N days (default 30)", "30")
  .option("--min-messages <n>", "Skip sessions with fewer than N messages (default 4)", "4")
  .option("--dry-run", "List sessions that would be exported without writing files")
  .action(async (opts: { days: string; minMessages: string; dryRun?: boolean }) => {
    const { exportTranscripts } = await import("./ee/export-transcripts.js");
    try {
      const res = await exportTranscripts({
        maxAgeDays: Number.parseInt(opts.days, 10),
        minMessages: Number.parseInt(opts.minMessages, 10),
        dryRun: !!opts.dryRun,
      });
      console.log(
        `[export-transcripts] sessions=${res.totalSessions}  written=${res.written}  skipped_empty=${res.skippedEmpty}  skipped_small=${res.skippedTooSmall}\n  output: ${res.outputRoot}`,
      );
      process.exit(0);
    } catch (e) {
      console.error(`[export-transcripts] failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("share <user>")
  .description("Add a stakeholder to the current product's Discord channel")
  .option("--product <slug>", "Override product slug (default: most recent run)")
  .option("--display <name>", "Display name for the stakeholder")
  .action(async (user: string, opts: { product?: string; display?: string }) => {
    const token = process.env.MUONROI_DISCORD_TOKEN;
    const guildId = process.env.MUONROI_DISCORD_GUILD_ID;
    if (!token || !guildId) {
      console.error("muonroi share: MUONROI_DISCORD_TOKEN and MUONROI_DISCORD_GUILD_ID must both be set.");
      process.exit(1);
    }
    const { DiscordChatProvider } = await import("./chat/providers/discord/client.js");
    const { runShareCommand } = await import("./cli/share-cmd.js");
    const client = new DiscordChatProvider(token);
    const result = await runShareCommand({
      cwd: process.cwd(),
      user,
      product: opts.product,
      display: opts.display,
      client,
    });
    switch (result.kind) {
      case "granted":
        console.log(`Granted channel access to <@${result.userId}> in product ${result.slug}.`);
        break;
      case "acl-only":
        console.log(`Added <@${result.userId}> to product ${result.slug}. Channel will be granted access on creation.`);
        break;
      case "already-stakeholder":
        console.log(`User <@${result.userId}> is already a stakeholder of ${result.slug}.`);
        break;
      case "perm-error":
        console.error(
          `Failed to grant Discord permission (status=${result.status}). ACL was still updated; user can join when bot has permission.`,
        );
        process.exit(1);
        break;
      case "error":
        console.error(`muonroi share: ${result.message}`);
        process.exit(1);
        break;
    }
  });

program
  .command("reporter")
  .description("Run the P8 reporter agent — polls Discord and serves progress queries")
  .requiredOption("--run <runId>", "Run ID to observe")
  .option("--product-slug <slug>", "Product slug (inferred from run manifest if omitted)")
  .option("--daily-budget <usd>", "Daily LLM budget in USD (default 0.50)", "0.50")
  .action(async (opts: { run: string; productSlug?: string; dailyBudget?: string }) => {
    const { runReporterCmd } = await import("./cli/reporter-cmd.js");
    try {
      await runReporterCmd({ run: opts.run, productSlug: opts.productSlug, dailyBudget: opts.dailyBudget });
      process.exit(0);
    } catch (e) {
      console.error(`muonroi reporter: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program.parse();

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}K`;
}
