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
import { loadAnthropicKey } from "./providers/index.js";
import { loadConfig } from "./storage/config.js";
import { loadUsage } from "./storage/usage-cap.js";
import { startScheduleDaemon } from "./tools/schedule";
import { processAtMentions } from "./utils/at-mentions.js";
import { runScriptManagedUninstall } from "./utils/install-manager";
import type { PermissionMode } from "./utils/permission-mode.js";
import {
  getApiKey,
  getBaseURL,
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
  console.error("Fatal:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

/**
 * First-run wizard: prompts for API key interactively when none is configured.
 * Output goes to stderr so it doesn't pollute piped stdout.
 * Returns the trimmed key or null if user cancels / stdin is not a TTY.
 */
async function firstRunWizard(): Promise<string | null> {
  try {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, (answer) => resolve(answer)));

    process.stderr.write("\nWelcome to muonroi-cli!\n\n");
    process.stderr.write("To get started, you need an API key from Anthropic.\n");
    process.stderr.write("Get one at: https://console.anthropic.com/settings/keys\n\n");

    const raw = await ask("Enter your API key: ");
    rl.close();

    const trimmed = raw.trim();
    if (!trimmed) {
      process.stderr.write(
        "No key provided. Set MUONROI_API_KEY env var or run again to enter key.\n",
      );
      return null;
    }
    return trimmed;
  } catch {
    // stdin is not a TTY or readline errors — fail silently
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

  // 3. loadAnthropicKey — enrolls key into redactor; falls back to env var.
  const anthropicKey = await loadAnthropicKey().catch(() => undefined);
  void anthropicKey; // Agent also calls loadAnthropicKey internally; this run is for redactor enrollment.

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
    // Lets terminals (Kitty, iTerm2, WezTerm, …) report Command as `super` on KeyEvent — needed for ⌘C in the TUI.
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
    },
  });

  const onExit = () => {
    void agent.cleanup().finally(() => {
      renderer.destroy();
      process.exit(0);
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

  try {
    const { enhancedMessage } = processAtMentions(prompt, process.cwd());

    if (format === "json") {
      const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(agent.getSessionId() || undefined);
      for await (const chunk of agent.processMessage(enhancedMessage, observer)) {
        const writes = consumeChunk(chunk);
        if (writes.stdout) process.stdout.write(writes.stdout);
        if (writes.stderr) process.stderr.write(writes.stderr ?? "");
      }
      const tail = flush();
      if (tail.stdout) process.stdout.write(tail.stdout);
      if (tail.stderr) process.stderr.write(tail.stderr ?? "");
      return;
    }

    for await (const chunk of agent.processMessage(enhancedMessage)) {
      const writes = renderHeadlessChunk(chunk);
      if (writes.stdout) process.stdout.write(writes.stdout);
      if (writes.stderr) process.stderr.write(writes.stderr);
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
    // Deliberately exits BEFORE loadAnthropicKey() — CI runners have no keychain configured.
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

    // First-run wizard (interactive only, before any TUI code)
    const isInteractive = !options.prompt && !options.verify && process.stdin.isTTY;
    if (!config.apiKey && isInteractive) {
      const wizardKey = await firstRunWizard();
      if (wizardKey) {
        saveUserSettings({ apiKey: wizardKey });
        config.apiKey = wizardKey;
      } else {
        process.exit(1);
      }
    }

    // Boot model registry — load from centralized catalog (no provider API calls)
    await loadCatalog().catch(() => {});

    // If key exists but no models loaded → key is likely invalid
    const { MODELS: loadedModels, getModelInfo: lookupModel } = await import("./models/registry.js");
    if (config.apiKey && loadedModels.length === 0) {
      console.error(
        "\x1b[31mAPI key is invalid or expired. No models could be loaded.\x1b[0m\n" +
        "Update your key:\n" +
        "  muonroi-cli -k YOUR_NEW_KEY\n" +
        "  # or: export MUONROI_API_KEY=YOUR_NEW_KEY\n" +
        "\nGet a key at: https://console.anthropic.com/settings/keys",
      );
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

program.parse();

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}K`;
}
