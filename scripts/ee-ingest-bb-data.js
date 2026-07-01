#!/usr/bin/env node
'use strict';
// ee-ingest-bb-data.js — Populate bb-packages + bb-recipes collections
// Runs on VPS: node ~/.experience/scripts/ee-ingest-bb-data.js [--dry-run]
const path = require('path');
const core = require(path.join(require('os').homedir(), '.experience', 'experience-core.js'));
const { activityLog } = require(path.join(require('os').homedir(), '.experience', 'src', 'activity.js'));

const DRY_RUN = process.argv.includes('--dry-run');

// --- BB Package Data (from MCP muonroi-docs) ---
const BB_PACKAGES = [
  { name: "Muonroi.Rules", tier: "OSS", summary: "Core rule engine with expression evaluation, rule sets, and decision pipeline.", nuget: "Muonroi.Rules", domain: "rule-engine" },
  { name: "Muonroi.Rules.DecisionTable", tier: "OSS", summary: "Decision table engine supporting hit policies, priority resolution, and multi-condition evaluation.", nuget: "Muonroi.Rules.DecisionTable", domain: "rule-engine" },
  { name: "Muonroi.Core", tier: "OSS", summary: "Foundation library: entity base, repository pattern, unit-of-work, specification pattern.", nuget: "Muonroi.Core", domain: "foundation" },
  { name: "Muonroi.Mapper", tier: "Internal", summary: "Object-to-object mapper with convention-based and explicit mapping profiles.", nuget: null, domain: "foundation" },
  { name: "Muonroi.BuildingBlock.Shared", tier: "Internal", summary: "Shared kernel for Building Block: common interfaces, enums, value objects.", nuget: null, domain: "foundation" },
  { name: "Muonroi.BuildingBlock.All", tier: "Commercial", summary: "One-package install for the complete Muonroi Building Block commercial stack: rule engine, governance, tenancy, data access, caching, messaging, observability, PDF.", nuget: "Muonroi.BuildingBlock.All", domain: "meta" },
  { name: "Muonroi.Grpc", tier: "Commercial", summary: "gRPC service integration with code-first contracts, interceptors, and streaming support.", nuget: "Muonroi.Grpc", domain: "messaging" },
  { name: "Muonroi.Secrets", tier: "OSS", summary: "Secret management abstraction over HashiCorp Vault, Azure Key Vault, and AWS Secrets Manager.", nuget: "Muonroi.Secrets", domain: "infrastructure" },
  { name: "Muonroi.Data", tier: "Commercial", summary: "Data access layer with multi-tenancy, audit trails, soft-delete, and query optimization on top of Entity Framework Core.", nuget: "Muonroi.Data", domain: "data" },
  { name: "Muonroi.Caching", tier: "Commercial", summary: "Distributed caching with Redis backplane, cache invalidation strategies, and multi-level cache.", nuget: "Muonroi.Caching", domain: "infrastructure" },
  { name: "Muonroi.Observability", tier: "Commercial", summary: "OpenTelemetry-based observability: distributed tracing, metrics, structured logging with Serilog sink.", nuget: "Muonroi.Observability", domain: "infrastructure" },
  { name: "Muonroi.Tenancy", tier: "Commercial", summary: "Multi-tenant resolution, isolation strategies (database-per-tenant, schema-per-tenant, shared), and tenant context propagation.", nuget: "Muonroi.Tenancy", domain: "tenancy" },
  { name: "Muonroi.Governance", tier: "Commercial", summary: "Policy-as-code governance engine: rule-based access control, compliance checks, audit logging.", nuget: "Muonroi.Governance", domain: "governance" },
  { name: "Muonroi.Messaging", tier: "Commercial", summary: "Message bus abstraction over RabbitMQ and Azure Service Bus with dead-letter handling, retry policies, and correlation.", nuget: "Muonroi.Messaging", domain: "messaging" },
  { name: "Muonroi.Pdf", tier: "Commercial", summary: "PDF generation from templates with IronPDF/QuestPDF backend, watermarking, and digital signatures.", nuget: "Muonroi.Pdf", domain: "document" },
  { name: "Muonroi.Bff", tier: "Commercial", summary: "Backend-for-Frontend pattern: API aggregation, response shaping, and client-specific endpoints.", nuget: "Muonroi.Bff", domain: "api" },
  { name: "Muonroi.ServiceDiscovery.Consul", tier: "Commercial", summary: "Consul-based service discovery with health checks, DNS resolution, and config key-value store.", nuget: "Muonroi.ServiceDiscovery.Consul", domain: "infrastructure" },
  { name: "Muonroi.RuleEngine.Runtime.Web", tier: "Commercial", summary: "HTTP API exposing rule engine as a REST service with rule hot-reload and versioning.", nuget: "Muonroi.RuleEngine.Runtime.Web", domain: "rule-engine" },
  { name: "Muonroi.RuleEngine.DecisionTable.Web", tier: "Commercial", summary: "HTTP API for decision table execution with Excel import/export and test scenario runner.", nuget: "Muonroi.RuleEngine.DecisionTable.Web", domain: "rule-engine" },
  { name: "Muonroi.UiEngine.Catalog", tier: "Commercial", summary: "Dynamic UI catalog: metadata-driven form generation, list views, and detail pages from entity definitions.", nuget: "Muonroi.UiEngine.Catalog", domain: "ui" },
  // Also from core-foundation packages
  { name: "Muonroi.Logging", tier: "Internal", summary: "Structured logging abstractions with Serilog integration and enrichment pipeline.", nuget: null, domain: "infrastructure" },
  { name: "Muonroi.Validation", tier: "Internal", summary: "FluentValidation integration with domain-level validation rules and cross-entity validation.", nuget: null, domain: "foundation" },
  { name: "Muonroi.Domain", tier: "Internal", summary: "Domain-driven design building blocks: aggregates, entities, value objects, domain events, and specifications.", nuget: null, domain: "foundation" },
  { name: "Muonroi.EntityFrameworkCore", tier: "Internal", summary: "Entity Framework Core conventions: shadow properties, query filters for tenancy/soft-delete, interceptors.", nuget: null, domain: "data" },
];

