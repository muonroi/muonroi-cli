#!/usr/bin/env bun
// SECURITY: Redactor must be the FIRST import. installGlobalPatches() wraps
// console.* before any subsequent import side-effect or log can emit an API key.
// See: PROV-07, Pitfall 2 (HIGH severity API key leakage).
import { redactor } from "./utils/redactor.js";

redactor.installGlobalPatches();

import { createInterface } from "readline";
import { InvalidArgumentError, program } from "commander";

import packageJson from "../package.json";
import {
  createHeadlessJsonlEmitter,
  type HeadlessOutputFormat,
  isHeadlessOutputFormat,
  renderHeadlessChunk,
  renderHeadlessPrelude,
} from "./headless/output";
import {
  loadCatalog,
  normalizeModelId,
} from "./models/registry.js";
// Plan 00-07: boot-order modules — AbortContext + PendingCallsLog (TUI-01, TUI-03, TUI-04).
import { createAbortContext } from "./orchestrator/abort.js";
import { completeDelegation, failDelegation, loadDelegation } from "./orchestrator/delegations";
import { Agent } from "./orchestrator/orchestrator";
import { createPendingCallsLog } from "./orchestrator/pending-calls.js";
import { consoleUrlFor } from "./providers/endpoints.js";
import { KEYCHAIN_PROVIDER_IDS, listStoredProviders, loadKeyForProvider, setKeyForProvider } from "./providers/keychain.js";
import { detectProviderForModel } from "./providers/runtime.js";
import type { ProviderId } from "./providers/types.js";
import { loadConfig } from "./storage/config.js";
import { loadUsage } from "./storage/usage-cap.js";
import { startScheduleDaemon } from "./tools/schedule";
import { processAtMentions } from "./utils/at-mentions.js";
import { runScriptManagedUninstall } from "./utils/install-manager";
import type { PermissionMode } from "./utils/permission-mode.js";
import {
  getApiKey,
  getBaseURL,
  getCurrentModel,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  mergeSandboxSettings,
  type SandboxMode,
  type SandboxSettings,
  saveUserSettings,
} from "./utils/settings";
import { runUpdate } from "./utils/update-checker";
import { buildVerifyPrompt, getVerifyCliError } from "./verify/entrypoint";

const exitCleanlyOnSigterm = () => {
  process.exit(0);
};

process.on("SIGTERM", exitCleanlyOnSigterm);

