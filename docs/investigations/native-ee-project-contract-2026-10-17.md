# Native EE project contract: optional argument versus task repository

## Finding

The native tool is being used. Stored session `81e606ae4fda` calls at seq60 and seq75 invoke `ee_query` without a `project` argument. Omitting it satisfies the tool schema, which requires only `query` (`src/tools/registry.ts:1218-1234`). Calling that omission an invalid model call is incorrect.

General native recall passes `bash.getCwd()`, `strictProject: true`, and an explicit project only when supplied by the model (`src/tools/registry.ts:1295-1302`). Reading files from another repository does not switch this shell cwd or bind a target project. The operating prompt instructs active recall (`src/orchestrator/prompts.ts:346`), but that instruction does not provide a separate task-target project binding.

The scope refusal is intentional: the EE server cannot resolve a concrete project from this consumer cwd. The earlier diagnostic repair distinguishes this rejection from a network outage; it does not automatically select the task's repository.

## Fresh controlled native measurement

UTC: `2026-10-17T06:43:27.657Z` through `2026-10-17T06:43:27.990Z`. Newly started locally compiled native tools, existing configured EE URL/auth resolver, identical query `session 81e606ae4fda final answer recovery`, `strict_project=true`. No settings/server changes, model invocation, external EE MCP hop, or raw lesson logging.

| Shell cwd | Explicit project argument | HTTP | Scope/result | Measured request time |
| --- | --- | --- | --- | --- |
| `D:/sources/Core/extension/ai-dock` | omitted | 400 | Cannot resolve concrete project; native `ee_project_required` | 67ms |
| Same ai-dock cwd | `muonroi-cli` | 200 | Strict/project-only, project muonroi-cli, 7 entries | 151ms |
| `D:/sources/Core/muonroi-cli/` | omitted | 200 | Strict/project-only, project muonroi-cli, 7 entries | 102ms |

The instantiated native schema also reports `required: ["query"]` and describes `project` as optional. Measurements are a single sequential snapshot, not a performance benchmark. They demonstrate that explicit project is unnecessary when cwd resolves correctly, and necessary for the tested cross-repository request from an unresolved consumer cwd.

Evidence/reproducer: `.scratch/session-81-ee-recall/native-scope-contract.mjs` and adjacent `.json`; command `bun .scratch/session-81-ee-recall/native-scope-contract.mjs`, exit0. Historical argument evidence remains in `.scratch/session-81-ee-recall/db-ee.json`; historical transport status was not captured, so the new measurements establish current reproduction rather than retroactively supplying an old HTTP trace.

## Responsibility and remaining improvement

- Native refers to in-process tool execution and configured authentication. The brain still receives a scoped HTTP request; native execution alone cannot identify a different task repository.
- A model can omit an optional field. Current behavior is internally consistent for same-repository tasks, but leaves cross-repository task binding to the model.
- The old rejection-as-unavailable response was a CLI diagnostic defect, already repaired in the local build. Loaded consumer-process provenance remains unverified.
- A further native improvement needs an authoritative task-project binding: use a verified session/task project when present; otherwise retain cwd resolution and request an explicit project upon unresolved scope. Expose the effective scope and its source to the agent. Free-form query text and arbitrary file reads must not silently change that binding.
- Making project mandatory for every recall would also affect valid cwd-based calls and local artifact retrieval; this experiment does not justify that broad change. Never hardcode muonroi-cli or relax strict filtering to obtain a successful response.

This investigation changes no production code. It establishes the boundary for a subsequent task-project binding change rather than claiming that automatic binding is implemented.
