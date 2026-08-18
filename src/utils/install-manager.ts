import { spawn } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import semverGt from "semver/functions/gt.js";
import semverValid from "semver/functions/valid.js";
import { fileURLToPath } from "url";

export const GITHUB_REPO = "muonroi/muonroi-cli";
export const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`;
export const SCRIPT_INSTALL_METHOD = "script";

const FETCH_TIMEOUT_MS = 5_000;
const INSTALL_SCHEMA_VERSION = 1;
const PATH_MARKER = "# muonroi-cli";
const CONFIG_FILENAMES = ["user-settings.json", "AGENTS.md"];
const DATA_ENTRIES = ["daemon.pid", "delegations", "muonroi.db", "models", "schedules"];

export interface ReleaseTarget {
  key: "darwin-arm64" | "linux-x64" | "windows-x64";
  assetName: string;
  binaryName: string;
}

export interface ScriptInstallMetadata {
  schemaVersion: number;
  installMethod: typeof SCRIPT_INSTALL_METHOD;
  version: string;
  repo: string;
  binaryPath: string;
  installDir: string;
  assetName: string;
  target: ReleaseTarget["key"];
  installedAt: string;
  shellConfigPath?: string;
  pathCommand?: string;
}

export interface ScriptInstallContext {
  metadata: ScriptInstallMetadata;
  target: ReleaseTarget;
  binaryPath: string;
}

export interface ScriptUpdateRunResult {
  success: boolean;
  output: string;
}

export interface ScriptUninstallOptions {
  dryRun?: boolean;
  force?: boolean;
  keepConfig?: boolean;
  keepData?: boolean;
}

export interface ScriptUninstallPlan {
  removePaths: string[];
  pruneDirs: string[];
  pathCleanup?: { configFile: string; command: string };
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

interface ReleaseDownload {
  version: string;
  asset: GitHubReleaseAsset;
  checksums: GitHubReleaseAsset;
}

export function getUserDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".muonroi-cli");
}

export function getScriptInstallDir(homeDir = os.homedir()): string {
  return path.join(getUserDir(homeDir), "bin");
}

export function getInstallMetadataPath(homeDir = os.homedir()): string {
  return path.join(getUserDir(homeDir), "install.json");
}

export function getReleaseTargetForPlatform(platform = process.platform, arch = process.arch): ReleaseTarget | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64"))
    return { key: "darwin-arm64", assetName: "muonroi-cli-darwin-arm64", binaryName: "muonroi-cli" };
  if (platform === "linux" && arch === "x64")
    return { key: "linux-x64", assetName: "muonroi-cli-linux-x64", binaryName: "muonroi-cli" };
  if (platform === "win32" && arch === "x64")
    return { key: "windows-x64", assetName: "muonroi-cli-windows-x64.exe", binaryName: "muonroi-cli.exe" };
  return null;
}

export function loadScriptInstallMetadata(homeDir = os.homedir()): ScriptInstallMetadata | null {
  const metadataPath = getInstallMetadataPath(homeDir);
  try {
    if (!fs.existsSync(metadataPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Partial<ScriptInstallMetadata>;
    if (parsed.installMethod !== SCRIPT_INSTALL_METHOD) return null;
    if (
      typeof parsed.binaryPath !== "string" ||
      typeof parsed.installDir !== "string" ||
      typeof parsed.assetName !== "string" ||
      typeof parsed.target !== "string"
    )
      return null;
    return {
      schemaVersion: INSTALL_SCHEMA_VERSION,
      installMethod: SCRIPT_INSTALL_METHOD,
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
      repo: typeof parsed.repo === "string" ? parsed.repo : GITHUB_REPO,
      binaryPath: parsed.binaryPath,
      installDir: parsed.installDir,
      assetName: parsed.assetName,
      target: parsed.target as ReleaseTarget["key"],
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : new Date(0).toISOString(),
      shellConfigPath: typeof parsed.shellConfigPath === "string" ? parsed.shellConfigPath : undefined,
      pathCommand: typeof parsed.pathCommand === "string" ? parsed.pathCommand : undefined,
    };
  } catch {
    return null;
  }
}

export function saveScriptInstallMetadata(metadata: ScriptInstallMetadata, homeDir = os.homedir()): void {
  const metadataPath = getInstallMetadataPath(homeDir);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

export function getScriptInstallContext(homeDir = os.homedir()): ScriptInstallContext | null {
  const target = getReleaseTargetForPlatform();
  if (!target) return null;

  const metadata = loadScriptInstallMetadata(homeDir);
  if (metadata) {
    return {
      metadata,
      target: getReleaseTargetForPlatformKey(metadata.target) ?? target,
      binaryPath: metadata.binaryPath,
    };
  }

  return null;
}

// fetchLatestGitTag lived here to answer "is a newer release tagged?" for a
// linked checkout. That was never the right question for a source install (the
// branch moves ahead of the tag), and nothing reads it now that dev-link pulls
// its branch — see checkUpstreamCommits.

export async function fetchLatestReleaseVersion(): Promise<string | null> {
  const release = await fetchReleaseJson(`${RELEASES_API}/latest`);
  return release ? normalizeReleaseVersion(release.tag_name) : null;
}

export async function fetchLatestNpmVersion(pkgName = "muonroi-cli"): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "muonroi-cli",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ? semverValid(data.version) : null;
  } catch {
    return null;
  }
}

export function parseChecksumsFile(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) continue;
    result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

/**
 * How this muonroi-cli was installed. Drives which update path the built-in
 * `/update` flow takes:
 *   - "script"     → install.sh-managed; runScriptManagedUpdate replaces the binary.
 *   - "bun-global" → `bun add -g muonroi-cli`; update via bun.
 *   - "npm-global" → `npm install -g muonroi-cli`; update via npm.
 *   - "compiled"   → standalone single-file binary; re-download / rebuild.
 *   - "dev-link"   → linked/source build run from a git checkout (bun link,
 *                    symlinked global bin, or `bun run src/index.ts`); rebuild dist.
 *   - "unknown"    → can't tell; fall back to generic guidance.
 */
export type InstallMethod = "script" | "bun-global" | "npm-global" | "compiled" | "dev-link" | "unknown";

/** Absolute filesystem path of THIS module, normalized to forward slashes. */
function runningModulePath(): string {
  try {
    return fileURLToPath(import.meta.url).replace(/\\/g, "/");
  } catch {
    return (process.argv[1] ?? "").replace(/\\/g, "/");
  }
}

/** Walk up from `startDir` looking for a `.git` entry; return the repo root or null. */
function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 30 && dir; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Detect how the running muonroi-cli was installed by inspecting the location
 * of this module on disk plus the runtime. Pure path inspection — no I/O beyond
 * the install.json check, so it is safe to call on the hot path.
 */
export function detectInstallMethod(homeDir = os.homedir()): InstallMethod {
  if (loadScriptInstallMetadata(homeDir)) return "script";

  const modPath = runningModulePath();
  const importUrl = (import.meta.url || "").replace(/\\/g, "/");

  // Bun single-file compiled executable embeds modules under a virtual root
  // (e.g. "/$bunfs/" or "/~BUN/"), so the module path is not a real fs path.
  if (importUrl.includes("/$bunfs/") || importUrl.includes("/~BUN/") || modPath.includes("/$bunfs/")) {
    return "compiled";
  }

  // Bun's global install root: ~/.bun/install/global/node_modules/muonroi-cli/...
  if (modPath.includes("/.bun/install/global/")) return "bun-global";

  if (/\/node_modules\/muonroi-cli\//.test(modPath)) {
    return modPath.includes("/.bun/") ? "bun-global" : "npm-global";
  }

  // Not under node_modules and not launched by node/bun → standalone binary.
  const exeBase = ((process.execPath || "").replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  const isNodeOrBunRunner = /^(node|bun)(\.exe|-[\d.]+)?$/i.test(exeBase);
  if (!modPath.includes("/node_modules/") && !isNodeOrBunRunner) {
    return "compiled";
  }

  // Linked/source build run from a git checkout (e.g. `bun link`, a symlinked
  // global bin pointing at the repo, or `bun run src/index.ts`). The "update"
  // here is a rebuild, not a package-manager swap.
  if (modPath && !modPath.includes("/node_modules/") && findGitRoot(path.dirname(modPath))) {
    return "dev-link";
  }

  return "unknown";
}

/**
 * Git checkout this build is running out of, or null when it is not running
 * from a checkout (packaged install / compiled binary).
 */
export function getRunningCheckoutRoot(): string | null {
  const modPath = runningModulePath();
  if (!modPath || modPath.includes("/node_modules/")) return null;
  return findGitRoot(path.dirname(modPath));
}

/**
 * Where a linked source build lives, or null when nothing is linked.
 *
 * `bun link` replaces `~/.bun/install/global/node_modules/muonroi-cli` with a
 * SYMLINK to the checkout, and `~/.bun/bin` sits ahead of the npm global bin on
 * PATH. So once a checkout is linked, a later `npm i -g muonroi-cli` or
 * `bun add -g muonroi-cli` installs fine and is then never executed — the link
 * keeps winning, silently. Measured on this machine: the bun global entry is a
 * symlink to the checkout while an npm global `muonroi-cli` also exists, and
 * `which -a muonroi-cli` lists the bun shim first.
 *
 * Nothing in the CLI can reorder PATH, so the only honest fix is to SAY which
 * build is running and how to give the link back.
 */
export function getLinkedSourceRoot(homeDir = os.homedir()): string | null {
  const linkPath = path.join(homeDir, ".bun", "install", "global", "node_modules", "muonroi-cli");
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return null;
    return fs.realpathSync(linkPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT just means nothing is linked — the common case, not a problem.
    if (code !== "ENOENT") {
      console.error(`[install-manager] could not inspect the bun link at ${linkPath}: ${(err as Error)?.message}`);
    }
    return null;
  }
}

/**
 * Argv form of the package-manager update for a method, or null.
 *
 * Kept as argv (not a shell string) because the CLI RUNS this now instead of
 * printing it — the published package is the product, so `/update` on an
 * installed copy has to update the installed copy. On Windows npm is a `.cmd`
 * shim, which a shell-less spawn cannot execute by its bare name.
 */
export function getUpdateStepForMethod(
  method: InstallMethod,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } | null {
  switch (method) {
    case "bun-global":
      return { cmd: "bun", args: ["add", "-g", "muonroi-cli@latest"] };
    case "npm-global":
      return { cmd: platform === "win32" ? "npm.cmd" : "npm", args: ["install", "-g", "muonroi-cli@latest"] };
    default:
      return null;
  }
}

/** Human-readable form of the same command, for error fallbacks and docs. */
export function getUpdateCommandForMethod(method: InstallMethod): string | null {
  switch (method) {
    case "bun-global":
      return "bun add -g muonroi-cli@latest";
    case "npm-global":
      return "npm install -g muonroi-cli@latest";
    default:
      return null;
  }
}

/**
 * Top-level update entry point. Routes to the script-managed updater for
 * install.sh installs, and returns the correct package-manager command for
 * bun/npm global installs (rather than the misleading "reinstall via install.sh"
 * dead-end). We do NOT auto-spawn the package manager: on Windows overwriting the
 * files of the live process is unreliable, so we hand the user an exact command
 * to run from a fresh terminal.
 */
export async function runManagedUpdate(
  currentVersion: string,
  run: CommandRunner = spawnStep,
  // Injected so each install path can be exercised: a spy on the exported
  // detector does not reach this call, because the module calls its own local
  // binding, and the suite always runs from a checkout (→ always "dev-link").
  method: InstallMethod = detectInstallMethod(),
): Promise<ScriptUpdateRunResult> {
  if (method === "script") return runScriptManagedUpdate(currentVersion);

  const root = findGitRoot(path.dirname(runningModulePath()));

  // A linked checkout is updated, not described. Handled before the release /
  // registry lookups below because none of them describe a source checkout: its
  // update is the commits on its branch, and the newest tag is a different
  // question that the old dev-link output printed as if it were the answer.
  if (method === "dev-link") {
    if (!root) {
      return {
        success: false,
        output: `Running a linked build, but no git checkout was found above ${runningModulePath()} — cannot update automatically.`,
      };
    }
    const result = await runDevLinkUpdate(root, run);
    return { success: result.success, output: `${result.output}${linkShadowNotice(root)}` };
  }

  let latestVersion: string | null = null;

  if (method === "bun-global" || method === "npm-global") {
    latestVersion = await fetchLatestNpmVersion("muonroi-cli");
  } else {
    latestVersion = await fetchLatestReleaseVersion();
    if (!latestVersion) {
      latestVersion = await fetchLatestNpmVersion("muonroi-cli");
    }
  }

  const normalizedCurrent = semverValid(currentVersion);

  let statusHeader = "";
  let hasUpdate = false;

  if (latestVersion && normalizedCurrent) {
    hasUpdate = semverGt(latestVersion, normalizedCurrent);
    if (hasUpdate) {
      statusHeader = `### 🔄 Update Available\n* **Current Version:** \`v${normalizedCurrent}\`\n* **Latest Version:** \`v${latestVersion}\`\n* **Status:** A new version of \`muonroi-cli\` is available!\n\n`;
    } else if (semverGt(normalizedCurrent, latestVersion)) {
      statusHeader = `### 🚀 Ahead of Latest Release\n* **Current Version:** \`v${normalizedCurrent}\`\n* **Latest Version:** \`v${latestVersion}\`\n* **Status:** Your local installation is newer than the remote release tag.\n\n`;
    } else {
      statusHeader = `### ✅ Up to Date\n* **Current Version:** \`v${normalizedCurrent}\`\n* **Latest Version:** \`v${latestVersion}\`\n* **Status:** You are already up to date!\n\n`;
    }
  } else if (normalizedCurrent) {
    statusHeader = `### ⚠️ Update Status\n* **Current Version:** \`v${normalizedCurrent}\`\n* **Status:** Unable to check the latest version from GitHub or NPM.\n\n`;
  }

  const step = getUpdateStepForMethod(method);
  if (step) {
    if (!hasUpdate) {
      const cmd = getUpdateCommandForMethod(method);
      return {
        success: true,
        output: `${statusHeader}Nothing to install. To force a reinstall:\n\`\`\`bash\n${cmd}\n\`\`\``,
      };
    }
    // The published package is the product, so `/update` runs the package
    // manager here rather than handing back a command to paste. It still falls
    // back to the command if the install cannot replace the running files —
    // that is a real failure mode on Windows, not a reason to never try.
    const result = await run({ ...step, cwd: os.tmpdir() });
    if (result.code === 0) {
      return {
        success: true,
        output: `${statusHeader}Installed **v${latestVersion}**. Restart \`muonroi-cli\` to load it.${linkShadowNotice()}`,
      };
    }
    const cmd = getUpdateCommandForMethod(method);
    return {
      success: false,
      output: `${statusHeader}The update could not be installed automatically:\n\n\`\`\`\n${
        result.output || "(no output)"
      }\n\`\`\`\n\nRun it yourself from a terminal where muonroi-cli is not running:\n\`\`\`bash\n${cmd}\n\`\`\`${linkShadowNotice()}`,
    };
  }

  if (method === "compiled") {
    const target = getReleaseTargetForPlatform();
    const asset = target?.assetName ?? "the release asset for your platform";
    const instruction = hasUpdate
      ? `Download the latest \`${asset}\` from [GitHub Releases](https://github.com/${GITHUB_REPO}/releases/latest) and replace the current binary, or rebuild from source.`
      : `If you want to reinstall, download the latest \`${asset}\` from [GitHub Releases](https://github.com/${GITHUB_REPO}/releases/latest) and replace the current binary.`;
    return {
      success: true,
      output: `${statusHeader}${instruction}`,
    };
  }

  const fallback = notScriptManaged("update");
  return {
    success: fallback.success,
    output: `${statusHeader}${fallback.output}`,
  };
}

