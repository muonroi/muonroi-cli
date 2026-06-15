# Fix & Improvement Plan — from Verification Pass 1

> Source: [VERIFY-PLAN-30-RESULTS.md](VERIFY-PLAN-30-RESULTS.md). Acceptance criterion: **best solution at cheapest cost.**
> Each item is a small, independently-verifiable change. Blockers first. Branch fixes off **master** (clean) — not `feat/council-derobotize` (carries AbortSignal WIP).

## PR1 — BLOCKER: headless clean exit (F10 + F12)

- **Problem:** `mu -p "<any tool-using prompt>"` produces correct, evidence-first output then **never exits** (~255s idle until killed). Breaks the entire CI/scripting use case.
- **Root cause (evidenced):** turn finishes (finishReason=stop, ~15s) but a lingering open handle keeps the event loop alive. `runHeadless` (index.ts:622-698) calls `agent.cleanup()` then returns — no forced exit. `[MCP] buildMcpToolSet timed out` leaves a pending MCP connection/timer (F12).
- **Fix (cheap):**
  1. Tear down MCP clients/transports + clear timers in headless cleanup.
  2. Short-circuit `buildMcpToolSet` in headless when servers are unreachable (avoid the timeout entirely).
  3. Backstop: after `agent.cleanup()` in `runHeadless`, `process.exit(0)` (or unref the lingering handle) — mirror whatever lets the no-tool PONG path exit.
- **Verify:** `mu -p "read package.json and print version" --permission yolo` exits 0 in <20s. Add a headless-exit regression (spawn child, assert it exits within N s of producing output).
- **Effort:** S · **Impact:** unblocks all headless/CI + task 5.

## PR2 — UX: slash-menu correctness (F5 + F6)

- **F5:** typing the exact name `/status` selects `/ee` (word "status" is in /ee's description). Fix the ranker so exact/prefix **name** matches outrank **description**-substring matches and auto-select the exact hit.
- **F6:** when typed text has no menu match, the menu pre-selects `/exit` → Enter can quit. Fix: don't pre-select a destructive default on no-match; close the menu so Enter submits the raw command (lets hidden cmds run). Decide whether `/route` should be un-hidden (it's a documented transparency command).
- **Verify (harness):** type `/status` → `/status` runs; type `/route x` → routing card, never `/exit`.
- **Effort:** S-M · **Impact:** high — "typing the right command runs the wrong one / quits" is a trust-killer.

## PR3 — doctor trust (F9 + F1)

- **F9:** `doctor` ee.health reports "unreachable" while its own field says `server=ok` and EE is actually up (live ee_health=200). Fix the verdict logic / use the same reachability path the MCP uses.
- **F1:** add a `dotnet` probe (core BB pillar dep; currently invisible to doctor).
- **Verify:** `doctor` → EE PASS when up; `dotnet` PASS/FAIL line present.
- **Effort:** S · **Impact:** doctor is the preflight everyone trusts; false-negatives erode it.

## PR4 — polish batch (F2, F3, F4, F8, F11, F7)

| F | Fix | Effort |
|---|-----|--------|
| F2 | catalog grok descriptions → English; drop self-aliases | trivial |
| F3 | route `⏳ Processing…` + `Session:` to stderr in `--format text` (clean stdout for pipes) | trivial |
| F4 | record durationMs/drift for `orchestrator.message` callsite | S |
| F8 | widen self-verify Semantic-ID→scenario mapping (catch message-view.tsx/text.ts) | M |
| F11 | publish/restore `Muonroi.BaseTemplate@1.0.0-alpha.3` to LocalNuGetFeed (or bump ref) | S |
| F7 | confirm TUI default model (xai, no key) is env-specific vs a real bad default; if real → keyed default or boot warn | S (confirm first) |

## Optional follow-up (full E2E for deferred tasks)

Tasks 19, 23, 27, 28, 29, 30 were deferred (expensive real-LLM/E2E; logic already spec-verified). Recommend **not** spending on full E2E unless a fix needs live confirmation. If desired later: 28 needs a simulated EE outage; 22/24 need a scratch worktree of building-block + the F11 template.

## Sequencing

PR1 (blocker, widest blast radius, cheap) → PR2 (cheap, high visibility) → PR3 (operational trust) → PR4 (batched low-risk polish). Each PR small + independently green = cheapest path.
