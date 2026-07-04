import { exec, spawn } from "child_process";
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

export function fetchLatestGitTag(gitDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`git -C "${gitDir}" ls-remote --tags origin`, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const lines = stdout.split(/\r?\n/);
      let maxVersion: string | null = null;

      for (const line of lines) {
        const match = line.match(/refs\/tags\/(v?[0-9]+\.[0-9]+\.[0-9]+[^\s]*)$/);
        if (!match) continue;
        let tag = match[1];
        if (tag.endsWith("^{}")) {
          tag = tag.slice(0, -3);
        }
        const version = normalizeReleaseVersion(tag);
        if (!version) continue;

        if (!maxVersion || semverGt(version, maxVersion)) {
          maxVersion = version;
        }
      }
      resolve(maxVersion);
    });
  });
}

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

/** Package-manager command that updates muonroi-cli for the given method, or null. */
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
export async function runManagedUpdate(currentVersion: string): Promise<ScriptUpdateRunResult> {
  const method = detectInstallMethod();

  if (method === "script") return runScriptManagedUpdate(currentVersion);

  const root = findGitRoot(path.dirname(runningModulePath()));
  let latestVersion: string | null = null;

  if (method === "dev-link" && root) {
    latestVersion = await fetchLatestGitTag(root);
  } else if (method === "bun-global" || method === "npm-global") {
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

  const cmd = getUpdateCommandForMethod(method);
  if (cmd) {
    const instruction = hasUpdate
      ? `To update, run this in a fresh terminal:\n\`\`\`bash\n${cmd}\n\`\`\`\nThen restart \`muonroi-cli\`.`
      : `If you want to reinstall, run this in a fresh terminal:\n\`\`\`bash\n${cmd}\n\`\`\``;
    return {
      success: true,
      output: `${statusHeader}${instruction}`,
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

  if (method === "dev-link") {
    const target = root ?? "the muonroi-cli checkout";
    const instruction = hasUpdate
      ? `To update, pull the latest changes and rebuild:\n\`\`\`bash\ngit -C "${target}" pull && bun install && bun run build\n\`\`\`\nThen restart \`muonroi-cli\`. (If you also use the compiled muonroi-cli-dev binary, rebuild that separately.)`
      : `To rebuild your local installation:\n\`\`\`bash\ngit -C "${target}" pull && bun install && bun run build\n\`\`\`\nThen restart \`muonroi-cli\`.`;
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