// ---------------------------------------------------------------------------
// dev-link (linked source checkout) update — actually performs the update
// ---------------------------------------------------------------------------

export interface CommandStep {
  cmd: string;
  args: string[];
  cwd: string;
}

export interface CommandOutcome {
  code: number;
  output: string;
}

export type CommandRunner = (step: CommandStep) => Promise<CommandOutcome>;

const DEV_LINK_STEP_TIMEOUT_MS = 10 * 60_000;

/** Default runner: spawn with no shell, merge stdout+stderr, bounded by a timeout. */
function spawnStep(step: CommandStep): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, { cwd: step.cwd, shell: false, windowsHide: true });
    let out = "";
    const append = (chunk: Buffer | string): void => {
      out += chunk.toString();
      // Bound the buffer: `bun install` on a cold cache prints thousands of
      // lines and the whole thing ends up in a chat bubble.
      if (out.length > 8000) out = `${out.slice(-8000)}`;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      child.kill();
      out += `\n[timed out after ${Math.round(DEV_LINK_STEP_TIMEOUT_MS / 1000)}s]`;
    }, DEV_LINK_STEP_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${out}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: out.trim() });
    });
  });
}

/**
 * Are there commits on the tracked upstream branch that this checkout lacks?
 *
 * For a source checkout, "is there an update" is NOT "is there a newer release
 * tag" — tags lag the branch, so the release check both misses real updates and
 * reports one when the checkout is already ahead of the tag. Asking the remote
 * for the branch head and testing whether this repo already has that object
 * answers the real question, and unlike `git fetch` it writes nothing.
 */
