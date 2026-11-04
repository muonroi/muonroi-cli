# Muonroi Flow and runtime evaluation follow-up — 2026-10-18

The user authorized the full AI Dock runtime evaluation follow-up and Auto/Yolo controls, then requested removal of GSD definitions **only inside muonroi-cli**. Shared skills, existing workflow state, historical reports and unrelated working-tree changes are preserved. No commit, push, deployment, credential changes or real user-mode changes were performed.

Machine evidence: [evaluation-muonroi-flow-2026-10-18.json](evidence/evaluation-muonroi-flow-2026-10-18.json). Original report: `D:/sources/Core/extension/ai-dock/.muonroi-flow/evaluation-report-2026-10-18.md` (unchanged). Workflow record: `.quick-codex-flow/sessions/01a1393f-631b-7752-94f0-59a96a173e2c/runs/evaluation-20261018.md`.

## Delivered behavior

| Area | Change | Executed evidence |
|---|---|---|
| Native workflow | Replaced callable `gsd_*` with seven `flow_*` definitions; implementation now under `src/workflow`, with `MUONROI_FLOW_*` flags and updated live prompts/UI guidance. No callable legacy aliases. Plan/review/verify guards remain active. | Compiled inventory and workflow/gate regression tests. |
| CLI-owned skill | Packaged `muonroi-flow/SKILL.md` with the runtime. Excluded shared legacy workflow skills from this CLI's discovery without deleting their files. Exact `context_load(topic="skills",query="muonroi-flow")` returns its instructions, so orchestrator main needs no repository read tool. | Compiled package/source asset equality, no legacy catalog entries, direct skill loading, preserved-file test. |
| Existing sessions | Historical tool names remain recognized for session-owned checklist restoration; historical DB rows/exports are not rewritten. Existing `.planning` and `.muonroi-flow/planning` state roots remain supported. | Session-scoped history tests, existing path/state/gate tests. |
| Read-only status | Removed fresh-workspace bootstrap from `flow_status`: inspecting status no longer creates planning state. | Fresh compiled isolated-cwd reproducer and named regression `reads status in a fresh workspace without creating planning state`. |
| Permission selection | Added `/permissions safe\|auto\|yolo`, status-bar mode, `--permission auto` alias, persisted explicit user preference and A/Y shortcuts on worker approval. Selection reaches owned running workers and their next tool call. No mode-changing model tool. | Actual built TUI Auto and Yolo scenarios: one queued approval, two actual file writes, correct saved mode, unchanged worker model/role. Slash/parser tests. |
| Consent boundaries | Auto uses existing file/non-dangerous-shell policy; Yolo removes standard permission prompts. Custom business approval, workflow/role restrictions and catastrophic-command checks remain separate. Foreign, denied, expired and nonmatching requests are not revived. | Exact-input/owner/controller and custom-policy regression tests. |
| Atomic writes / UI | Raised full redacted approval preview limit from 4,000 to 65,536 characters. No truncation or automatic split-write workaround. Local scrolling retains pinned metadata/actions and composer draft. | Atomic 9.5KB single-write test, 65,536-character boundary tests, native 10,209-character previews on 80×24 frames. Both long-preview scenarios reached prefix/middle/suffix, returned Home/End and preserved chat position. |
| Approval deadline | First actual permission refusal terminates that worker attempt instead of letting the model renew approval requests. No TOTAL-budget reset, automatic consent or deadline renewal. | Actual SDK + real host approval expiry at a bounded 200ms fixture: one model call, one expired request, no file effect. Native Deny/Esc: one model call, one denied request, readable main callback. |
| Review workspace | Omitted `reviewOf.cwd` inherits the exact owned target's cwd; explicit mismatch still refuses and names both paths and the correction. | Nested `probe2` fixture with successful inherited dispatch and explicit mismatch refusal. |
| Integration diagnostics | Added bounded persistent observations and `integration_status`; connection, individual executed tools, shell exit127 failures and PIL enrichment are distinct checks. Optional failures do not block unrelated work. Missing explicit MCP grants fail before the worker model call. | Persistence/separation/JSON-shell tests, native tool registry and worker grant/identity boundary tests. |
| Agent-bus context | Forward only actual `AG_NAME`, `AG_PANE`, `AG_BUS_DB`, `TMUX_PANE` to stdio MCP; explicit server environment wins. Pool identity changes reconnect rather than reusing another identity. No fabricated identity or arbitrary ambient credential forwarding. | Allowlist and cross-turn pool regression tests. This is not a claim of a successful authenticated live agent-bus invocation. |
| PIL | Optional enrichment reports pending/unavailable/degraded reason and journals actual failures. It remains advisory and does not determine main routing, permissions or workflow authority. | Ownership/cancellation/background streaming tests, error logging and foreground-continuity tests. |

