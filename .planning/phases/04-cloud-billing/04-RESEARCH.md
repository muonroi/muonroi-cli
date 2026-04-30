# Phase 4: Cloud & Billing - Research

**Researched:** 2026-04-30
**Domain:** Multi-tenant cloud EE (Qdrant), billing (LemonSqueezy), auth (Clerk), dashboard (React/Vite SPA), remote pricing, local-to-cloud migration
**Confidence:** MEDIUM-HIGH (core stack verified; ASP.NET control-plane extension patterns inferred from existing repo)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Auth provider: **Clerk** — JWT + org support, free tier covers beta, fastest solo-dev integration
- Multi-tenancy isolation: **Collection-per-tenant on Qdrant** — each tenant gets `principles_{tenant_id}` collection, cross-query prevention by design
- Cloud EE deployment: **Existing VPS (`cp.truyentm.xyz`)** — reuse control-plane infra, solo maintainer can't ops two servers
- API transport: **REST over HTTPS** — same as local EE HTTP interface, add JWT auth header from Clerk
- Billing provider: **LemonSqueezy** — Merchant of Record model, handles global tax/VAT, seller in Vietnam OK, checkout + customer portal + webhook built-in
- Webhook idempotency: **`processed_events` table with unique constraint on `event_id`** — return 200 in <5s per ROADMAP spec
- Tier changes: **Immediate proration for upgrades, end-of-period for downgrades** — principles preserved across tier changes
- Remote pricing: **JSON endpoint on control-plane** (`cp.truyentm.xyz/api/pricing`), CLI fetches on startup (cached 24h), replaces Phase 1 hardcoded config
- Dashboard stack: **React/Vite SPA** — deploy on same VPS behind Nginx, read-only API calls to cloud EE
- Migration: **Mirror mode** — CLI syncs principles one-by-one with count + checksum verification, resumable per-principle, 30-day local archive per ROADMAP spec
- Dashboard auth: **Same Clerk auth** — SSO with CLI account, dashboard shows principles + usage analytics
- Dashboard scope: **Read-only MVP** — principles list, usage chart (tokens/cost per day), current tier, billing portal link (LemonSqueezy customer portal)

### Claude's Discretion
- Database choice for `processed_events` table (SQLite on VPS vs PostgreSQL)
- Exact LemonSqueezy webhook event types to handle
- Dashboard deployment specifics (Nginx config, build pipeline)
- Migration CLI UX (progress bars, error recovery display)

### Deferred Ideas (OUT OF SCOPE)
- Full CRUD on principles from web dashboard
- Team workspace management UI
- Usage alerts/notifications via email
- Multi-region Qdrant deployment
- muonroi-ui-engine integration for dashboard (evaluated, too specialized for rule editing)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CLOUD-01 | Multi-tenant Qdrant with tiered shards for paying users; `getCollection(tenantId)` wrapper enforced by lint rule | Collection naming wrapper `principles_{tenantId}`, lint rule via ESLint/Biome custom rule |
| CLOUD-02 | Free-tier shared Qdrant collection with strict payload filter on `tenantId`. Pen-test cross-user query returns 404 | Qdrant payload filtering pattern + mandatory `must` filter in all query calls |
| CLOUD-03 | Migration tool — local EE → cloud EE with mirror mode, count + checksum verification, resumable per-principle, 30-day local archive | CLI `muonroi-cli sync` command with SQLite state tracking per principle |
| CLOUD-04 | Cloud EE auth boundary — Clerk JWT verification on every cloud EE route | `@clerk/backend` v3.4.2 `verifyToken()` middleware on ASP.NET API |
| BILL-01 | LemonSqueezy subscription webhook, `processed_events` unique constraint, idempotent handler, 200 in <5s | HMAC-SHA256 `X-Signature` verify + SQLite/Postgres `processed_events` table |
| BILL-02 | Pricing tiers — Free / Pro $9 / Team $19/user — wired to feature gating in TUI and EE | LemonSqueezy variant IDs mapped to tier enum in config |
| BILL-03 | Tier-change config migration handles upgrade/downgrade without losing principles or session history | Migration golden test using existing SQLite migration pattern |
| WEB-01 | Web dashboard — read-only — for principle browsing, usage analytics, billing portal | React 18 + Vite 5 SPA on existing control-plane-dashboard infra + Clerk `useAuth()` |
| WEB-02 | Remote pricing fetch replaces hardcoded pricing table | `GET /api/pricing` on control-plane, 24h in-memory cache, loaded at CLI startup |
</phase_requirements>

---

## Summary

