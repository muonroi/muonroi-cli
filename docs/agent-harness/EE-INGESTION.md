# Experience Engine Ingestion

How structured assets from `muonroi-building-block` (BB) and the three template repos land in the Experience Engine (EE), and how `/ideal` retrieves them at scaffold time.

> See `docs/superpowers/plans/2026-05-15-bb-aware-ideal.md` for the originating plan.

## Collection layout

| Collection | Vector dim | Source | Used by |
|---|---|---|---|
| `bb-behavioral` | 1024 (Cosine) | `BB/REPO_DEEP_MAP.md` rows + `BB/schema/*.json` + BB-marker matches migrated from `experience-behavioral` | Phase 5 `fetchBBContext` — behavioral rule retrieval |
| `bb-recipes` | 1024 (Cosine) | `BB/samples/*/README.md` + 3 template repo READMEs + `template.json` + `*.csproj` package refs | Phase 5 retrieval — closest-sample matcher for intent |
| `experience-principles` | 1024 (Cosine) | `BB/README.md` §Package Families + `BB/OSS-BOUNDARY.md` matrix | PreToolUse OSS-BOUNDARY hints + scaffold OSS/Commercial gate |

`bb-behavioral` and `bb-recipes` are auto-created by `server.js:ensureCollections()` at EE startup. Both names are gated by `KNOWN_COLLECTIONS` — adding any new bb-prefixed collection requires updating that Set.

## Ingestion script

```bash
cd D:/sources/Core/muonroi-cli
bun run ee:ingest-bb -- \
  --bb-root D:/sources/Core/muonroi-building-block \
  --templates-root D:/sources/Core \
  --ee-url http://72.61.127.154:8082
```

Auth: reads `EE_AUTH_TOKEN` from env first; falls back to `~/.experience/config.json:serverAuthToken`.

Idempotency: each point's id is `sha256(source + text).slice(0, 32)`. `.ee-ingest-state.json` tracks `${collection}:${id} → sha256(JSON.stringify(point))` so re-runs only POST when content changed.

Rate limiting: EE limits POSTs. Script throttles at `EE_POST_THROTTLE_MS=250` (override via env) and retries 429 with exponential backoff (1s/2s/4s/8s, max 4 attempts).

## Endpoint contract

`POST /api/ingest-point` (added in Phase 2 for backfill — see `experience-engine/server.js:handleIngestPoint`):

```json
{
  "id": "deterministic-32-char-sha",
  "text": "the embeddable content",
  "collection": "bb-behavioral|bb-recipes|experience-principles",
  "payload": { "project_slug": "muonroi-building-block", "source": "repo-deep-map", "...": "..." }
}
```

Behavior: embeds `text` via experience-core `getEmbeddingRaw`, upserts to Qdrant `<base>/collections/<col>/points?wait=true`. `KNOWN_COLLECTIONS` gates writable collections.

`/api/extract` (the older endpoint) goes through the LLM extraction pipeline for free-form transcripts. **Do NOT** use it for structured points.

## Migration scripts (EE repo)

| Script | Purpose |
|---|---|
| `scripts/backfill-project-slug.mjs` | Phase 1.5 — backfill `payload.project_slug` on existing points using `canonicalizeProjectSlug()` |
| `scripts/split-bb-behavioral.mjs` | Phase 2.3+2.4 — copy BB-marker-matching points from `experience-behavioral` into `bb-behavioral`; archive near-duplicates (cosine ≥ 0.97) |

Both support `--dry-run`. `split-bb-behavioral.mjs` supports `--rollback` to drop the new collections and clear the state file.

## Coverage baseline

Latest probe in `docs/phase-g-snapshots/2026-05-16-bb-ee-coverage.txt`. Top-hit scores across canonical queries:

| Intent | bb-recipes | bb-behavioral | experience-principles |
|---|---|---|---|
| decision table FEEL | 0.82 | 0.76 | 0.70 |
| fraud detection | 0.63 | 0.63 | 0.56 |
| loan approval | 0.68 | 0.56 | 0.58 |
| multi-tenant SaaS | 0.84 | 0.73 | 0.63 |
| OSS boundary | 0.47 | 0.54 | 0.84 |
| observability tracing | 0.54 | 0.71 | 0.64 |

Re-run after each ingestion cycle as a regression smoke check.

## OSS-BOUNDARY architecture (Phase 7)

Originally specified as `~/.experience/rules/bb-oss-boundary.json` static rule files. **Implementation diverged** — EE's PreToolUse interceptor (`~/.experience/interceptor.js`) uses pure semantic retrieval against `experience-principles`, not a static rule registry. The 46 OSS-BOUNDARY entries ingested in Phase 3.3 are surfaced automatically by the interceptor's `buildQuery({ file_path, command })` semantic search at PreToolUse time.

Verified at 2026-05-16: query "OSS package must not reference commercial" returns rules at score 0.84 from `experience-principles`. No code changes required.

To suppress a false-positive hint: `node ~/.experience/exp-feedback.js noise <pointId> experience-principles wrong_repo`.

## CI nightly

`.github/workflows/ee-ingest-bb.yml` runs the ingest script nightly + on manual dispatch. Secret `EE_AUTH_TOKEN` required in repo secrets.
