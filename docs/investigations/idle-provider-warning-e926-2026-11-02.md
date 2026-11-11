# Idle resume warning names the wrong provider

## Evidence

User session: `e926f4be889f`. The screenshot shows Step 5 Preview / StepFun in the model/status surfaces, while a yellow toast names DeepSeek after 655 idle minutes.

Read-only queries against the user's existing `muonroi.db` showed:

- `sessions.model = step-5-preview`.
- `usage_events` 6477: source=message, model=step-5-preview, 2026-11-01T14:16:57.035Z.
- `usage_events` 6478: source=message, model=step-5-preview, 2026-11-02T01:12:25.039Z.
- Routing records 67130 and 67138 both use step-5-preview; the later response record 67143 also uses step-5-preview.
- The cost-log record at the exact later usage timestamp names provider=stepfun, model=step-5-preview, callsite=orchestrator.message. It reports cachedInputTokens=0; that does not establish that inactivity caused cache eviction. Cost-log rows do not carry a sessionId, so the association uses the exact timestamp/model plus the session-bound DB rows.

Runtime query output: `.scratch/idle-provider-e926/runtime-evidence.json`. The source toast in `src/ui/use-app-logic.tsx` previously named DeepSeek unconditionally whenever elapsed session time was at least ten minutes. This was a hardcoded UI warning, not evidence of a provider switch in this session.

## Change

Replace the warning/cache-eviction assertion with an informational message containing only the measured idle duration: `Đang tiếp tục phiên sau ${diffMins} phút không hoạt động.` The existing elapsed-time condition is preserved. No model/provider routing, credentials, user settings or existing session records were changed.

## Verification and limits

- Fresh build including tsc: exit 0; the compiled UI contains the neutral info toast.
- 38 tests / 3 files passed: cache-hit, status bar, internal activity display.
- Native tools-MCP selfverify against the newly built Bun TUI: smoke-boot 1/1 passed, emit=false, private OS-temp HOME/cwd.
- Logs and native result: `.scratch/idle-provider-e926/`.
- The user's original DB was opened read-only. No paid provider request was made by this investigation. Boot and neighboring unit checks do not constitute a fresh live 655-minute scenario; the actual reported scenario is supported by the screenshot and original session telemetry.
- Already-running clients must load the rebuilt local CLI to display the changed text. This does not establish anything about different cached npm/global packages or unrelated sessions.
