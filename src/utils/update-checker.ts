import semverGt from "semver/functions/gt.js";
import semverValid from "semver/functions/valid.js";
import {
  detectInstallMethod,
  fetchLatestNpmVersion,
  fetchLatestReleaseVersion,
  runManagedUpdate,
} from "./install-manager";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
}

export interface UpdateRunResult {
  success: boolean;
  output: string;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
  try {
    const method = detectInstallMethod();
    let latestVersion: string | null = null;
    if (method === "bun-global" || method === "npm-global") {
      latestVersion = await fetchLatestNpmVersion("muonroi-cli");
    } else {
      latestVersion = await fetchLatestReleaseVersion();
      if (!latestVersion) {
        latestVersion = await fetchLatestNpmVersion("muonroi-cli");
      }
    }

    if (!latestVersion || !semverValid(latestVersion)) return null;

    const normalizedCurrent = semverValid(currentVersion);
    if (!normalizedCurrent) return null;

    const hasUpdate = semverGt(latestVersion, normalizedCurrent);
    return { currentVersion: normalizedCurrent, latestVersion, hasUpdate };
  } catch {
    return null;
  }
}

export function runUpdate(currentVersion: string): Promise<UpdateRunResult> {
  return runManagedUpdate(currentVersion);
}
