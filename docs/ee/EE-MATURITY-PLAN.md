# Experience Engine Maturity Plan

> Created: 2026-06-26 | Status: In Progress
> Target VPS: phila@72.61.127.154

## Assessment

| Collection | Current | Target | Gap |
|---|---|---|---|
| experience-behavioral | 77 | 300+ | +223 |
| experience-principles | 1 | 15+ | +14 |
| experience-selfqa | 362 | OK | — |
| experience-routes | 178 | OK | — |
| bb-behavioral | 596 | OK | — |
| bb-docs | 7793 | OK | — |
| bb-packages | 0 | 50+ | +50 |
| bb-recipes | 9 | 20+ | +11 |

## Implementation Phases

### Phase 1: Populate bb-packages & bb-recipes
- Source: `mcp__muonroi-docs__bb_recipe_list`, `bb_template_describe`, `bb_package_describe`
- Method: Call storeExperience() with domain="bb-dotnet" per entry
- Script: `scripts/ee-ingest-bb-data.js` (runs on VPS)

### Phase 2: Seed experience-principles
- Source: Static universal engineering principles
- Method: Direct Qdrant upsert into experience-principles
- Script: `scripts/ee-seed-principles.js`

### Phase 3: Bootstrap experience-behavioral
- Source: Pattern extraction from existing sessions + known muonroi-cli patterns
- Method: batch storeExperience() calls
- Script: `scripts/ee-seed-behavioral.js`

### Phase 4: Run evolve cycle
- POST /api/evolve with trigger="maturity-boostrap"
- Promotes behavioral→principles, abstracts patterns, cleans noise

### Phase 5: Daily health-check + evolve automation
- systemd timer: `/etc/systemd/system/experience-daily.{service,timer}`
- Calls: health-check.sh → evolve via exp-server-maintain.js

## Verification
- After ingestion: `exp-health` or direct Qdrant point count
- After evolve: check activity.jsonl for evolve events
- After automation: `systemctl status experience-daily.timer`
