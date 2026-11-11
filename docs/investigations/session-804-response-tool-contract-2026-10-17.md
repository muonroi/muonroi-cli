# Session 804115f7251f: unavailable helper response tool

## Finding

The displayed `✗ respond_general` represents a real CLI helper contract error. The host-generated sub-session overlay required a response tool that was absent from the helper's exposed tool set. This incident is not evidence of exhausted credits, an HTTP429, or a missing main answer.

| Evidence | Observed value |
| --- | --- |
| Main session | `804115f7251f` |
| Helper | `ccb10ee4d77d` |
| Failed tool call | `chatcmpl-tool-8935e6ba1809840f`, helper seq17–18 |
| Error record | interaction_logs60874, `2026-10-17T07:22:02.088Z` |
| Actual error | `Model tried to call unavailable tool 'respond_general'.` |
| Arguments | Parsed object with `response`,1644 characters; unavailable-tool failure, not invalid response arguments |
| Main outcome | Final assistant text persisted at seq17; event60950 reports textLength5144/toolCallCount17 |

The pre-fix overlay explicitly stated: `you MUST return your final response using the 'respond_general' (or final answer) tool.` It also claimed full tool access. These were host instructions, not an invented requirement from the user's assignment.

## Change

- `src/orchestrator/orchestrator.ts:4251` now limits helper tool use to tools actually exposed, within existing role/permission/scope boundaries.
- `src/orchestrator/orchestrator.ts:4253` requests a concise plain assistant handoff, including blockers. A final-answer tool is not required. Main still owns acceptance and the user-facing final.
- `src/orchestrator/sub-session-tool-contract.ts:16` updates exact legacy host instruction lines in recognized system overlays when loading a resumed child or seeding a new child from inherited messages. User/assistant quotations and unrelated repository policies remain intact. Messages retain sequence alignment; historical DB records are not rewritten.
- No response tool was fabricated, no permission filter was relaxed, and no historical error badge was hidden.

## Fresh verification

| Check | Result | Evidence |
| --- | --- | --- |
| Before repair: new fork + persisted legacy resume | 2 failed as expected | `.scratch/session-804115f7251f/red.log` |
| Focused regressions after repair | 8 files,91 tests passed, exit0 | `accepted-tests.log`; includes real SQLite fork/resume, project contract, real MessageProcessor/SDK handoff, cancellation, recovery and loop caps |
| Build | exit0 | `build.log` |
| Compiled handoff probe | 6/6 checks passed, exit0 | `compiled-handoff.json`, UTC07:29:35–07:29:36 |
| Actual prepared helper request in compiled probe | 53 exposed tools, read_file present, respond_general absent; plain-text handoff instruction present; legacy mandate absent | `compiled-handoff.json` numeric/boolean request observations |
| Compiled main acceptance | main received helper evidence, streamed its own answer and persisted final; no respond_general call | Same isolated compiled probe |
| Offline native/MCP/TUI controls | 16/16 passed | `compiled-controls.json`; includes TUI command/status smoke and fresh local tools-MCP |
| Native selfverify | 2/2 passed | run `935e2c6e-8b5a-4643-8d2e-247b38de9d43` |

The SDK regression in `src/orchestrator/__tests__/main-handoff-stream.test.ts:209` also observes the actual prepared helper prompt and exposed tool names, rather than only testing a string-building helper.

## Limits and use

These controls use deterministic mock providers, isolated settings/SQLite, and a freshly built local CLI/MCP. They prove the repaired host contract and controlled handoff paths, not StepFun's behavior on a new paid request or every tool combination. The full unit suite was not run; nothing was pushed or remotely deployed for this change.

An already loaded CLI process does not hot-reload the rebuild. Restart it using `bun D:/sources/Core/muonroi-cli/dist/src/index.js` and resume normally to load the corrected instructions. Historical failures remain available for inspection. The repair also projects the exact old overlay instructions when a child resumes under the new build.

Evidence manifest: `docs/investigations/evidence/session-804-response-tool-contract-2026-10-17.json`.