export async function checkUpstreamCommits(
  root: string,
  run: CommandRunner = spawnStep,
): Promise<{ branch: string; behind: boolean } | null> {
  const branch = await run({ cmd: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: root });
  if (branch.code !== 0) return null;
  const name = branch.output.trim();
  if (!name || name === "HEAD") return null; // detached — no upstream to compare against

  const remote = await run({ cmd: "git", args: ["ls-remote", "origin", `refs/heads/${name}`], cwd: root });
  if (remote.code !== 0) return null;
  const sha = remote.output.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{7,40}$/i.test(sha ?? "")) return null;

  const known = await run({ cmd: "git", args: ["cat-file", "-e", `${sha}^{commit}`], cwd: root });
  return { branch: name, behind: known.code !== 0 };
}

/**
 * Update a linked source checkout for real: pull, install, rebuild.
 *
 * The old behaviour printed these three commands and told the user to run them
 * — for the one install method where the CLI has everything it needs to just do
 * the work. Refuses on a dirty tree instead of pulling over uncommitted work.
 */
export async function runDevLinkUpdate(root: string, run: CommandRunner = spawnStep): Promise<ScriptUpdateRunResult> {
  const dirty = await run({ cmd: "git", args: ["status", "--porcelain"], cwd: root });
  if (dirty.code !== 0) {
    return {
      success: false,
      output: `Cannot update: \`git status\` failed in ${root}.\n\n\`\`\`\n${dirty.output}\n\`\`\``,
    };
  }
  if (dirty.output.trim()) {
    const files = dirty.output.trim().split(/\r?\n/);
    const shown = files.slice(0, 10).join("\n");
    return {
      success: false,
      output:
        `### ⚠️ Uncommitted changes in \`${root}\`\n` +
        `Pulling would move the branch under your work, so the update stopped before touching anything.\n\n` +
        `\`\`\`\n${shown}${files.length > 10 ? `\n… ${files.length - 10} more` : ""}\n\`\`\`\n\n` +
        `Commit or stash them, then run \`/update\` again.`,
    };
  }

  const steps: CommandStep[] = [
    { cmd: "git", args: ["pull", "--ff-only"], cwd: root },
    { cmd: "bun", args: ["install"], cwd: root },
    { cmd: "bun", args: ["run", "build"], cwd: root },
  ];

  const log: string[] = [];
  for (const step of steps) {
    const label = `${step.cmd} ${step.args.join(" ")}`;
    const result = await run(step);
    if (result.code !== 0) {
      return {
        success: false,
        output:
          `### ❌ Update failed at \`${label}\`\n\n\`\`\`\n${result.output || "(no output)"}\n\`\`\`\n\n` +
          `The checkout at \`${root}\` is unchanged past this step.`,
      };
    }
    log.push(`✔ ${label}`);
  }

  return {
    success: true,
    output:
      `### ✅ Updated the linked source build\n\`${root}\`\n\n${log.join("\n")}\n\n` +
      `Restart \`muonroi-cli\` to load the rebuilt \`dist/\`.`,
  };
}

