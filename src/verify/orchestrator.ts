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

  // WHY THE MANIFEST IS CACHED, AND WHAT THE CACHE IS ALLOWED TO DECIDE.
  //
  // `agent.detectVerifyRecipe` is a full LLM sub-agent turn (`agent:
  // "verify-detect"`, src/orchestrator/orchestrator.ts:4541) — billed tokens,
  // latency, non-deterministic output. It is also the only source of things no
  // disk scan can produce: the apt/nodesource bootstrap sequence, `docker compose
  // up -d`, the smoke target, the evidence and notes written after reading the
  // repo. That is what the `!manifest` gate protects, and it stays: an existing
  // manifest still means no second model turn.
  //
  // What the cache is NOT allowed to decide is the half the disk answers for
  // free. `inferVerifyProjectProfile` above now MERGES the stored recipe with the
  // live derivation instead of being replaced by it, so a manifest written once no
  // longer freezes the recipe: every detection improvement reaches
  // `profile.recipe` on the next run, with no model call and no file write. The
  // per-field rule, and why an existing manifest is never rewritten (it carries no
  // provenance, so a loop-written record and a hand-authored one are
  // indistinguishable), are argued in `src/verify/recipe-merge.ts`.
  if (!manifest) {
    const detectedRecipe = await agent.detectVerifyRecipe(baseSettings, options.abortSignal);
    if (detectedRecipe) {
      usedVerifyDetect = true;
      profile = inferVerifyProjectProfile(cwd, baseSettings, detectedRecipe);
      options.onProgress?.(`verify-detect selected recipe for ${profile.appLabel}`);
      // The MODEL's recipe is what gets persisted — deliberately NOT
      // `profile.recipe`, which is that recipe already merged with today's disk
      // derivation. Persisting the merge would freeze this run's derived commands
      // into the record, and since the merge only ever ADDS, a later fix to a
      // WRONG derived command could never take effect. Nothing is lost by writing
      // the un-merged recipe: the derived half is recomputed on every load, and so
      // are the two runtime rewrites `inferVerifyProjectProfile` applies
      // (`smokeTarget` from the port mapping, the missing-node_modules note).
      manifestPath = saveVerifyEnvironment(cwd, detectedRecipe, profile.sandboxSettings);
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
