# muonroi-building-block — Deep Map (fixture for unit tests)

---

## 1. Rule Engine

### RuleEngine.Abstractions (`src/Muonroi.RuleEngine.Abstractions/`)

| File | Class/Interface | Key Methods/Properties |
|------|----------------|----------------------|
| IRule.cs | `IRule<TContext>` | `EvaluateAsync(ctx, facts, ct) → RuleResult`, `ExecuteAsync(ctx, ct)`, Code, Order, DependsOn |
| FactBag.cs | `FactBag` | `Get<T>(key)`, `Set<T>(key, value)`, `TryGet<T>(key, out T)`, `Remove(key)` |
| RuleResult.cs | `RuleResult` | `Passed()`, `Success()`, `Failure(errors)` — static factories |
| HookPoint.cs | `HookPoint` enum | BeforeRule, AfterRule, BeforeValidation, AfterValidation |

### RuleEngine.Core (`src/Muonroi.RuleEngine.Core/`)

| File | Class | Key Methods |
|------|-------|------------|
| RuleOrchestrator.cs | `RuleOrchestrator<TContext>` | `ExecuteAsync(context, filterPoint, ct) → FactBag` |
| MRuleEngineBuilder.cs | `MRuleEngineBuilder` | Fluent builder for engine setup |

---

## 2. Multi-Tenancy

### Tenancy.Abstractions (`src/Muonroi.Tenancy.Abstractions/`)

| File | Class/Interface | Purpose |
|------|----------------|---------|
| ITenantContext.cs | `ITenantContext` | Get/set current TenantId |
| ITenantIdResolver.cs | `ITenantIdResolver` | Extract tenant ID from request |
