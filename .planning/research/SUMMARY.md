# Research Summary: v1.1 EE-Native CLI

## Stack Additions
- No new runtime needed. `module.createRequire` loads EE CJS from Bun ESM.
- Git submodule for experience-engine. `EE_SOURCE_PATH` env for dev.
- Remove CLI direct Qdrant client — route all ops through bridge.

## Feature Table Stakes
- `/api/search` in EE (cross-repo blocker for PIL Layer 3)
- EE brain replaces hot-path regex (Layer 1) — quality grows with model
- `respond_general` response tool — eliminates fallthrough
- Output style detection via EE brain — replaces multilingual regex
- Route feedback loop — EE starts learning from usage
- Full hook pipeline end-to-end verified

## Architecture
- **Dual-path:** bridge.ts (in-process: classify, search, routeModel, routeFeedback) + client.ts HTTP (sidecar: intercept, posttool)
- experience-core.js loaded via createRequire from git submodule
- Only 3 existing files need significant changes (layer1, layer3, warm.ts)
- Net-new: ~150 lines bridge + tests

## Watch Out For
1. **CJS named imports undefined at runtime** — default import + destructure only
2. **Config divergence** — set EXPERIENCE_* env vars before import, never write ~/.experience/
3. **Ollama cold-start blocks hot path** — AbortSignal.timeout on all brain calls
4. **PostToolUse feedback ordering race** — await posttool() before fireFeedback()
5. **routeFeedback ontology mismatch** — PIL taskTypes != EE tiers, need mapping function

## Suggested Phases (3)
1. Foundation — Bridge + Config + Safety (no external deps)
2. Migration — PIL + Router callsite changes (blocked on EE /api/search)
3. Validation — Full pipeline end-to-end + performance baseline
