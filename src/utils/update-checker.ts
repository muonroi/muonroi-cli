import semverGt from "semver/functions/gt.js";
import semverValid from "semver/functions/valid.js";
import {
  checkUpstreamCommits,
  detectInstallMethod,
  fetchLatestNpmVersion,
  fetchLatestReleaseVersion,
  getRunningCheckoutRoot,
  runManagedUpdate,
} from "./install-manager";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  /**
   * What to render as the update target. A source checkout has no "next
   * version" to show — its update is "the commits on your branch" — so the
   * banner cannot just print `v{latestVersion}` for every install method.
   */
  latestLabel: string;
}

export interface UpdateRunResult {
  success: boolean;
  output: string;
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
  try {
    const method = detectInstallMethod();

    // A source checkout updates by pulling its branch, not by installing a
    // release, so a release-tag comparison answers the wrong question: tags lag
    // the branch, so it stays silent while the checkout falls commits behind
    // and it claims an update when the checkout is already ahead of the tag.
    if (method === "dev-link") {
      const root = getRunningCheckoutRoot();
      if (!root) return null;
      const upstream = await checkUpstreamCommits(root);
      if (!upstream) return null;
      const normalized = semverValid(currentVersion) ?? currentVersion;
      return {
        currentVersion: normalized,
        latestVersion: normalized,
        hasUpdate: upstream.behind,
        latestLabel: upstream.behind ? `new commits on ${upstream.branch}` : `v${normalized}`,
      };
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

    if (!latestVersion || !semverValid(latestVersion)) return null;

    const normalizedCurrent = semverValid(currentVersion);
    if (!normalizedCurrent) return null;

    const hasUpdate = semverGt(latestVersion, normalizedCurrent);
    return { currentVersion: normalizedCurrent, latestVersion, hasUpdate, latestLabel: `v${latestVersion}` };
  } catch {
    return null;
  }
}

export function runUpdate(currentVersion: string): Promise<UpdateRunResult> {
  return runManagedUpdate(currentVersion);
}
