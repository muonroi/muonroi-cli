import type { TaskRequest, ToolResult, VerifyRecipe } from "../types/index";
import { getCurrentSandboxMode, type SandboxSettings } from "../utils/settings";
import { ensureVerifyCheckpoint, type PreparedVerifyCheckpoint } from "./checkpoint";
import { buildVerifyTaskPrompt } from "./entrypoint";
import { loadVerifyEnvironment, saveVerifyEnvironment } from "./environment";
import { inferVerifyProjectProfile, type VerifyProjectProfile } from "./recipes";

export interface VerifyAgentLike {
  getCwd(): string;
  getSandboxSettings(): SandboxSettings;
  setSandboxSettings(settings: SandboxSettings): void;
  detectVerifyRecipe(settings?: SandboxSettings, abortSignal?: AbortSignal): Promise<VerifyRecipe | null>;
  runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult>;
}

export interface PreparedVerifyRun {
  profile: VerifyProjectProfile;
  sandboxSettings: SandboxSettings;
  taskRequest: TaskRequest;
  checkpoint?: PreparedVerifyCheckpoint;
  manifestPath?: string;
  usedVerifyDetect: boolean;
}

export interface VerifyOrchestratorOptions {
  onProgress?: (detail: string) => void;
  abortSignal?: AbortSignal;
}

function buildRuntimeSandboxSettings(profile: VerifyProjectProfile): SandboxSettings {
  return {
    ...profile.sandboxSettings,
    allowNet: true,
    allowedHosts: undefined,
    allowEphemeralInstall: true,
    hostBrowserCommandsOnHost: true,
    shellInit: [...new Set([...(profile.sandboxSettings.shellInit ?? []), ...profile.recipe.shellInitCommands])],
  };
}

export async function prepareVerifyRun(
  agent: VerifyAgentLike,
  options: VerifyOrchestratorOptions = {},
): Promise<PreparedVerifyRun> {
  const cwd = agent.getCwd();
  const baseSettings = agent.getSandboxSettings();
  const manifest = loadVerifyEnvironment(cwd, baseSettings);

  if (manifest) {
    options.onProgress?.(`Loaded verify environment manifest: ${manifest.path}`);
  } else {
    options.onProgress?.("No verify environment manifest found; running verify-detect to generate one");
  }

  let profile = inferVerifyProjectProfile(cwd, manifest?.sandboxSettings ?? baseSettings, manifest?.recipe ?? null);
  let usedVerifyDetect = false;
  let manifestPath = manifest?.path;

  // KNOWN, MEASURED, AND DELIBERATELY NOT FIXED HERE — see the matching note at
  // `inferVerifyProjectProfile` (src/verify/recipes.ts:1024).
  //
  // A MANIFEST WRITTEN ONCE IS AUTHORITATIVE FOREVER. This is the only call to
  // `saveVerifyEnvironment` in the codebase and it is gated on `!manifest`, so the
  // stored `.muonroi-cli/environment.json` is never refreshed — and because
  // `manifest.recipe` is passed to `inferVerifyProjectProfile` as `recipeOverride`
  // just above, where `??` REPLACES the disk derivation rather than merging with
  // it, a stale manifest also means `detectVerifyRecipe` never runs again.
  //
  // The consequence is larger than one gate: every recipe-detection improvement
  // reaches NO consumer that reads `profile.recipe` on a project that already has
  // a manifest — the sub-directory component scan, the nearest sub-package manager
  // lookup, the pytest rootdir markers, the sub-directory build gate.
  //
  // Measured: `D:\sources\CompanyLibs\qa-platform\.muonroi-cli\environment.json`
  // was written 2026-09-23 21:29 with `testCommands: []` and has been
  // authoritative for every run since, including run `muc2joffe506`.
  //
  // What should refresh a stored manifest — and when a user-authored one must be
  // left alone, since this file is theirs — is a separate change, left separate on
  // purpose. The `no_test_commands` defect that surfaced it was closed without
  // mutating the file (`src/product-loop/test-command-signal.ts`).
  if (!manifest) {
    const detectedRecipe = await agent.detectVerifyRecipe(baseSettings, options.abortSignal);
    if (detectedRecipe) {
      usedVerifyDetect = true;
      profile = inferVerifyProjectProfile(cwd, baseSettings, detectedRecipe);
      options.onProgress?.(`verify-detect selected recipe for ${profile.appLabel}`);
      manifestPath = saveVerifyEnvironment(cwd, profile.recipe, profile.sandboxSettings);
      options.onProgress?.(`Created verify environment manifest: ${manifestPath}`);
    } else {
      options.onProgress?.(
        "verify-detect did not return a usable recipe; keeping deterministic fallback without writing a manifest",
      );
    }
  }

  const sandboxSettings = buildRuntimeSandboxSettings(profile);
  // Sandbox "off" → run the recipe directly on the host; do NOT bootstrap a
  // `shuru` checkpoint. ensureVerifyCheckpoint spawns `shuru checkpoint …`
  // whenever the recipe has installCommands, regardless of mode — on a host
  // without shuru installed that throws "Executable not found in $PATH: shuru",
  // which parseVerifyResult maps to ERROR (never PASS), pinning the sprint score
  // at 0.00. Skip it when the sole source of truth (getCurrentSandboxMode) is off.
  const checkpoint: PreparedVerifyCheckpoint =
    getCurrentSandboxMode() === "off"
      ? { created: false }
      : await (async () => {
          options.onProgress?.("Preparing verify checkpoint");
          return ensureVerifyCheckpoint(cwd, profile, sandboxSettings);
        })();
  if (getCurrentSandboxMode() === "off") {
    options.onProgress?.("Sandbox off — running verify on host (no shuru checkpoint)");
  }
  if (checkpoint.checkpointName) {
    sandboxSettings.from = checkpoint.checkpointName;
    if (checkpoint.guestWorkdir) {
      sandboxSettings.guestWorkdir = checkpoint.guestWorkdir;
      sandboxSettings.syncHostWorkspace = true;
    }
    options.onProgress?.(
      checkpoint.created
        ? `Created verify checkpoint: ${checkpoint.checkpointName}`
        : `Using verify checkpoint: ${checkpoint.checkpointName}`,
    );
  } else {
    options.onProgress?.("No verify checkpoint needed for this recipe");
  }

  const taskRequest: TaskRequest = {
    agent: "verify",
    description: "Run local verification",
    // Thread the resolved mode so the prompt tells the sub-agent to run "on the
    // host" instead of "inside the active Shuru sandbox" when sandbox is off
    // (the param defaults to "shuru", which was wrong for an off host).
    prompt: buildVerifyTaskPrompt(cwd, sandboxSettings, profile.recipe, getCurrentSandboxMode()),
  };

  return {
    profile,
    sandboxSettings,
    taskRequest,
    checkpoint,
    manifestPath,
    usedVerifyDetect,
  };
}

export async function runVerifyOrchestration(
  agent: VerifyAgentLike,
  options: VerifyOrchestratorOptions = {},
): Promise<ToolResult> {
  const originalSandboxSettings = agent.getSandboxSettings();
  const prepared = await prepareVerifyRun(agent, options);
  agent.setSandboxSettings(prepared.sandboxSettings);
  try {
    options.onProgress?.("Running verify sub-agent");
    const result = await agent.runTaskRequest(prepared.taskRequest, options.onProgress, options.abortSignal);
    return {
      ...result,
      verifyRecipe: prepared.profile.recipe,
    };
  } finally {
    agent.setSandboxSettings(originalSandboxSettings);
  }
}
