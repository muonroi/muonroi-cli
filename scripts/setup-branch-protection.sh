#!/usr/bin/env bash
#
# Apply branch-protection rules to master. Requires:
#   - gh CLI authenticated as a repo admin
#   - jq available
#
# Idempotent: re-runnable when CI job names change.

set -euo pipefail

REPO="${REPO:-muonroi/muonroi-cli}"
BRANCH="${BRANCH:-master}"

# Required status checks must match exact job names from .github/workflows/*.yml
CHECKS=$(jq -nc '[
  {context: "test (ubuntu-latest)"},
  {context: "test (windows-latest)"},
  {context: "test (macos-latest)"},
  {context: "build-smoke (ubuntu-latest)"}
]')

PAYLOAD=$(jq -nc \
  --argjson checks "$CHECKS" \
  '{
    required_status_checks: { strict: true, checks: $checks },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true
  }')

echo "[branch-protect] applying to ${REPO}@${BRANCH}…"
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  --input - <<<"$PAYLOAD"

echo "[branch-protect] done."
