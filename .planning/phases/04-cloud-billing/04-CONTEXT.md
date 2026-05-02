# Phase 4: Cloud & Billing - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 delivers the cloud tier of muonroi-cli: multi-tenant cloud EE for Pro/Team users, LemonSqueezy billing with 3 tiers (Free / Pro $9 / Team $19/user), a read-only web dashboard for principles + usage, and a resumable local-to-cloud migration path. All backed by Clerk auth with JWT, collection-per-tenant Qdrant isolation, and a remote pricing endpoint on the control-plane.

</domain>

<decisions>
## Implementation Decisions

### Auth & Multi-Tenancy
- Auth provider: **Clerk** — JWT + org support, free tier covers beta, fastest solo-dev integration
- Multi-tenancy isolation: **Collection-per-tenant on Qdrant** — each tenant gets `principles_{tenant_id}` collection, cross-query prevention by design
- Cloud EE deployment: **Existing VPS (`cp.muonroi.com`)** — reuse control-plane infra, solo maintainer can't ops two servers
- API transport: **REST over HTTPS** — same as local EE HTTP interface, add JWT auth header from Clerk

### Billing & Tiers
- Billing provider: **LemonSqueezy** — Merchant of Record model, handles global tax/VAT, seller in Vietnam OK, checkout + customer portal + webhook built-in
- Webhook idempotency: **`processed_events` table with unique constraint on `event_id`** — return 200 in <5s per ROADMAP spec
- Tier changes: **Immediate proration for upgrades, end-of-period for downgrades** — principles preserved across tier changes
- Remote pricing: **JSON endpoint on control-plane** (`cp.muonroi.com/api/pricing`), CLI fetches on startup (cached 24h), replaces Phase 1 hardcoded config

### Dashboard & Migration
- Dashboard stack: **React/Vite SPA** — deploy on same VPS behind Nginx, read-only API calls to cloud EE
- Migration: **Mirror mode** — CLI syncs principles one-by-one with count + checksum verification, resumable per-principle, 30-day local archive per ROADMAP spec
- Dashboard auth: **Same Clerk auth** — SSO with CLI account, dashboard shows principles + usage analytics
- Dashboard scope: **Read-only MVP** — principles list, usage chart (tokens/cost per day), current tier, billing portal link (LemonSqueezy customer portal)

### Claude's Discretion
- Database choice for `processed_events` table (SQLite on VPS vs PostgreSQL)
- Exact LemonSqueezy webhook event types to handle
- Dashboard deployment specifics (Nginx config, build pipeline)
- Migration CLI UX (progress bars, error recovery display)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/ee/` — EE HTTP client, health checks, PreToolUse hook integration (local EE)
- `src/providers/` — multi-provider adapter with usage tracking
- `src/utils/settings.ts` — config management, PermissionMode
- `src/ops/doctor.ts` — health check pattern reusable for cloud connectivity checks
- muonroi-building-block (.NET) — multi-tenancy patterns available as reference (different stack)

### Established Patterns
- HTTP client pattern: `src/ee/client.ts` — fetch with timeout, error handling
- Config with atomic writes: `src/utils/settings.ts`
- Usage tracking: `src/providers/usage.ts` — token + cost tracking per provider

### Integration Points
- CLI entry: `src/index.ts` — new commands (`login`, `sync`, `billing`)
- Settings: `src/utils/settings.ts` — cloud config (tenant_id, auth token, tier)
- Cap chain: `src/providers/cap-state.ts` — tier-aware cap limits
- EE client: `src/ee/client.ts` — needs cloud endpoint variant

</code_context>

<specifics>
## Specific Ideas

- LemonSqueezy instead of Stripe (user is in Vietnam, MoR model avoids Stripe account setup complexity)
- Existing VPS at `cp.muonroi.com` for cloud EE deployment
- Collection-per-tenant Qdrant isolation (not payload filtering)
- Pen-test cross-user query must return 404 per ROADMAP success criteria
- Migration must be resumable per-principle with 30-day local archive
- Dashboard is read-only MVP only — no CRUD on principles from web

</specifics>

<deferred>
## Deferred Ideas

- Full CRUD on principles from web dashboard
- Team workspace management UI
- Usage alerts/notifications via email
- Multi-region Qdrant deployment
- muonroi-ui-engine integration for dashboard (evaluated, too specialized for rule editing)

</deferred>
