# OSS / Commercial Package Boundary

## Rule
- OSS packages MUST NOT depend on Commercial packages.
- Verified by: `scripts/check-modular-boundaries.ps1`

## OSS Packages (Apache 2.0 - public NuGet)
- Muonroi.Core.Abstractions
- Muonroi.RuleEngine.Abstractions
- Muonroi.RuleEngine.Core

## Commercial Packages (Muonroi Commercial License - private feed)
- Muonroi.Governance.Enterprise
- Muonroi.RuleEngine.Runtime.Web