// --- BB Recipe Data (from MCP muonroi-docs) ---
const BB_RECIPES = [
  {
    title: "Scaffold a new Building Block project",
    summary: "Use `muonroi-cli /ideal` in an empty directory. The scaffold council detects .NET target, installs the `muonroi-building-block` template via `dotnet new`, wires Program.cs with rule engine + governance + tenancy, and runs `dotnet restore && dotnet build` as quality gate.",
    domain: "getting-started"
  },
  {
    title: "Create a custom rule",
    summary: "Implement `IRule<TContext>` interface. Register in DI via `AddRule<MyRule>()`. Rules are discovered automatically by the rule engine and executed in priority order. Use `[RulePriority]` attribute or fluent configuration.",
    domain: "rule-engine"
  },
  {
    title: "Define a decision table",
    summary: "Create a class inheriting from `DecisionTable<TInput, TOutput>`. Define conditions as properties with `[Condition]` attribute, actions with `[Action]`. Use hit policies: Unique, First, Priority, Any, RuleOrder.",
    domain: "rule-engine"
  },
  {
    title: "Multi-tenant database strategy",
    summary: "Choose isolation: `DatabasePerTenant` (separate DB), `SchemaPerTenant` (shared DB, separate schemas), or `Shared` (tenant-id column filter). Configure in `appsettings.json` under `Muonroi:Tenancy:Strategy`. The `ITenantContext` is resolved from HTTP header `X-Tenant-Id` or JWT claim.",
    domain: "tenancy"
  },
  {
    title: "Setup distributed caching",
    summary: "Add `Muonroi.BuildingBlock.All` or `Muonroi.Caching` package. Configure Redis connection string. Use `IDistributedCache` (Microsoft abstraction) with Muonroi extensions for cache stampede protection and multi-level cache (L1 memory + L2 Redis).",
    domain: "infrastructure"
  },
  {
    title: "gRPC service with code-first contracts",
    summary: "Define proto contracts as C# interfaces with `[GrpcService]` attribute. Muonroi.Grpc generates `.proto` files at build time. Register via `services.AddMuonroiGrpc()`. Supports client-side load balancing and retry policies.",
    domain: "messaging"
  },
  {
    title: "OpenTelemetry observability setup",
    summary: "Add `Muonroi.Observability` package. Configure in Program.cs: `builder.AddMuonroiObservability()`. Auto-instruments ASP.NET Core, EF Core, HttpClient, gRPC. Exports to OTLP endpoint. Includes pre-built Grafana dashboards.",
    domain: "infrastructure"
  },
  {
    title: "Governance policy-as-code",
    summary: "Define policies as classes implementing `IGovernancePolicy<TContext>`. Policies evaluate against the current tenant/user/operation context. Results are cached per policy version. Audit trail written to `GovernanceAudit` table.",
    domain: "governance"
  },
  {
    title: "Backend-for-Frontend API aggregation",
    summary: "Create a BFF controller inheriting from `BffControllerBase`. Use `[Aggregate]` attribute to compose multiple downstream service calls into a single response. Includes response caching and circuit breaker per downstream.",
    domain: "api"
  },
  {
    title: "Dynamic UI from entity metadata",
    summary: "Annotate entity classes with `[UiCatalog]` attributes. `Muonroi.UiEngine.Catalog` generates list views, detail forms, and search filters automatically. Supports custom React components via `[UiComponent]` override.",
    domain: "ui"
  },
  {
    title: "Seed data with rule-based initialization",
    summary: "Use `ISeedData<T>` interface with rule-based conditions. Seeds only execute when their rule condition evaluates to true. Ordered by priority. Supports idempotent re-runs.",
    domain: "data"
  },
  {
    title: "NuGet package boundary: OSS vs Commercial",
    summary: "OSS packages (Muonroi.Rules, Muonroi.Core, Muonroi.Secrets) are on NuGet.org under MIT license. Commercial packages are on private feed, licensed per developer/endpoint. `Muonroi.BuildingBlock.All` is the unified commercial meta-package.",
    domain: "reference"
  },
];