export async function runScriptManagedUpdate(currentVersion: string): Promise<ScriptUpdateRunResult> {
  const context = getScriptInstallContext();
  if (!context) return notScriptManaged("update");

  const normalizedCurrent = semverValid(currentVersion);
  if (!normalizedCurrent) {
    return { success: false, output: `Cannot update: current version "${currentVersion}" is invalid.` };
  }

  const release = await resolveReleaseDownload(context.target);
  if (!release) {
    return { success: false, output: "No matching release found for this platform." };
  }

  if (!semverGt(release.version, normalizedCurrent)) {
    return { success: true, output: `Already on the latest version (${normalizedCurrent}).` };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-cli-update-"));
  try {
    const downloadedPath = path.join(tempDir, release.asset.name);
    await downloadBinary(release.asset.browser_download_url, downloadedPath);

    const checksumsText = await downloadText(release.checksums.browser_download_url);
    const expectedHash = parseChecksumsFile(checksumsText).get(release.asset.name);
    if (!expectedHash) return { success: false, output: `Missing checksum for ${release.asset.name}.` };

    if (sha256File(downloadedPath) !== expectedHash) {
      return { success: false, output: `Checksum mismatch for ${release.asset.name}; aborting.` };
    }

    fs.mkdirSync(path.dirname(context.binaryPath), { recursive: true, mode: 0o700 });

    if (process.platform === "win32") {
      return applyWindowsUpdate(tempDir, downloadedPath, context, release);
    }

    const staging = `${context.binaryPath}.new`;
    fs.copyFileSync(downloadedPath, staging);
    fs.chmodSync(staging, 0o755);
    fs.renameSync(staging, context.binaryPath);

    saveScriptInstallMetadata({
      ...context.metadata,
      version: release.version,
      installedAt: new Date().toISOString(),
    });

    return { success: true, output: `Updated to muonroi-cli ${release.version}.` };
  } catch (error) {
    return { success: false, output: error instanceof Error ? error.message : String(error) };
  } finally {
    if (process.platform !== "win32") fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function buildScriptUninstallPlan(
  options: ScriptUninstallOptions = {},
  homeDir = os.homedir(),
): ScriptUninstallPlan | null {
  const context = getScriptInstallContext(homeDir);
  if (!context) return null;

  const userDir = getUserDir(homeDir);
  const removePaths = new Set<string>();
  const pruneDirs = new Set<string>();

  if (!options.keepConfig && !options.keepData) {
    removePaths.add(userDir);
  } else {
    removePaths.add(context.binaryPath);
    removePaths.add(getInstallMetadataPath(homeDir));
    if (!options.keepConfig) for (const f of CONFIG_FILENAMES) removePaths.add(path.join(userDir, f));
    if (!options.keepData) for (const e of DATA_ENTRIES) removePaths.add(path.join(userDir, e));
    pruneDirs.add(getScriptInstallDir(homeDir));
    pruneDirs.add(userDir);
  }

  return {
    removePaths: sortForRemoval([...removePaths]),
    pruneDirs: sortForRemoval([...pruneDirs]),
    pathCleanup:
      context.metadata.shellConfigPath && context.metadata.pathCommand
        ? { configFile: context.metadata.shellConfigPath, command: context.metadata.pathCommand }
        : undefined,
  };
}

export async function runScriptManagedUninstall(options: ScriptUninstallOptions = {}): Promise<ScriptUpdateRunResult> {
  const plan = buildScriptUninstallPlan(options);
  if (!plan) return notScriptManaged("uninstall");

  if (options.dryRun) return { success: true, output: formatDryRun(plan, options) };

  if (!options.force) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return { success: false, output: "Non-interactive terminal. Re-run with --force." };
    }
    if (!(await confirm("Remove muonroi-cli from this machine?"))) {
      return { success: false, output: "Uninstall cancelled." };
    }
  }

  try {
    if (plan.pathCleanup) removePathLine(plan.pathCleanup.configFile, plan.pathCleanup.command);
    for (const p of plan.removePaths) fs.rmSync(p, { recursive: true, force: true });
    for (const d of plan.pruneDirs) removeDirIfEmpty(d);
    return { success: true, output: "muonroi-cli uninstall complete." };
  } catch (error) {
    return { success: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Trailing note for a dev-link update: name the build that is actually running
 * and how to hand PATH back to a published install. Empty when this checkout is
 * not the linked one (then nothing is being shadowed by it).
 */
function linkShadowNotice(root?: string): string {
  const linked = getLinkedSourceRoot();
  if (!linked) return "";
  if (root && path.resolve(linked).toLowerCase() !== path.resolve(root).toLowerCase()) return "";
  const lead = root
    ? `**This is the linked build** (\`bun link\` → \`${linked}\`), and it takes priority over`
    : `**A linked source build exists** (\`bun link\` → \`${linked}\`) and takes priority over`;
  return (
    `\n\n---\n${lead} any \`npm i -g muonroi-cli\` / \`bun add -g muonroi-cli\` install on this machine — ` +
    "the installed package stays on disk but never runs, so an update to it changes nothing you can see. " +
    "To hand the command back to the published package, remove the link:\n" +
    "```bash\nbun unlink muonroi-cli\n```"
  );
}

function notScriptManaged(action: string): ScriptUpdateRunResult {
  return {
    success: false,
    output: `This install is not script-managed, so \`muonroi-cli ${action}\` cannot proceed. Use the package manager you installed with, or reinstall via install.sh.`,
  };
}

function getReleaseTargetForPlatformKey(key: string): ReleaseTarget | null {
  switch (key) {
    case "darwin-arm64":
      return { key, assetName: "muonroi-cli-darwin-arm64", binaryName: "muonroi-cli" };
    case "darwin-x64":
      return { key: "darwin-arm64", assetName: "muonroi-cli-darwin-arm64", binaryName: "muonroi-cli" };
    case "linux-x64":
      return { key, assetName: "muonroi-cli-linux-x64", binaryName: "muonroi-cli" };
    case "windows-x64":
      return { key, assetName: "muonroi-cli-windows-x64.exe", binaryName: "muonroi-cli.exe" };
    default:
      return null;
  }
}

async function resolveReleaseDownload(target: ReleaseTarget): Promise<ReleaseDownload | null> {
  const release = await fetchReleaseJson(`${RELEASES_API}/latest`);
  if (!release) return null;
  const version = normalizeReleaseVersion(release.tag_name);
  if (!version) return null;

  const asset = release.assets.find((a) => a.name === target.assetName);
  const checksums = release.assets.find((a) => a.name === "checksums.txt");
  if (!asset || !checksums) return null;

  return { version, asset, checksums };
}

async function fetchReleaseJson(url: string): Promise<GitHubRelease | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "muonroi-cli",
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
    });
    clearTimeout(timer);
    return res.ok ? ((await res.json()) as GitHubRelease) : null;
  } catch {
    return null;
  }
}