Phase 4 extends the existing muonroi-cli + control-plane stack with cloud-hosted EE for paying users, LemonSqueezy billing, a read-only web dashboard, and a local-to-cloud migration CLI. The control-plane is an **ASP.NET 8 Minimal API** (not Node.js), so cloud EE endpoints will be added there as new route groups. The JWT middleware for Clerk can use `@clerk/backend` SDK (Node.js/TypeScript) via a thin TypeScript sidecar, or alternatively use the existing ASP.NET JWT bearer pattern with Clerk's JWKS endpoint — the latter is architecturally simpler given the existing control-plane is .NET with JWT Bearer already wired.

The existing `control-plane-dashboard` (React 18 + Vite 5 + SWR + TailwindCSS 4) is the host for the new billing/principles dashboard. It already follows the read-only SPA pattern with `controlPlaneClient.ts` + SWR hooks, so the EE dashboard can be added as new pages following that established pattern.

The CLI side (TypeScript/Bun) needs: `muonroi-cli login` (Clerk OAuth device flow or browser-redirect), `muonroi-cli sync` (mirror migration), `muonroi-cli billing` (open LemonSqueezy portal URL), plus a cloud-aware EE client variant and startup remote pricing fetch.

**Primary recommendation:** Implement cloud EE API as new ASP.NET route groups on the existing control-plane, use Clerk JWKS URI with ASP.NET JWT Bearer (already configured), add LemonSqueezy webhook handler as a new endpoint group, extend the existing dashboard with 3 new read-only pages, and extend CLI with 3 new commands.

---

## Standard Stack

### Core (CLI side — TypeScript/Bun)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@clerk/backend` | 3.4.2 | JWT verification utilities for Node/Bun backends | Official Clerk SDK; `verifyToken()` is networkless if CLERK_JWT_KEY provided |
| `@qdrant/js-client-rest` | 1.17.0 (already in deps) | Qdrant REST client for cloud collection operations | Already locked in project deps |
| `@lemonsqueezy/lemonsqueezy.js` | 4.0.0 | Official LS SDK: create checkout, customer portal, webhook types | Official; HMAC-SHA256 sig verification built-in |

### Core (Dashboard side — React/Vite SPA)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@clerk/react` | 6.4.6 | ClerkProvider + useAuth hook for SPA | Official React SDK; same SSO as CLI |
| `react` | 18.3.1 (existing) | SPA framework | Already in control-plane-dashboard |
| `vite` | 5.4.10 (existing) | Build tool | Already in control-plane-dashboard |
| `swr` | 2.3.6 (existing) | Data fetching + cache for dashboard API calls | Already in control-plane-dashboard |
| `recharts` | 3.8.1 | Usage analytics chart (tokens/cost per day) | Lightweight, React-native, no D3 expertise needed |
| `tailwindcss` | 4.x (existing) | Styling | Already in control-plane-dashboard |

### Core (Control-Plane .NET side)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| ASP.NET JWT Bearer (built-in) | .NET 8 | Clerk JWKS-based JWT validation | Already configured in Program.cs; Clerk exposes JWKS endpoint |
| Qdrant.Client | 1.x (NuGet) | .NET Qdrant client for cloud EE storage | Official .NET client matches existing .NET stack |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `lemonsqueezy-webhooks` (remorses) | community | TypeScript discriminated union webhook types | If `@lemonsqueezy/lemonsqueezy.js` webhook types are incomplete |
| `node:crypto` (built-in) | — | HMAC-SHA256 for webhook signature verification | Always — timing-safe comparison required |
| `recharts` | 3.8.1 | Usage chart in dashboard | WEB-01 analytics page only |

**Version verification (npm view, 2026-04-30):**
- `@lemonsqueezy/lemonsqueezy.js`: 4.0.0
- `@clerk/backend`: 3.4.2
- `@clerk/react`: 6.4.6
- `@qdrant/js-client-rest`: 1.17.0 (already installed)
- `react`: 19.2.5 (muonroi-cli), 18.3.1 (control-plane-dashboard)
- `vite`: 8.0.10 (latest), 5.4.10 (in control-plane-dashboard — do not upgrade)
- `recharts`: 3.8.1

**Installation (CLI):**
```bash
bun add @clerk/backend@3.4.2 @lemonsqueezy/lemonsqueezy.js@4.0.0
```

**Installation (Dashboard):**
```bash
cd apps/control-plane-dashboard && npm install @clerk/react@6.4.6 recharts@3.8.1
```

---

## Architecture Patterns

### Recommended Project Structure

**CLI additions (`src/`):**
```
src/
├── cloud/
│   ├── auth.ts           # Clerk login flow (device/browser), token storage
│   ├── client.ts         # Cloud EE client (extends EEClient interface, adds JWT header)
│   ├── migration.ts      # Mirror mode sync: local Qdrant → cloud Qdrant, resumable
│   └── pricing-fetch.ts  # Remote pricing fetch, 24h in-memory cache
├── billing/
│   └── portal.ts         # Open LemonSqueezy customer portal URL
└── commands/
    ├── login.ts           # muonroi-cli login command
    ├── sync.ts            # muonroi-cli sync command
    └── billing.ts         # muonroi-cli billing command
```