async function main() {
  console.log(`EE Ingest BB Data — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  let ingested = 0;

  // --- Packages ---
  for (const pkg of BB_PACKAGES) {
    const entry = {
      trigger: `bb-package:${pkg.name}`,
      failureMode: `unknown:${pkg.domain}`,
      solution: `Use ${pkg.nuget || 'internal'} package: ${pkg.summary}`,
      judgment: 'structural',
      conditions: [`tier:${pkg.tier}`, `domain:${pkg.domain}`],
      sourceSession: 'maturity-bootstrap-20260626',
      createdFrom: 'maturity-bootstrap',
    };
    if (!DRY_RUN) {
      try {
        await core.storeExperience(entry, `bb-dotnet:${pkg.domain}`, 'muonroi-building-block');
        ingested++;
      } catch (e) {
        console.error(`FAIL package ${pkg.name}: ${e.message}`);
      }
    } else {
      console.log(`[dry] package: ${pkg.name} → bb-packages`);
      ingested++;
    }
  }

  // --- Recipes ---
  for (const recipe of BB_RECIPES) {
    const entry = {
      trigger: `bb-recipe:${recipe.domain}`,
      failureMode: `task:${recipe.domain}`,
      solution: `${recipe.title}: ${recipe.summary}`,
      judgment: 'structural',
      conditions: [`domain:${recipe.domain}`],
      sourceSession: 'maturity-bootstrap-20260626',
      createdFrom: 'maturity-bootstrap',
    };
    if (!DRY_RUN) {
      try {
        await core.storeExperience(entry, `bb-dotnet:${recipe.domain}`, 'muonroi-building-block');
        ingested++;
      } catch (e) {
        console.error(`FAIL recipe ${recipe.title}: ${e.message}`);
      }
    } else {
      console.log(`[dry] recipe: ${recipe.title} → bb-recipes`);
      ingested++;
    }
  }

  activityLog({ op: 'maturity-ingest-bb', count: ingested, dryRun: DRY_RUN });
  console.log(`Done. Ingested: ${ingested} entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
