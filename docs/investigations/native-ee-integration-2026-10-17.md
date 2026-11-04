# Native EE integration: task scope, recall, write and feedback

## Outcome

The CLI's inner model can use EE directly in-process. Normal recall requires only `query`. For another repository it can supply that repository's absolute `cwd` once, without knowing an EE slug. A strictly verified successful response binds its project to the current task; subsequent query-only recalls reuse it. No external EE MCP subprocess, manual HTTP/auth setup or natural-language scope parsing is involved.

This closes the reproduced native contract gap from session `81e606ae4fda`: omitting optional project was valid, but shell cwd referred to ai-dock while the task concerned muonroi-cli. The old HTTP400-as-unavailable diagnostic was repaired separately; this change adds the missing native scope lifecycle.

## Changes

- `NativeEEContext` is owned by the existing per-task `TaskContext`. An explicit project/cwd is accepted as input; binding occurs only after matching strict scope proof. Explicit cwd never inherits another project's previous binding. Slow older requests cannot overwrite a newer binding/reset.
- `ee_query({action:"scope"})` inspects effective scope and last measured recall without network access. `action:"projects"` reads the authenticated project directory in bounded pages and preserves partial/truncated flags. `action:"reset"` returns to shell scope. Discovery never selects a project automatically.
- Successful recall emits a bounded native receipt containing owner, anchor cwd, target project/cwd and displayed feedback handles. Compaction preserves this pointer while eliding long lessons. Explicit continuation can restore it for the same owner and anchor. A different task, owner/child or shell cwd does not inherit the binding. Reset receipts prevent restoring an older selection.
- `ee_write` uses the verified task project or an explicit project. It no longer derives a project slug from the consumer directory basename. An unresolved default project lesson is refused before POST. Explicitly selecting project-independent principles remains supported.
- `ee_feedback` sends the original displayed handle's recall cwd/project, including after selection of another project and explicit continuation. The offline feedback body retains these fields. Only entries whose handles actually reached the model become native feedback debt.
- `ee_health` still reports reachability and `recallReady=not_checked`; it separately reports task scope and timestamped `lastRecall` state. Health does not perform an implicit recall or promise future availability.
- Home-relative `~/repo` proof now matches the client's actual absolute home path; another directory still fails. Client home abbreviation now requires a directory boundary. Feedback and lesson-write HTTP requests are bounded by a 15s timeout.
- Progressive and reference guidance describe these native operations concisely. Strict filtering/proof and local-first artifact retrieval remain in place. EE failure remains an aid failure, not permission to bypass workflow or block main.

## Fresh verification

| Check | Result | Evidence |
| --- | --- | --- |
| Before repair, native integration contract | 12/12 RED failures | `.scratch/session-81-ee-recall/native-context-red.log` |
| Home-relative proof reproducer | 1 failed/4 passed before normalization repair | `home-scope-red.log` |
| Combined EE directory plus native/context/compaction/child tests | **377 passed, 0 failed, 2 skipped, 45 files**, 27.46s, exit0 | `native-context-tests-final.log` |
| Build, including TypeScript | exit0 | `native-context-build-accepted.log` |
| Compiled native scope plus live EE controls | **10/10**, exit0 | `.scratch/native-ee-integration/live-native.json` |
| Compiled offline controls | **16/16**, exit0 | `compiled-controls.json` |
| Actual TUI routing/status smoke with mock provider | **1/1** | Same compiled-controls artifact |
| Native selfverify from a newly started local tools-MCP | **2/2**, no skipped scenarios | run `f43fca28-d484-4f08-a7d2-6269b1bd3889` |

The two unit skips are existing chmod/permission checks on Windows, not new native EE integration cases. The first implementation build found a nullable access and the first test import found a duplicate import; both were corrected before acceptance. Historical passing logs were not substituted for these runs.

Live measurements, UTC `2026-10-17T06:56:55.711Z` to `06:56:56.401Z`, using the configured EE URL/auth and freshly compiled local native modules:

| Operation | HTTP | Request time | Result |
| --- | --- | --- | --- |
| ai-dock cwd without a resolvable project | 400 | 77ms | `ee_project_required`; unavailable=false; no automatic broad retry |
| ai-dock task supplies only muonroi-cli target cwd | 200 | 147ms | Strict/project-only proof, muonroi-cli, 7 entries |
| Same task supplies only query on next recall | 200 | 102ms | Remembered muonroi-cli project/cwd, 7 entries |
| Native project directory | 200 | 185ms | 36 slugs; partial=false, truncated=false |
| Native health | 200 | 59ms | Reachability separate from last successful recall |

The same compiled probe checked compaction/continuation restoration, child/new-task isolation, reset and local artifact retrieval without EE network access. These are single snapshot measurements, not an A/B performance claim. Live probes did not import lessons or submit verdicts to the production brain. Write/feedback wire bodies were verified against fixture transport in the unit suite.

## Use

Start the built interactive CLI with **Bun**, including when launching it from another workspace:

```powershell
bun D:/sources/Core/muonroi-cli/dist/src/index.js
```

Correction to the earlier chat launch instruction: bare Node does not load OpenTUI's `.scm` assets. The entry has a Bun shebang, and the TUI harness spawns `bun run`; Node-based backend/module controls do not establish Node compatibility for the interactive TUI. A fresh import comparison from ai-dock reproduces the Node error and successful Bun import; evidence is `.scratch/native-ee-integration/runtime-compare.json`.

```text
ee_query({"query":"relevant prior decisions"})
ee_query({"query":"relevant prior decisions","cwd":"D:/sources/Core/muonroi-cli"})
ee_query({"query":"the next question in the same task"})
ee_query({"action":"scope"})
ee_query({"action":"projects"})
```

The first call uses the current task/shell scope. The second illustrates explicitly selecting another repository once. The third reuses its verified project. `ee_write` and `ee_feedback` then share this context as described above.

## Boundaries

- Receipt binding is scoped to the current task and explicit continuation, not an ambient global or permanent setting. A new task needs its own scope. Reading a file or mentioning a project in query text does not change authority.
- The directory is discoverable data, not proof that a particular task targets a listed project. Unresolved/invalid scope stays explicit; strict filtering is never relaxed.
- Local native controls prove newly started modules from this build. They do not identify what an already running consumer process loaded; start a fresh local CLI process to use the new code and descriptions.
- Third-party external EE MCP versions, server ranking quality, future uptime and live paid-provider model behavior were not established by these controls. The inner CLI uses its native tools and does not require that external EE MCP.
- No project settings, server deployment, active user sessions or unrelated WIP were changed. No push/publication or full-repository test gate is claimed. Adjacent evidence JSON records the fresh artifact/source/compiled hashes.