## Verification and provenance

- `bun run build`: exit 0; TypeScript compilation and workflow asset packaging succeeded. Obsolete generated native workflow modules were removed from `dist/src/gsd`.
- `bun run typecheck`: exit 0 after the final test additions. `bun run lint:semantic`: exit 0.
- Affected regression run: **839 tests / 68 files passed**. Manifest, timestamps, exit code and log are in `.scratch/evaluation-20261018/affected-test-{files,run}.json` and `affected-tests.log`.
- Follow-up status suite: **14 tests / 1 file passed**. Follow-up actual SDK messaging/deadline suite: **6 tests / 1 file passed**. These overlap the larger run; do not add counts.
- Compiled native workflow probe: **11/11 checks passed** against `dist`, including exact packaged skill content and no legacy callable aliases.
- Built Bun TUI: **7/7 scenarios passed** — allow, deny, escape, auto, yolo, long-preview, draft-preview. Raw native frames, job records, host-bound artifacts, SQLite dispatch calls, exact key decisions and SDK journals: `.scratch/evaluation-20261018/tui-safe-lOlRzJ/report.json` and scenario subdirectories.
- Native `selfverify_start/status/result`: **1/1 smoke-boot passed**, not a claim of whole-product coverage.
- Native main/child processes checked the same build files against a **2,478-entry source/generated-runtime freeze** before and after execution. Real settings hashes stayed unchanged. This does not identify or upgrade an already running user process.

Language-model responses in native controls were private offline SDK fixtures; the Bun App, detached workers, actual tools, keyboard events, artifacts and SQLite were real. No paid-provider sweep was performed. The full repository test suite was not rerun; no push was performed.

Earlier private attempts are retained: one regression run accidentally discovered `.ts` source backups as tests (backups now use `.bak`), and prior fixture expectations assumed a denied worker completed normally rather than failing immediately. Those attempts are not passing evidence. The fresh compiled status test exposed and led to the actual read-only bootstrap fix; it was rerun on the final build.

## Remaining external prerequisites

StealthGPT still requires valid third-party authentication, and agent-bus still requires a genuinely registered identity or owned terminal context. CLI does not invent credentials, choose an arbitrary identity, or convert connection health into proof that every tool works. Empty strict EE recall is not a server-outage diagnosis. Integration observations are bounded facts, not a global readiness score.

Historical investigation documents can retain old names because they describe earlier executed revisions; they are not loaded as current workflow definitions. Shared `~/.agents/skills/gsd-*`, `~/.codex/skills/gsd-*` and external-client hooks remain untouched, matching the user's scope.

## Restart and use

Restart once with Bun to load this build:

```powershell
bun D:/sources/Core/muonroi-cli/dist/src/index.js --permission auto
```

Use `/permissions safe`, `/permissions auto` or `/permissions yolo` in the TUI; an explicit selection is saved for the next launch. While a worker approval card is open, A selects Auto and Y selects Yolo. CLI `--permission` overrides the saved default; without either, Safe remains the default. The workflow skill is `muonroi-flow`, backed by native `flow_*` tools according to the current role's actual inventory.
