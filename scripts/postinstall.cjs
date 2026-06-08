#!/usr/bin/env node
/**
 * postinstall.cjs — Node-compatible install hook.
 *
 * Two responsibilities:
 *
 * 1. Workspace dev mode (cloned repo, contains packages/agent-harness-core):
 *    create @muonroi/* symlinks under node_modules. Mirrors the legacy
 *    postinstall.ts behaviour for Bun on Windows.
 *
 * 2. Consumer install (npm i -g muonroi-cli, no packages/ dir):
 *    probe keytar load. If it failed to build (missing native toolchain on
 *    Windows / libsecret on Linux), print a friendly notice telling the user
 *    they can still use env vars instead. Never exits non-zero — `npm i`
 *    should always succeed even if keytar can't be built.
 *
 * Written as CommonJS (.cjs) so it runs cleanly on bare Node 20+ without
 * needing the package's "type":"module" setting to apply.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const isWorkspaceDevMode = fs.existsSync(path.join(ROOT, "packages", "agent-harness-core"));

function workspaceLinks() {
  const links = [
    ["@muonroi/agent-harness-core", "packages/agent-harness-core"],
    ["@muonroi/agent-harness-opentui", "packages/agent-harness-opentui"],
    ["@muonroi/agent-harness-react", "packages/agent-harness-react"],
    ["@muonroi/agent-harness-angular", "packages/agent-harness-angular"],
  ];
  for (const [name, pkg] of links) {
    const [scope, shortName] = name.split("/");
    const scopeDir = path.resolve(ROOT, "node_modules", scope);
    const linkPath = path.resolve(scopeDir, shortName);
    const target = path.resolve(ROOT, pkg);

    if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
    if (fs.existsSync(linkPath)) continue;

    try {
      fs.symlinkSync(target, linkPath, "junction");
    } catch (e) {
      console.warn(`  [warn] Could not link ${name}: ${e.message}`);
    }
  }
}

function probeKeytar() {
  try {
    require("keytar");
    // OK — keychain access will work at runtime.
  } catch (e) {
    process.stderr.write(
      "\n  ⚠ keytar (OS keychain) failed to build/load.\n" +
        `    Reason: ${e.message.split("\n")[0]}\n` +
        "    muonroi-cli will fall back to environment variables for API keys (still works).\n" +
        "    To enable secure keychain storage, install the required libraries:\n" +
        "      Linux (runtime):   Fedora: sudo dnf install libsecret\n" +
        "                         Ubuntu/Debian: sudo apt-get install libsecret-1-0\n" +
        "      Linux (build):     Also install the -devel package if building from source.\n" +
        "      Windows:           npm install -g windows-build-tools or VS Build Tools\n" +
        "      macOS:             xcode-select --install\n" +
        "    Then re-run: npm install -g muonroi-cli\n" +
        "    In headless/SSH/CI environments without a keyring daemon, env vars are recommended.\n\n",
    );
  }
}

if (isWorkspaceDevMode) {
  workspaceLinks();
} else {
  probeKeytar();
}
