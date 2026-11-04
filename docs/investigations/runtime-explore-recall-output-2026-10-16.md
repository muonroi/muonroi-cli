# Runtime feedback: explore admission, EE scope, and shell output

Measured 2026-10-16 against the current dirty working tree. No commit, push, remote deployment, original DB/settings write, or live paid worker request was performed.

## Original runtime evidence

The original SQLite database was opened with `mode=ro`. Session `7fea31350fc7`, assistant seq 4 and tool seq 5, contains:

| Claim | Recorded evidence | Conclusion |
|---|---|---|
| Minimal explore task blocked | `task`, call `chatcmpl-tool-9631bd8f27d70cdc`, agent `explore`, background true, prompt requesting only alive/timestamp; result starts `BLOCKED: this task was assessed as non-trivial.` | Confirmed gate admission defect. |
| Delegate also blocked | No `delegate` call in this session | Unverified claim; current gate already exempts delegate. |
| Bash succeeded but lost stdout | `bash`, call `chatcmpl-tool-b625c9e7bb335915`, command `echo \"runtime-check-ok\" && date -u +%s`; result is the same GSD BLOCKED directive | Command did not execute. This trace does not demonstrate stdout loss or a successful shell exit. |
| EE reachable but recall denied | `ee_health` returns `{"ok":true,"status":200}`; `ee_query` returns `[ee_scope_unverified]` | Confirmed distinction between reachability and project-scope verification. |

The same trace lists nine historical delegation rows (eight complete, one error), despite the agent's description of eight rows. The catalog error is historical; this investigation did not reproduce its model resolution or change model settings.

## Changes

- `src/gsd/mutation-gate.ts`: admit only `task` with exact built-in `agent="explore"`. Keep general, verify, computer, custom/invalid agents, arbitrary bash, and mutations gated. Do not alter GSD depth or the actual review verdict.
- `src/ee/search.ts`: keep strict scope fail-closed, clarify that a responding endpoint/health 200 does not establish scope enforcement, and identify required server support. Scope diagnostics now use `logger.file` with booleans only; no lesson text, credentials, or workspace path is emitted to the terminal.

Explore safety was checked against the actual executors: registry routes explore to the read-only delegation executor when available; native StreamRunner fallback uses ask mode, excludes mutation tools and MCP merge, and separately gates its shell against the originating main cwd. The patch preserves that shell gate. This does not declare shell commands intrinsically read-only.

## Live EE measurement

Using the existing compiled EE client and its normal auth/base-URL resolution, one strict recall was sent with the actual caller cwd. Only response metadata was saved; returned lessons were withheld.

- Measured at `2026-10-16T07:00:05.447Z`.
- Health: `ok=true`, status 200.
- Recall elapsed: **8104 ms**.
- Response keys: `text`, `entries`, `count`, `query`.
- Response count: 21; scope absent; matching strict scope proof: false.

This confirms the live endpoint did not supply the proof required by CLI in this request. It does not establish whether its internal retrieval enforced filtering. The local sibling EE checkout's `server.js:1271` handler also returns these four fields without proof; that checkout is not proof of the deployed server revision.

## Verification

| Check | Result | Boundary |
|---|---|---|
| Gate regression before fix | 1 failed, 17 passed | Exact explore smoke input reproduces denial. |
| Focused Vitest after fix | **61 passed / 6 files** | Gate matrix, task routing, actual child setup, strict recall, child contract. Vitest emitted its existing nested `vi.mock("bun:sqlite")` warning. |
| Child attempted shell write with alternate cwd | Blocked; target absent | Confirms the originating main plan still controls child shell. |
| `bun run build` | Exit 0 | No build errors or warning lines in the saved build log. |
| Compiled Agent → main wrapper → SDK fixture | **8/8** | Five mocked SDK requests; child launch stubbed. Explore/delegate admitted, general/bash blocked, verdict unchanged. No paid child invocation. |
| Native/MCP controls | **15/15** | Existing bounded fixture controls, additional regression only; not a new proof of every changed path. |
| Native `selfverify_*` smoke + passive-log | **2/2** | Run `fb7371a0-0f66-4a2f-b933-0a59a9ef0cbc`, isolated home/DB and mock model. Not live-provider or full UI coverage. |
| Whitespace | Exit 0 | Current working tree diff. |

Private reproducible scripts/logs are under `.scratch/runtime-explore-recall-output/`: `probe-ee.mjs`, `ee-metadata.json`, `verify-main.mjs`, `main-result.json`, `verify-native.mjs`, `native-result.json`, `gate-red.log`, `tests.log`, `build.log`, `main.log`, `native.log`, `diff-check.log`. Compiled-main logs contain expected unavailable EE warnings from its isolated fixture, not from the separate live EE measurement. No full-suite or live worker end-to-end pass is claimed.

## Questions for a fresh CLI / EE session

1. EE server: identify the deployed `/api/recall` revision and whether it implements `strict_project=true`. Please provide a redacted request/response metadata example, not an API key or private recalled content.
2. Define server-side strict filtering and proof: CLI currently accepts `scope.strict=true` and a matching explicit `scope.project`, or matching caller `scope.cwd` when no project is explicit. How are Windows paths, home-relative transport paths, and project aliases canonicalized? Which global lessons, if any, are allowed under strict scope? Do not return proof until filtering is actually enforced.
3. After restarting the rebuilt CLI/MCP, retry only the minimal explore task. If `delegate` is blocked, provide its exact call, result, session ID, and toolCallId. If bash output is missing, provide an executed command's raw result/exit code and run_id; a GSD BLOCKED response is not a successful execution.

The immediate CLI admission defect is repaired and locally built. EE strict recall remains unavailable until a matching server contract is implemented and verified. Safe-mode approvals and external MCP availability were not changed.