process.on("uncaughtException", (err) => {
  try { require("fs").appendFileSync(require("path").join(require("os").homedir(), ".muonroi-cli", "crash.log"), `[${new Date().toISOString()}] UNCAUGHT: ${err.stack || err.message}\n`); } catch {}
  console.error("Fatal:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  try { require("fs").appendFileSync(require("path").join(require("os").homedir(), ".muonroi-cli", "crash.log"), `[${new Date().toISOString()}] REJECTION: ${msg}\n`); } catch {}
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

/**
 * First-run wizard: prompts for API key interactively when none is configured.
 * Output goes to stderr so it doesn't pollute piped stdout.
 * Returns the trimmed key or null if user cancels / stdin is not a TTY.
 */
// Provider console URLs are sourced from providers/endpoints.ts via consoleUrlFor().

/**
 * Try to find an API key for the model the CLI is about to run with.
 * Resolution: env (legacy MUONROI_API_KEY) → OS keychain → settings.json.
 * Returns null if nothing usable is configured anywhere.
 */
async function resolveKeyForModel(modelId: string): Promise<string | null> {
  const provider = detectProviderForModel(modelId);
  try {
    const k = await loadKeyForProvider(provider);
    if (k) return k;
  } catch { /* fall through to wizard */ }
  return null;
}

/**
 * First-run wizard. If the keychain already has keys, prints a hint
 * (model probably doesn't match any stored provider). Otherwise prompts
 * for provider + key and persists to the OS keychain.
 */
async function firstRunWizard(currentModel?: string): Promise<string | null> {
  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl!.question(q, (answer) => resolve(answer)));

    process.stderr.write("\nWelcome to muonroi-cli!\n\n");

    const stored = await listStoredProviders();
    if (stored.length > 0) {
      process.stderr.write(`Keys already in keychain for: ${stored.join(", ")}\n`);
      if (currentModel) {
        const provider = detectProviderForModel(currentModel);
        process.stderr.write(
          `Current model '${currentModel}' uses provider '${provider}', which has no stored key.\n`,
        );
      }
      process.stderr.write(
        "\nOptions:\n" +
          "  1. Run with a model that matches a stored provider:\n" +
          "       muonroi-cli --model <model-id>\n" +
          "  2. Add a key for the missing provider:\n" +
          "       muonroi-cli keys set <provider>\n" +
          "  3. Edit ~/.muonroi-cli/user-settings.json and set defaultModel.\n\n",
      );
      rl.close();
      return null;
    }

    const providers = KEYCHAIN_PROVIDER_IDS;
    process.stderr.write(
      "Pick a provider to set up first (more can be added later via 'muonroi-cli keys set'):\n\n",
    );
    providers.forEach((p, i) => {
      process.stderr.write(`  ${i + 1}. ${p.padEnd(12)}  ${consoleUrlFor(p)}\n`);
    });
    process.stderr.write("\n");

    const choice = (await ask(`Provider [1-${providers.length}, default 1]: `)).trim();
    const idx = choice ? Number.parseInt(choice, 10) - 1 : 0;
    if (!Number.isFinite(idx) || idx < 0 || idx >= providers.length) {
      process.stderr.write("Invalid choice — aborted.\n");
      rl.close();
      return null;
    }
    const provider = providers[idx];
    if (!provider) {
      process.stderr.write("Invalid choice — aborted.\n");
      rl.close();
      return null;
    }

    process.stderr.write(`\nGet a key here: ${consoleUrlFor(provider)}\n`);
    const raw = await ask(`Paste your ${provider} API key: `);

    const trimmed = raw.trim();
    if (!trimmed) {
      process.stderr.write("No key provided. Aborted.\n");
      rl.close();
      return null;
    }
    if (trimmed.length < 20) {
      process.stderr.write("Key looks too short (< 20 chars). Aborted.\n");
      rl.close();
      return null;
    }

    try {
      const ok = await setKeyForProvider(provider, trimmed);
      if (ok) {
        process.stderr.write(`\nStored ${provider} key in OS keychain.\n`);
        // Web-research onboarding (Tavily + context7 + fetch).
        try {
          const { runResearchOnboarding } = await import("./mcp/research-onboarding.js");
          await runResearchOnboarding({
            askYesNo: ask,
            askText: ask,
            log: (m) => process.stderr.write(m),
          });
        } catch (err) {
          process.stderr.write(`\nWarning: research onboarding failed: ${(err as Error).message}\n`);
        }
        if (currentModel) {
          const currentProvider = detectProviderForModel(currentModel);
          if (currentProvider !== provider) {
            process.stderr.write(
              `\nNote: defaultModel '${currentModel}' is on '${currentProvider}'. ` +
                `Edit ~/.muonroi-cli/user-settings.json or rerun with --model to use ${provider}.\n`,
            );
          }
        }
      } else {
        process.stderr.write(
          "\nOS keychain unavailable on this platform. Key will be used for this session only.\n" +
            `For persistence, set env var: ${provider.toUpperCase()}_API_KEY\n`,
        );
      }
    } catch (err) {
      process.stderr.write(`\nWarning: failed to store key in keychain: ${(err as Error).message}\n`);
    }

    rl.close();
    return trimmed;
  } catch {
    rl?.close();
    return null;
  }
}

async function startInteractive(
  apiKey: string | undefined,
  baseURL: string,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  session?: string,
  initialMessage?: string,
  permissionMode: PermissionMode = "safe",
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
        const ask = (q: string): Promise<string> =>
          new Promise((resolve) => rl.question(q, (a) => resolve(a)));
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

  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
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

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
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

  const onExit = () => {
    void agent.cleanup().finally(() => {
      // Restore terminal state from JS before the native destroyRenderer runs
      restoreTerminalSync();

      renderer.destroy();

      // Restore terminal modes BEFORE spawning child shell. Use synchronous
      // writes to stdout's underlying fd so escape codes flush before the
      // child inherits stdin — async process.stdout.write() can buffer past
      // the spawn() boundary, leaving the terminal in mouse-tracking mode.
      const writeSync = (seq: string) => {
        try {
          const fs = require("node:fs") as typeof import("node:fs");
          fs.writeSync(1, seq);
        } catch { /* fall back to async */
          try { process.stdout.write(seq); } catch { /* noop */ }
        }
      };
      try {
        // 1. Take stdin out of raw mode + pause it so no buffered keystrokes
        //    (or in-flight mouse-event bytes) hit the child shell.
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
          try { process.stdin.setRawMode(false); } catch { /* noop */ }
        }
        try { process.stdin.pause(); } catch { /* noop */ }
        try { (process.stdin as unknown as { unref?: () => void }).unref?.(); } catch { /* noop */ }
        // 2. Disable extended-coords first (1006/1015/1005), then the basic
        //    tracking modes (1003→1002→1000). Wrong order leaves the terminal
        //    emitting SGR-formatted events after the base modes are off.
        writeSync("\x1B[?1006l\x1B[?1015l\x1B[?1005l");
        writeSync("\x1B[?1003l\x1B[?1002l\x1B[?1000l");
        writeSync("\x1B[?2004l\x1B[?25h");           // bracketed paste off, cursor on
        writeSync("\x1B[?1049l\x1B[0m\x1B[!p");      // exit alt-screen, reset SGR, soft reset
      } catch {
        // best-effort
      }

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
            const shellCmd = process.env.MUONROI_EXIT_SHELL
              || process.env.SHELL
              || (isWin ? (process.env.COMSPEC || "cmd.exe") : "/bin/bash");
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
        maxToolRounds,
        sandboxMode,
        sandboxSettings,
        version: packageJson.version,
      },
      initialMessage,
      onExit,
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
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  format: HeadlessOutputFormat,
  session?: string,
  permissionMode: PermissionMode = "safe",
) {
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
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

  try {
    const { enhancedMessage } = processAtMentions(prompt, process.cwd());

    if (format === "json") {
      const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(agent.getSessionId() || undefined);
      for await (const chunk of agent.processMessage(enhancedMessage, observer)) {
        const writes = consumeChunk(chunk);
        if (writes.stdout) writeSafe(process.stdout, writes.stdout);
        if (writes.stderr) writeSafe(process.stderr, writes.stderr ?? "");
      }
      const tail = flush();
      if (tail.stdout) writeSafe(process.stdout, tail.stdout);
      if (tail.stderr) writeSafe(process.stderr, tail.stderr ?? "");
      return;
    }

    for await (const chunk of agent.processMessage(enhancedMessage)) {
      const writes = renderHeadlessChunk(chunk);
      if (writes.stdout) writeSafe(process.stdout, writes.stdout);
      if (writes.stderr) writeSafe(process.stderr, writes.stderr);
    }
  } finally {
    await agent.cleanup();
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

function resolveCliSandboxMode(value: string | boolean | undefined): SandboxMode | undefined {
  if (value === true) return "shuru";
  if (value === false) return "off";
  return undefined;
}

async function runBackgroundDelegation(jobPath: string, options: CliOptions) {
  let output = "";
  let agent: Agent | undefined;

  try {
    const delegation = await loadDelegation(jobPath);
    const apiKey = stringOption(options.apiKey) || getApiKey();
    if (!apiKey) {
      throw new Error(
        "API key required. Set MUONROI_API_KEY, use --api-key, or save it to ~/.muonroi-cli/user-settings.json.",
      );
    }

    const baseURL = stringOption(options.baseUrl) || getBaseURL();
    const explicitModel = stringOption(options.model) || delegation.model;
    const model = explicitModel ? normalizeModelId(explicitModel) : undefined;
    const maxToolRounds =
      parseInt(stringOption(options.maxToolRounds) || String(delegation.maxToolRounds), 10) || delegation.maxToolRounds;
    const sandboxMode = resolveCliSandboxMode(options.sandbox) || delegation.sandboxMode || getCurrentSandboxMode();
    const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), delegation.sandboxSettings);
    agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
      persistSession: false,
      sandboxMode,
      sandboxSettings,
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

function resolveConfig(options: CliOptions) {
  const apiKey = stringOption(options.apiKey) || getApiKey();
  const baseURL = stringOption(options.baseUrl) || getBaseURL();
  const explicitModel = stringOption(options.model);
  const model = explicitModel ? normalizeModelId(explicitModel) : undefined;
  const maxToolRounds = parseInt(stringOption(options.maxToolRounds) || "400", 10) || 400;
  const sandboxMode = resolveCliSandboxMode(options.sandbox) || getCurrentSandboxMode();

  const cliOverrides: SandboxSettings = {};
  if (options.allowNet === true) cliOverrides.allowNet = true;
  const allowHostValue = options.allowHost;
  if (Array.isArray(allowHostValue) && allowHostValue.length > 0) {
    cliOverrides.allowedHosts = allowHostValue as string[];
    if (!cliOverrides.allowNet) cliOverrides.allowNet = true;
  }
  const portValue = options.port;
  if (Array.isArray(portValue) && portValue.length > 0) {
    cliOverrides.ports = portValue as string[];
  }
  const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), cliOverrides);

  if (typeof options.apiKey === "string") saveUserSettings({ apiKey: options.apiKey });
  if (typeof options.model === "string") saveUserSettings({ defaultModel: normalizeModelId(options.model) });

  return { apiKey, baseURL, model, maxToolRounds, sandboxMode, sandboxSettings };
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
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--allow-net", "Enable network access inside the Shuru sandbox")
  .option("--allow-host <pattern>", "Restrict sandbox network to specific hosts (repeatable)", collect, [])
  .option("--port <mapping>", "Forward a host port to sandbox guest (HOST:GUEST, repeatable)", collect, [])
  .option("-s, --session <id>", "Continue a saved session by id, or use 'latest'")
  .option("--background-task-file <path>", "Run a persisted background delegation")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option("--batch-api", "Use xAI Batch API for model calls (async, lower cost)")
  .option(
    "--permission <mode>",
    "Permission mode: safe (confirm all), auto-edit (auto-approve file ops), yolo (auto-approve all)",
    "safe",
  )
  .option("--update", "Update muonroi-cli to the latest version and exit")
  .option("--smoke-boot-only", "CI smoke: validate loadConfig + loadUsage and exit 0 — no keychain access")
  .action(async (message: string[], options) => {
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
      process.exit(result.success ? 0 : 1);
    }

    changeDirectoryOrExit(options.directory);

    if (options.backgroundTaskFile) {
      await runBackgroundDelegation(options.backgroundTaskFile, options);
      return;
    }

    const config = resolveConfig(options);

    // No legacy key in env / settings — try the OS keychain for the resolved
    // model's provider before falling back to the wizard.
    if (!config.apiKey) {
      const modelForResolve = config.model ?? getCurrentModel("agent");
      const keychainKey = await resolveKeyForModel(modelForResolve);
      if (keychainKey) {
        config.apiKey = keychainKey;
      }
    }

    // First-run wizard (interactive only, before any TUI code)
    const isInteractive = !options.prompt && !options.verify && process.stdin.isTTY;
    if (!config.apiKey && isInteractive) {
      const modelForWizard = config.model ?? getCurrentModel("agent");
      const wizardKey = await firstRunWizard(modelForWizard);
      if (wizardKey) {
        // Key is already persisted to the OS keychain by the wizard. We DO NOT
        // write it back to settings.json (avoids resurrecting plaintext that
        // 'keys cleanup-settings' just removed).
        config.apiKey = wizardKey;
      } else {
        process.exit(1);
      }
    }

    // Bootstrap EE auth (loads serverBaseUrl + token from ~/.experience/config.json)
    const { loadEEAuthToken } = await import("./ee/auth.js");
    await loadEEAuthToken().catch(() => {});

    // Auto-detect EE client mode (thin / thin-degraded / fat / disabled).
    // Result is cached for downstream callsites (PIL layers, bridge.searchByText)
    // so each request doesn't re-probe.
    const { detectEEClientMode, describeMode } = await import("./ee/client-mode.js");
    detectEEClientMode().then((info) => {
      if (process.env.MUONROI_EE_DEBUG === "1") {
        console.error(`[muonroi-cli] ${describeMode(info)}`);
      }
    }).catch(() => {});

    // Patch zod-to-json-schema for Zod v4 compat (fixes tool calls for DeepSeek etc.)
    const { patchZodToJsonSchema } = await import("./providers/patch-zod-schema.js");
    patchZodToJsonSchema();

    // Boot model registry — load from centralized catalog (no provider API calls)
    let catalogLoadFailed = false;
    await loadCatalog().catch(() => { catalogLoadFailed = true; });

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
          `\nGet a key at: ${consoleUrlFor("anthropic")}`,
        );
      } else {
        console.error(
          "\x1b[31mNo API key configured and no models could be loaded.\x1b[0m\n" +
          "Set your key:\n" +
          "  muonroi-cli -k YOUR_API_KEY\n" +
          "  # or: export MUONROI_API_KEY=YOUR_API_KEY\n" +
          `\nGet a key at: ${consoleUrlFor("anthropic")}`,
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
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        options.session,
        options.permission as PermissionMode,
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
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        options.session,
        options.permission as PermissionMode,
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
      config.sandboxMode,
      config.sandboxSettings,
      options.session,
      initialMessage,
      options.permission as PermissionMode,
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
    process.exit(result.success ? 0 : 1);
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
  .description("Manage provider API keys via the OS keychain (set, list, delete, import-bw)");

keys
  .command("set <provider>")
  .description("Prompt for a provider API key and store it in the OS keychain")
  .action(async (provider: string) => {
    const { runKeysSet } = await import("./cli/keys.js");
    await runKeysSet(provider);
  });

keys
  .command("list")
  .description("Show provider keys currently stored in the OS keychain (masked)")
  .action(async () => {
    const { runKeysList } = await import("./cli/keys.js");
    await runKeysList();
  });

keys
  .command("delete <provider>")
  .description("Delete a stored provider key from the OS keychain")
  .action(async (provider: string) => {
    const { runKeysDelete } = await import("./cli/keys.js");
    await runKeysDelete(provider);
  });

keys
  .command("import-bw [providers...]")
  .description("Import keys from a Bitwarden vault into the OS keychain (requires bw CLI + BW_SESSION)")
  .option("--prefix <prefix>", "Vault item name prefix (default: 'muonroi-cli/')", "muonroi-cli/")
  .action(async (providers: string[], opts: { prefix: string }) => {
    const { runKeysImportBw } = await import("./cli/keys.js");
    await runKeysImportBw({ providers, itemPrefix: opts.prefix });
  });

keys
  .command("cleanup-settings")
  .description("Strip plaintext API keys out of ~/.muonroi-cli/user-settings.json after migrating to keychain")
  .action(async () => {
    const { runKeysCleanupSettings } = await import("./cli/keys.js");
    await runKeysCleanupSettings();
  });

const mcp = program
  .command("mcp")
  .description("Manage MCP server configuration");

mcp
  .command("setup-research")
  .description("Configure web research MCP servers (context7, fetch, tavily)")
  .action(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, (a) => resolve(a)));
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
  .command("import-bw [keys...]")
  .description("Import MCP secrets (e.g. tavily) from a Bitwarden vault into the OS keychain (requires bw CLI + BW_SESSION)")
  .option("--prefix <prefix>", "Vault item name prefix (default: 'muonroi-cli/')", "muonroi-cli/")
  .action(async (keys: string[], opts: { prefix: string }) => {
    const { runMcpImportBw } = await import("./cli/keys.js");
    await runMcpImportBw({ keys, itemPrefix: opts.prefix });
  });

program.parse();

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}K`;
}