**Control-Plane API additions (new C# route groups):**
```
src/Muonroi.ControlPlane.Api/
├── Endpoints/
│   ├── CloudEEEndpoints.cs        # /api/v1/cloud-ee/ — principles CRUD, intercept, posttool
│   ├── BillingWebhookEndpoints.cs # /api/v1/billing/webhook — LemonSqueezy webhook receiver
│   ├── PricingEndpoints.cs        # /api/v1/pricing — public GET, no auth
│   └── TierEndpoints.cs           # /api/v1/tenant/tier — GET current tier for user
├── Services/
│   ├── ICloudEEService.cs         # Qdrant collection-per-tenant operations
│   ├── CloudEEService.cs
│   ├── IBillingService.cs         # Tier management, processed_events table
│   └── LemonSqueezyBillingService.cs
└── Options/
    └── LemonSqueezyOptions.cs     # Webhook secret, API key
```

**Dashboard additions (new pages in `apps/control-plane-dashboard/pages/`):**
```
pages/
├── EEPrinciplesPage.tsx   # Principles list with search/filter — read-only
├── EEUsagePage.tsx        # Usage analytics: tokens + cost per day chart (recharts)
└── EEBillingPage.tsx      # Current tier + LemonSqueezy portal iframe/link
```

### Pattern 1: Clerk JWT Verification — CLI Side (TypeScript/Bun)

The CLI needs to verify its own Clerk session token when making requests to cloud EE, and needs to store the token securely after login.

**Login flow:** Use Clerk's publishable key to initiate an OAuth flow (browser redirect or device auth). Store the resulting session token in `~/.muonroi-cli/cloud-auth.json` (0o600 permissions, same pattern as existing settings).

**Token verification on cloud EE client side:**
```typescript
// src/cloud/auth.ts
// Source: https://clerk.com/docs/reference/backend/verify-token
import { verifyToken } from "@clerk/backend";

export async function verifyClerkToken(token: string): Promise<{ userId: string; orgId?: string }> {
  const payload = await verifyToken(token, {
    jwtKey: process.env.CLERK_JWT_KEY,          // PEM public key from Clerk Dashboard
    authorizedParties: ["https://cp.truyentm.xyz"]
  });
  return { userId: payload.sub, orgId: payload.org_id as string | undefined };
}
```

**Cloud EE client (extends existing pattern in `src/ee/client.ts`):**
```typescript
// src/cloud/client.ts — mirrors EEClient interface
export function createCloudEEClient(opts: { baseUrl: string; authToken: string }): EEClient {
  // Same pattern as createEEClient() but baseUrl = "https://cp.truyentm.xyz/api/cloud-ee"
  // All requests carry Authorization: Bearer <clerk_token>
  // tenantId derived from Clerk userId claim
}
```

### Pattern 2: Clerk JWT Verification — ASP.NET Control-Plane Side

The existing control-plane already has JWT Bearer configured (`ControlPlaneAuthOptions.cs`). For Clerk, configure the JWKS URI:

```csharp
// Program.cs addition — Clerk JWKS endpoint
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(opts => {
        opts.Authority = "https://clerk.your-domain.com"; // Clerk Frontend API
        opts.MetadataAddress = "https://your-clerk-domain.clerk.accounts.dev/.well-known/openid-configuration";
        opts.TokenValidationParameters = new() {
            ValidateIssuer = true,
            ValidateAudience = false, // Clerk JWT has no audience by default
            NameClaimType = ClaimTypes.NameIdentifier
        };
    });
```

**Cross-tenant enforcement — the critical lint rule:**
```typescript
// src/cloud/collection.ts — MUST be the ONLY way to get a collection name
// Biome/ESLint custom rule: ban direct string template `principles_${x}` outside this file
export function getCollectionName(tenantId: string): string {
  if (!tenantId || tenantId === "local") {
    throw new Error("Cloud EE requires a valid cloud tenantId, not 'local'");
  }
  return `principles_${tenantId}`;
}
```

The lint rule banning raw `principles_` string templates ensures no code bypasses `getCollectionName()` — satisfying CLOUD-01's "enforced by lint rule" requirement.

### Pattern 3: Qdrant Collection-Per-Tenant (CLOUD-01 / CLOUD-02)

**IMPORTANT CONTEXT:** The CONTEXT.md locks in **collection-per-tenant** (`principles_{tenantId}`). Qdrant's own docs recommend single-collection + payload filtering for scale, but the user chose collection-per-tenant for stronger isolation guarantees. This is a valid choice given the beta scale (hundreds of users, not millions), and provides the 404-on-cross-tenant guarantee without filter logic.

```typescript
// src/cloud/client.ts pattern for Qdrant collection ops
import { QdrantClient } from "@qdrant/js-client-rest";

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });

async function ensureCollection(tenantId: string, vectorSize: number) {
  const name = getCollectionName(tenantId); // ALWAYS via wrapper
  const exists = await qdrant.getCollection(name).catch(() => null);
  if (!exists) {
    await qdrant.createCollection(name, {
      vectors: { size: vectorSize, distance: "Cosine" },
      optimizers_config: { indexing_threshold: 100 }
    });
  }
}

async function queryPrinciples(tenantId: string, vector: number[], limit = 5) {
  const name = getCollectionName(tenantId); // Cross-tenant impossible: different collection
  return qdrant.search(name, { vector, limit, with_payload: true });
}
```

**Free-tier shared collection (CLOUD-02):**
Free tier uses a single shared collection `principles_shared_free` with payload filter `tenant_id = <userId>`:
```typescript
// Free tier MUST always include this filter — enforced by wrapper
async function queryFreeTierPrinciples(tenantId: string, vector: number[]) {
  return qdrant.search("principles_shared_free", {
    vector,
    filter: { must: [{ key: "tenant_id", match: { value: tenantId } }] },
    limit: 5,
    with_payload: true
  });
}
```

### Pattern 4: LemonSqueezy Webhook Handler (BILL-01)

```typescript
// Control-plane endpoint: POST /api/v1/billing/webhook
// Source: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
import crypto from "node:crypto";

function verifyLSWebhook(rawBody: string, signature: string, secret: string): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(digest, "hex"),
    Buffer.from(signature, "hex")
  );
}

// Idempotency: processed_events table with unique constraint on event_id
// Migration adds: CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL)
// Handler logic:
// 1. Verify HMAC — return 400 if fail
// 2. INSERT OR IGNORE INTO processed_events — if 0 rows changed, return 200 (already processed)
// 3. Dispatch to event handler (subscription_created, subscription_updated, etc.)
// 4. Return 200 within 5s — async processing if needed
```

**Webhook event types to subscribe (Claude's discretion — recommending these):**
- `subscription_created` — provision new Pro/Team tier
- `subscription_updated` — handle tier change (variant_id change = plan change)
- `subscription_cancelled` — schedule downgrade to Free at period end
- `subscription_expired` — immediate downgrade to Free
- `subscription_payment_success` — extend access, update renewal date
- `order_created` — initial purchase confirmation

**`processed_events` table recommendation (Claude's discretion):**
Use **SQLite on VPS** (same `muonroi.db` pattern as local CLI, but on the control-plane server). This avoids adding PostgreSQL as a new dependency. The control-plane already uses PostgreSQL for rulesets — use PostgreSQL's `processed_events` table there for consistency with the existing infrastructure.

### Pattern 5: Remote Pricing Fetch (WEB-02)

```typescript
// src/cloud/pricing-fetch.ts
// Replaces static PRICING import from src/providers/pricing.ts at startup

interface RemotePricingResponse {
  version: string;
  updated_at: string;
  pricing: Record<string, Record<string, { input_per_million_usd: number; output_per_million_usd: number }>>;
}

let _cache: { data: RemotePricingResponse; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function fetchRemotePricing(): Promise<RemotePricingResponse | null> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache.data;
  try {
    const resp = await fetch("https://cp.truyentm.xyz/api/pricing", {
      signal: AbortSignal.timeout(3000) // 3s timeout — non-blocking on startup
    });
    if (!resp.ok) return null;
    const data = await resp.json() as RemotePricingResponse;
    _cache = { data, fetchedAt: Date.now() };
    return data;
  } catch {
    return null; // Fall back to static PRICING table on failure
  }
}

// lookupPricing() calls fetchRemotePricing() first, falls back to static PRICING
```

**Control-plane endpoint (no auth, public):**
```
GET /api/v1/pricing
Response: { version: "1.0", updated_at: "2026-04-30", pricing: { ... } }
```

### Pattern 6: Mirror Migration (CLOUD-03)

```typescript
// src/cloud/migration.ts
// Migration state tracked in ~/.muonroi-cli/migration-state.json
interface MigrationState {
  startedAt: string;
  completedAt?: string;
  totalPrinciples: number;
  migratedPrinciples: string[]; // principle_uuid list
  checksumLocal: string;   // SHA-256 of all principle UUIDs sorted
  checksumCloud: string;
  archiveExpiry: string;   // 30 days from completedAt
}

// Resume: skip already-migrated UUIDs (idempotent per principle)
// Checksum verification: compare sorted UUID list SHA-256 before and after
// 30-day local archive: do not delete local Qdrant collection; set archiveExpiry
// Progress UX: console progress bar (listr2 or simple process.stdout.write)
```

### Pattern 7: Dashboard SPA — Clerk Auth + Read-Only Pages (WEB-01)

The control-plane-dashboard already uses React 18 + Vite 5 + SWR + TailwindCSS 4. Add Clerk for the EE pages only (admin rules pages may not need it if they use a different auth).

```typescript
// apps/control-plane-dashboard/src/main.tsx
import { ClerkProvider } from "@clerk/react";

root.render(
  <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
    <App />
  </ClerkProvider>
);

// Protected page example (EEPrinciplesPage.tsx)
import { useAuth } from "@clerk/react";
export function EEPrinciplesPage() {
  const { getToken, isSignedIn } = useAuth();
  const { data } = useSWR(isSignedIn ? "/api/cloud-ee/principles" : null, async (url) => {
    const token = await getToken();
    return fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  });
  // render read-only principles list
}
```

### Anti-Patterns to Avoid

- **Constructing Qdrant collection names inline:** Always use `getCollectionName(tenantId)` — never `\`principles_${tenantId}\`` at call sites.
- **Blocking CLI startup on remote pricing fetch:** Fetch must be fire-and-forget at startup; fall back to static table on timeout.
- **Verifying LS webhook after JSON parsing:** Must verify against the **raw body** string before `JSON.parse()`.
- **Using `tenantId = "local"` for cloud EE calls:** The cloud EE client must throw if tenantId is `"local"` — never route local EE calls to cloud.
- **Processing duplicate webhooks:** Always INSERT into `processed_events` first; skip if already present.
- **Deleting local principles immediately after migration:** 30-day archive window is a hard requirement.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JWT verification | Custom JWT parser | `@clerk/backend` `verifyToken()` | Clock skew, JWKS caching, timing-safe comparison |
| Webhook HMAC verification | Hand-rolled crypto | `node:crypto.timingSafeEqual` + HMAC-SHA256 | Timing attacks are real; also handles encoding differences |
| Checkout / billing portal | Custom payment UI | LemonSqueezy checkout URL + customer portal URL | PCI compliance, global tax, VAT — never hand-roll |
| Usage analytics chart | Canvas/SVG | `recharts` | Axis ticks, responsive containers, tooltip formatting |
| Migration state tracking | File-based flags | SQLite migration table in `muonroi.db` | Resume-ability, crash recovery, atomic updates |
| Pricing cache | Time-based expiry loop | In-memory `_cache` with `fetchedAt` + TTL check | Simple, no dependencies, correct for single-process CLI |

**Key insight:** Every item above has a deceptively simple happy path and a painful edge-case implementation. The billing and auth problems especially have compliance, security, and tax implications that no solo developer should own.

---

## Common Pitfalls

### Pitfall 1: Webhook Raw Body Consumption
**What goes wrong:** Body is parsed as JSON before HMAC verification; signature check fails because JSON re-serialization changes whitespace.
**Why it happens:** Express / Hono middleware parses body by default before handler runs.
**How to avoid:** Read raw body as string (`await req.text()`) before any parsing. Verify HMAC, then `JSON.parse()`.
**Warning signs:** Signature verification fails in production but passes in local test (where you skip verification).

### Pitfall 2: Clerk JWT `tenantId` vs Qdrant Collection Name
**What goes wrong:** Clerk `userId` contains characters (`:`, `|`, spaces) that are invalid in Qdrant collection names.
**Why it happens:** Clerk user IDs like `user_2abc123` are safe but org IDs may have special chars.
**How to avoid:** Sanitize tenantId in `getCollectionName()`: replace non-alphanumeric (except `_`) with `_`, then truncate to 64 chars.
**Warning signs:** Qdrant 400 error on collection creation with special-char tenant.

### Pitfall 3: Collection-per-Tenant Scale Limit
**What goes wrong:** Qdrant Cloud limits collections per cluster. At beta scale (hundreds of users), collection-per-tenant is safe; at thousands of users, this hits limits.
**Why it happens:** Architecture decision is right for current scale but has a ceiling.
**How to avoid:** Document the scale ceiling explicitly. The CONTEXT.md decision is correct for Phase 4 beta.
**Warning signs:** Qdrant returns "too many collections" error (document this in STATUS.md as a known v2 concern).

### Pitfall 4: Duplicate Webhook Processing on Retry
**What goes wrong:** LemonSqueezy retries failed webhooks (up to 3 times with exponential backoff). Tier is double-provisioned.
**Why it happens:** Handler takes > 5s, returns 5xx, LS retries.
**How to avoid:** `INSERT OR IGNORE INTO processed_events` before any state change. Return 200 on duplicate.
**Warning signs:** User reports double-charge or duplicate principle count.

### Pitfall 5: Migration Checksum Mismatch Due to Embedding Model Version
**What goes wrong:** Phase 1 stores `embedding_model_version` per principle. If migrating with a different model, checksums diverge.
**Why it happens:** Migration copies vectors from local Qdrant; if vector dimensions differ (model changed), cloud collection rejects insert.
**How to avoid:** Group principles by `embedding_model_version`; create separate cloud collections per model version if needed: `principles_{tenantId}_{model_version}`.
**Warning signs:** Qdrant 400 on upsert with "wrong vector dimension" error.

### Pitfall 6: Clerk Token Expiry During Long Migration
**What goes wrong:** Migration of 1000+ principles takes 10+ minutes. Clerk session token (default 60-minute TTL) expires mid-migration.
**Why it happens:** Token fetched at migration start is not refreshed.
**How to avoid:** Refresh token before each batch of principles (check `exp` claim, re-fetch if within 5 minutes of expiry).
**Warning signs:** Cloud EE client returns 401 mid-migration.

### Pitfall 7: `local` tenantId Leaking to Cloud EE
**What goes wrong:** Existing EE client calls use `tenantId: "local"`. If the cloud EE client falls through for unhealthy cloud, local principles bleed into cloud namespace.
**Why it happens:** `createEEClient()` and `createCloudEEClient()` must be separate instances, never swapped at runtime.
**How to avoid:** `createCloudEEClient()` throws `Error("Cloud EE requires non-local tenantId")` in `getCollectionName()`. Integration test verifies this.
**Warning signs:** Cloud Qdrant collection named `principles_local` appears.

### Pitfall 8: Remote Pricing Blocks CLI Startup
**What goes wrong:** `fetchRemotePricing()` is awaited at startup. VPS unreachable → 3s hang before first prompt.
**Why it happens:** Async fetch awaited in main() startup sequence.
**How to avoid:** Fire-and-forget: `fetchRemotePricing().catch(() => {})` at startup. `lookupPricing()` checks cache lazily.
**Warning signs:** CLI startup time regression in CI timer.

---

## Code Examples

Verified patterns from official sources:

### LemonSqueezy Webhook Signature Verification
```typescript
// Source: https://docs.lemonsqueezy.com/help/webhooks/signing-requests
import crypto from "node:crypto";

export function verifyLemonSqueezyWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  const hmac = crypto.createHmac("sha256", secret);
  const digest = Buffer.from(hmac.update(rawBody).digest("hex"), "hex");
  const signature = Buffer.from(signatureHeader, "hex");
  if (digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(digest, signature);
}
```

### Clerk Token Verification (networkless)
```typescript
// Source: https://clerk.com/docs/reference/backend/verify-token
import { verifyToken } from "@clerk/backend";

export async function verifyClerkJWT(token: string): Promise<{ sub: string; org_id?: string }> {
  const payload = await verifyToken(token, {
    jwtKey: process.env.CLERK_JWT_KEY, // PEM key, enables networkless verification
    authorizedParties: ["https://cp.truyentm.xyz", "http://localhost:3000"]
  });
  return { sub: payload.sub, org_id: payload.org_id as string | undefined };
}
```

### Qdrant Collection-Per-Tenant Wrapper
```typescript
// src/cloud/collection.ts — the lint-enforceable wrapper
const COLLECTION_PREFIX = "principles_";
const MAX_TENANT_SEGMENT_LEN = 60;

export function getCollectionName(tenantId: string): string {
  if (!tenantId || tenantId === "local") {
    throw new Error(`Invalid tenantId for cloud EE: "${tenantId}"`);
  }
  const safe = tenantId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, MAX_TENANT_SEGMENT_LEN);
  return `${COLLECTION_PREFIX}${safe}`;
}
```

### idempotent `processed_events` Table Migration (SQLite)
```sql
-- Migration added to src/storage/migrations.ts (version 3)
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
) STRICT;
```

### Dashboard Clerk-Protected Route (Vite/React SPA)
```typescript
// apps/control-plane-dashboard/src/pages/EEPrinciplesPage.tsx
// Source: https://clerk.com/docs/quickstarts/react
import { useAuth, RedirectToSignIn } from "@clerk/react";
import useSWR from "swr";

export function EEPrinciplesPage() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  if (!isLoaded) return <div>Loading...</div>;
  if (!isSignedIn) return <RedirectToSignIn />;

  const { data } = useSWR("cloud-ee-principles", async () => {
    const token = await getToken();
    const resp = await fetch("/api/cloud-ee/principles", {
      headers: { Authorization: `Bearer ${token}` }
    });
    return resp.json();
  });
  return <div>{/* read-only principles list */}</div>;
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Stripe for Vietnam sellers | LemonSqueezy (Merchant of Record) | 2023 onwards | Handles global VAT/tax, no Stripe account setup issue for Vietnam |
| Qdrant collection-per-tenant at scale | Qdrant tiered multitenancy (1.16+) | Qdrant 1.16, late 2024 | For Phase 4 beta scale (hundreds), collection-per-tenant is fine |
| Manual JWT parsing | Clerk SDK `verifyToken()` with networkless mode | 2024 | Zero network latency on hot-path if CLERK_JWT_KEY provided |
| React 17 dashboard | React 18 (existing in control-plane-dashboard) | 2022 | Already on React 18; do not upgrade to 19 to avoid SWR/react-router incompatibility |

**Deprecated / outdated:**
- `clerk/clerk-sdk-node` (old): Replaced by `@clerk/backend` + `@clerk/express`. Use `@clerk/backend` for raw token verification.
- Stripe (for this use case): LemonSqueezy handles MoR for Vietnam sellers; Stripe requires business entity registration.

---

## Open Questions

1. **Qdrant instance on VPS — existing vs new**
   - What we know: Control-plane VPS (`100.79.164.25`) hosts the existing experience-engine Qdrant.
   - What's unclear: Is the existing Qdrant instance the cloud EE Qdrant, or does Phase 4 spin up a second Qdrant? The `experience-engine` already runs Qdrant locally.
   - Recommendation: Reuse the VPS Qdrant instance. Create cloud EE collections in a separate namespace (`principles_*`) that doesn't conflict with experience-engine collections. Verify QDRANT_URL and QDRANT_API_KEY are available on the VPS.

2. **Clerk application setup — separate vs shared**
   - What we know: Clerk free tier covers beta. One Clerk application supports both CLI (Device/OAuth flow) and React SPA.
   - What's unclear: Whether to use Clerk Organizations for Team tier or just user IDs for Free/Pro.
   - Recommendation: Use Clerk user `id` as `tenantId` for Free/Pro. Team tier (Phase 4 scope) can use Clerk `organizationId` as `tenantId`. Both map to `getCollectionName()` the same way.

3. **ASP.NET vs Node.js webhook handler**
   - What we know: The control-plane is ASP.NET 8. LemonSqueezy webhooks should hit the same VPS.
   - What's unclear: Whether to add the webhook endpoint to the existing ASP.NET API or a new thin Node.js sidecar.
   - Recommendation: Add to the existing ASP.NET API as a new `BillingWebhookEndpoints.cs` route group. Avoids running a second process. The HMAC-SHA256 verification pattern is identical in C# (`System.Security.Cryptography.HMACSHA256`).

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Qdrant on VPS | CLOUD-01, CLOUD-02, CLOUD-03 | Assumed (runs experience-engine) | Unknown | — (blocking if absent) |
| Clerk account | CLOUD-04, WEB-01, BILL-02 | Must be created | — | — (required for auth) |
| LemonSqueezy store | BILL-01, BILL-02 | Must be created | — | — (required for billing) |
| `@qdrant/js-client-rest` | CLOUD-01,03 | ✓ | 1.17.0 (in deps) | — |
| `bun` | CLI commands | ✓ | >=1.3.13 (locked) | — |
| VPS Nginx | WEB-01 (dashboard deploy) | Assumed (VPS running) | Unknown | — |
| PostgreSQL on VPS | `processed_events` if using PG | Assumed (control-plane uses it) | Unknown | SQLite fallback |

**Missing dependencies with no fallback:**
- Clerk account + Publishable Key + JWT public key (CLERK_JWT_KEY) — must be created before implementation
- LemonSqueezy store + product variants (Free/Pro/Team) configured — must be created before webhook testing
- VPS Qdrant URL + API key accessible to control-plane API

**Missing dependencies with fallback:**
- PostgreSQL `processed_events`: fallback to SQLite on VPS (same approach as CLI local db)
- Nginx config for dashboard: fallback to `vite preview` on port 5173 during dev

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `bun test --reporter=verbose` |
| Full suite command | `bun test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CLOUD-01 | `getCollectionName("local")` throws | unit | `bun test src/cloud/collection.test.ts -t "throws on local"` | ❌ Wave 0 |
| CLOUD-01 | `getCollectionName("user_abc123")` returns `principles_user_abc123` | unit | `bun test src/cloud/collection.test.ts` | ❌ Wave 0 |
| CLOUD-02 | Free-tier query always includes payload filter | unit | `bun test src/cloud/client.test.ts -t "free tier filter"` | ❌ Wave 0 |
| CLOUD-03 | Migration skips already-migrated UUIDs | unit | `bun test src/cloud/migration.test.ts -t "resume"` | ❌ Wave 0 |
| CLOUD-03 | Checksum matches after full migration | unit | `bun test src/cloud/migration.test.ts -t "checksum"` | ❌ Wave 0 |
| CLOUD-04 | Cloud EE client throws on `tenantId = "local"` | unit | `bun test src/cloud/client.test.ts -t "rejects local tenant"` | ❌ Wave 0 |
| BILL-01 | Webhook signature verification rejects tampered body | unit | `bun test src/billing/webhook.test.ts -t "tampered"` | ❌ Wave 0 |
| BILL-01 | Duplicate event returns 200 without re-processing | unit | `bun test src/billing/webhook.test.ts -t "idempotent"` | ❌ Wave 0 |
| BILL-03 | Tier-change migration preserves principle count | unit | `bun test src/cloud/migration.test.ts -t "tier change golden"` | ❌ Wave 0 |
| WEB-02 | `fetchRemotePricing()` falls back to static on network error | unit | `bun test src/cloud/pricing-fetch.test.ts -t "fallback"` | ❌ Wave 0 |
| WEB-02 | `fetchRemotePricing()` caches for 24h | unit | `bun test src/cloud/pricing-fetch.test.ts -t "cache TTL"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `bun test src/cloud/ src/billing/ --reporter=verbose`
- **Per wave merge:** `bun test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/cloud/collection.test.ts` — covers CLOUD-01 lint-enforceable wrapper
- [ ] `src/cloud/client.test.ts` — covers CLOUD-02 (free-tier filter), CLOUD-04 (local tenant rejection)
- [ ] `src/cloud/migration.test.ts` — covers CLOUD-03 resume, checksum, BILL-03 tier change golden test
- [ ] `src/billing/webhook.test.ts` — covers BILL-01 HMAC, idempotency
- [ ] `src/cloud/pricing-fetch.test.ts` — covers WEB-02 fallback + cache TTL
- [ ] EE stub may need extension in `src/__test-stubs__/ee-server.ts` for cloud EE routes

---

## Project Constraints (from CLAUDE.md)

- **MCP tools preferred** over shell commands — use `filesystem`, `context7`, `playwright` MCPs where applicable in execution
- **GSD workflow mandatory** for this phase (>= 2 files, audit trail required)
- **Bun runtime locked** — no Node.js-specific APIs that don't run in Bun (e.g., no `require()` in new files)
- **Communication:** Reply to user in Vietnamese; write code comments, plans, docs in English
- **REPO_DEEP_MAP.md must be updated** when adding `src/cloud/`, `src/billing/` directories and new control-plane route groups
- **Experience Engine warnings** from PreToolUse hooks must be followed (high-confidence) or reported as noise
- **No `.env` files committed** — secrets go in `~/.muonroi-cli/cloud-auth.json` (mode 0o600) or OS keychain via keytar

---

## Sources

### Primary (HIGH confidence)
- `@clerk/backend` npm (3.4.2 verified 2026-04-30) — `verifyToken()` API
- `@qdrant/js-client-rest` npm (1.17.0 verified 2026-04-30) — already in project deps
- `@lemonsqueezy/lemonsqueezy.js` npm (4.0.0 verified 2026-04-30) — official LS SDK
- `D:\Personal\Core\muonroi-control-plane\REPO_DEEP_MAP.md` — existing dashboard + API structure
- `src/ee/client.ts`, `src/storage/db.ts`, `src/storage/migrations.ts` — existing patterns to replicate

### Secondary (MEDIUM confidence)
- [Clerk verifyToken docs](https://clerk.com/docs/reference/backend/verify-token) — verified via WebFetch
- [Qdrant multitenancy docs](https://qdrant.tech/documentation/manage-data/multitenancy/) — verified via WebFetch
- [LemonSqueezy webhook signing](https://docs.lemonsqueezy.com/help/webhooks/signing-requests) — verified via WebSearch + code pattern
- [Clerk React quickstart](https://clerk.com/docs/quickstarts/react) — verified via WebSearch
- `recharts` npm 3.8.1 — verified 2026-04-30

### Tertiary (LOW confidence)
- ASP.NET JWT Bearer + Clerk JWKS config pattern — inferred from existing `ControlPlaneAuthOptions.cs`; not verified against a Clerk+ASP.NET official guide
- LemonSqueezy variant_id for tier detection in `subscription_updated` — inferred from general LemonSqueezy docs; exact field name needs verification against LS dashboard

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all npm versions verified 2026-04-30
- Architecture: MEDIUM-HIGH — CLI patterns derived from verified existing code; ASP.NET webhook handler inferred from control-plane structure (not tested)
- Pitfalls: HIGH — raw body webhook issue, token expiry, collection naming are well-documented failure modes
- Clerk+ASP.NET integration: MEDIUM — JWKS pattern is standard; exact Clerk JWKS URI format needs verification at implementation time
- LemonSqueezy event structure: MEDIUM — event types confirmed; exact payload field names (`variant_id`, `product_id`) need verification against LS dashboard + real webhook test

**Research date:** 2026-04-30
**Valid until:** 2026-05-30 (30 days — Clerk/LemonSqueezy SDKs are moderately fast-moving)
