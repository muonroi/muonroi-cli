# Cost-optimization — verification protocol

**Branch:** `feat/cost-optimization`
**Baseline session (pre-fix):** `b58603caceb9` — 1 user prompt → 504,737 input tokens, 686,214 total billed.

This is the script for the user to run after Phase A/B/C land, to confirm
the acceptance target (≤80K input for an OAuth-explore-class prompt).

---

## 1. Setup

```bash
cd D:/Personal/Core/muonroi-cli
git checkout feat/cost-optimization
git pull   # in case of additional commits
bun install
bunx tsc --noEmit       # must be 0 errors
```

Confirm caps active:

```bash
# These print the effective values the runtime will use.
bun -e 'import { getSubAgentBudgetChars } from "./src/utils/settings.js"; console.log("subAgentBudgetChars =", getSubAgentBudgetChars())'
bun -e 'import { MAX_TOOL_OUTPUT_CHARS } from "./src/tools/registry.js"; console.log("MAX_TOOL_OUTPUT_CHARS =", MAX_TOOL_OUTPUT_CHARS)'

# Expected:
#   subAgentBudgetChars = 120000   (or whatever the user set)
#   MAX_TOOL_OUTPUT_CHARS = 32000  (or env override)
```

Tighten the caps to make the test more aggressive (optional):

```powershell
$env:MUONROI_SUB_AGENT_BUDGET_CHARS = "60000"   # half the default
$env:MUONROI_MAX_TOOL_OUTPUT_CHARS = "16000"    # half the default
```

---

## 2. Repro — equivalent of the `b58603caceb9` workload

Open the TUI and submit one prompt that is structurally similar to the
known-bad baseline (file exploration across the OAuth surface area):

```
check cho tôi tôi muốn dùng chức năng oauth của openAI trong cli muonroi này thì làm sao nhé, tôi đã làm rồi
```

Wait for the assistant to finish (it will delegate to a `task` sub-agent
and read multiple files). Note the session ID shown in the status bar
(first 12 chars; full ID is in `~/.muonroi-cli/muonroi.db`).

Exit the TUI cleanly (`/exit` or `Ctrl-D` — do NOT `Ctrl-C` mid-turn,
that hides the persistence-loss bug under A4).

---

## 3. Verify

```bash
bun run src/index.ts usage forensics <session-id-prefix>
```

### Acceptance criteria — ALL must hold

| Check | Pass if |
|---|---|
| Peak single-call `input_tokens` | **≤ 80,000** (was 504,737 in baseline) |
| All `message`-source events have non-NULL `message_seq` | reported as "✓ No anomalies" or only the Phase C1 cache flag if model is DeepSeek |
| Cumulative `total input` across the session | meaningfully smaller than baseline (~686K → expect ~80–150K typical) |
| Sub-agent dedup hits (when applicable) | non-zero only if the agent re-read the same file; usually zero on a clean first run |

Sample passing output:

```
Cost forensics — session abc123def456
────────────────────────────────────────────────────────────────────────
User prompts:        1
Tool calls (log):    7
LLM events:          6
Total input tokens:  72,401
Total output tokens: 1,200
Cache read tokens:   45,800 (63.3% of input)
Cache create tokens: 0
Peak single call:    32,800 input         ← ✓ under 80K target
Estimated cost:      $0.0067

Anomalies:
  ⚠ deepseek route has zero cache_creation_tokens across 72401 input tokens — prompt caching not wired (Phase C1 open)
```

The remaining anomaly is expected (Phase C1 is intentionally out of scope
for this PR — wiring DeepSeek prefix cache requires confirming whether
`@ai-sdk/openai-compatible` v6 forwards `extra_body`).

### If acceptance FAILS

| Failure mode | Likely cause | Where to look |
|---|---|---|
| Peak still > 80K with `task` source | `wrapToolSetWithCap` not on the codepath | `orchestrator.ts` near line 1220 (childBaseToolsRaw vs childBaseTools), and the MCP merge re-wrap at the `closeMcp = …` line |
| Peak > 80K with `message` source (no sub-agent) | Top-level orchestrator hitting same problem — out of scope; file a follow-up task | n/a |
| `message_seq` still NULL | Settings or stale build | `bun run build:binary` then re-run, or check `lastPersistedSeq` import in orchestrator.ts |
| `dedupHits` always 0 even when retrying obvious dups | The dup must be **inside the same sub-agent invocation**; cross-invocation dedup is not implemented | by design |

---

## 4. Report back

If acceptance holds, paste the forensics summary output into the PR
description. If it fails, paste the output plus the value of:

```bash
git log --oneline master..HEAD
```

so we can correlate which commit introduced the regression.

---

## 5. Optional — A/B compare on the same prompt

To prove the win quantitatively:

```bash
# Run 1 — baseline (revert caps to "off" via huge limits)
$env:MUONROI_SUB_AGENT_BUDGET_CHARS = "600000"
$env:MUONROI_MAX_TOOL_OUTPUT_CHARS = "200000"
# … run the prompt …
bun run src/index.ts usage forensics <session-1> --json > before.json

# Run 2 — defaults (caps active)
Remove-Item Env:MUONROI_SUB_AGENT_BUDGET_CHARS
Remove-Item Env:MUONROI_MAX_TOOL_OUTPUT_CHARS
# … run the same prompt …
bun run src/index.ts usage forensics <session-2> --json > after.json
```

Compare `totalInput` and `peakSingleCallInput` between the two JSON
files. Expect ≥ 4× reduction on file-heavy prompts.
