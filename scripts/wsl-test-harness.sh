#!/usr/bin/env bash
# Run harness E2E tests in WSL Ubuntu against a fresh sync of master.
#
# From Windows PowerShell:
#   wsl -d Ubuntu -- bash -lc 'bash /mnt/d/sources/Core/muonroi-cli/scripts/wsl-test-harness.sh'
#
# Or from inside WSL:
#   bash ~/muonroi-cli/scripts/wsl-test-harness.sh
#
# Assumes one-time setup from CLAUDE.md "WSL setup" is done.

set -euo pipefail

WSL_REPO="${HOME}/muonroi-cli"
TARGET="${1:-tests/harness/}"

if [ ! -d "${WSL_REPO}" ]; then
  echo "FATAL: ${WSL_REPO} not found — run one-time setup from CLAUDE.md first" >&2
  exit 1
fi

cd "${WSL_REPO}"

echo "==> Sync from origin"
git fetch --quiet origin master
git checkout --quiet master
git reset --hard --quiet origin/master

echo "==> Installing deps (Linux native)"
bun install --silent 2>&1 | tail -3 || bunx --silent --version >/dev/null

echo "==> Typecheck"
bunx tsc --noEmit

echo "==> Run target: ${TARGET}"
bunx vitest run "${TARGET}"
