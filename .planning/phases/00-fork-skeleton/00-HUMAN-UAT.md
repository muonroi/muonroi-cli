---
status: partial
phase: 00-fork-skeleton
source: [00-VERIFICATION.md]
started: 2026-04-29T00:00:00Z
updated: 2026-04-29T00:00:00Z
---

## Current Test

[awaiting human testing — blocked on Anthropic API key]

## Tests

### 1. Anthropic streaming + zero key leak (SC2)
expected: `bun run src/index.ts --prompt "say hi"` streams a reply; `grep -c "sk-ant-"` returns 0
result: [pending — no API key]

### 2. --session latest resumes prior messages (SC3)
expected: `bun run src/index.ts --session latest` renders prior session messages or empty welcome
result: [pending — no API key]

### 3. Ctrl+C mid-tool-call, no orphan .tmp files (SC4)
expected: After Ctrl+C during tool execution, no .tmp files in ~/.muonroi-cli/sessions/<id>/; pending_calls.jsonl shows status=aborted/settled
result: [pending — no API key]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 3

## Gaps