function normalizeReleaseVersion(tagName: string): string | null {
  let version = tagName;
  if (version.startsWith("muonroi-cli-dev@")) version = version.slice("muonroi-cli-dev@".length);
  if (version.startsWith("v")) version = version.slice(1);
  return semverValid(version);
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "text/plain" } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  return await res.text();
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sortForRemoval(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => b.length - a.length);
}

function removeDirIfEmpty(dir: string): void {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* best effort */
  }
}

function removePathLine(configFile: string, command: string): void {
  if (!fs.existsSync(configFile)) return;
  const lines = fs.readFileSync(configFile, "utf8").split(/\r?\n/);
  fs.writeFileSync(
    configFile,
    `${lines
      .filter((l) => l !== PATH_MARKER && l !== command)
      .join("\n")
      .replace(/\n+$/, "")}\n`,
  );
}

function formatDryRun(plan: ScriptUninstallPlan, options: ScriptUninstallOptions): string {
  const lines = ["Dry run — would perform:"];
  if (plan.pathCleanup) lines.push(`  remove PATH entry from ${plan.pathCleanup.configFile}`);
  for (const p of plan.removePaths) lines.push(`  remove ${p}`);
  if (options.keepConfig) lines.push("  keep config files");
  if (options.keepData) lines.push("  keep data files");
  return lines.join("\n");
}

async function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function applyWindowsUpdate(
  tempDir: string,
  downloadedPath: string,
  context: ScriptInstallContext,
  release: ReleaseDownload,
): ScriptUpdateRunResult {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Start-Sleep -Seconds 2",
    `Move-Item -LiteralPath '${esc(downloadedPath)}' -Destination '${esc(context.binaryPath)}' -Force`,
  ].join("\n");

  const scriptPath = path.join(tempDir, "apply-update.ps1");
  fs.writeFileSync(scriptPath, script);

  saveScriptInstallMetadata({ ...context.metadata, version: release.version, installedAt: new Date().toISOString() });

  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    success: true,
    output: `Updated to muonroi-cli ${release.version}. Restart the CLI to use the new version.`,
  };
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}
