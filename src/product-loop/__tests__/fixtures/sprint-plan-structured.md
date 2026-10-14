{
  "type": "implementation_plan",
  "summary": "Sprint 1 plan: build the Acme.Widgets Roslyn analyzer with 3 core rules, package it as a NuGet target for netstandard2.0, register it into the Acme.sln solution, make warnings show up in Visual Studio, and support disabling each rule individually.",
  "acceptance_criteria": [
    "Given a C# project with the Acme.Widgets NuGet package installed, when a line exceeds 150 characters, then Visual Studio shows warning ACME0001.",
    "Given a C# project with the Acme.Widgets NuGet package installed, when an argument/parameter list has wrapped but at least one item is not on its own line, then Visual Studio shows warning ACME0002, and no warning fires when the whole list is on one line.",
    "Given a C# project with the Acme.Widgets NuGet package installed, when two or more consecutive blank lines appear, then Visual Studio shows warning ACME0003, and no warning fires for a single blank line.",
    "Given the package is installed, when a #pragma warning disable [rule_id] or an .editorconfig entry is added, then the corresponding warning no longer shows.",
    "Given a successful build, then a NuGet package for Acme.Widgets targeting netstandard2.0 is produced under build/ in the Acme.sln solution.",
    "Given any C# project with the Acme.Widgets NuGet package installed, then all 3 rules work with no extra configuration."
  ],
  "actionItems": [
    {
      "step": "Create the analyzer project structure under src/Acme.Widgets, target netstandard2.0, and register it into src/Acme.sln",
      "owner_lens": "Roslyn Analyzer Engineer",
      "time_estimate": "2h",
      "depends_on": [],
      "acceptance_criteria": "The analyzer project builds and is correctly registered in the solution."
    },
    {
      "step": "Implement rule ACME0001: flag lines exceeding 150 characters",
      "owner_lens": "Roslyn Analyzer Engineer",
      "time_estimate": "3h",
      "depends_on": ["step1"],
      "acceptance_criteria": "ACME0001 fires correctly for lines over 150 chars and not for shorter lines, implemented in src/Acme.Widgets/Rules/Acme0001Analyzer.cs; basic unit tests pass."
    },
    {
      "step": "Implement rule ACME0002: flag a wrapped argument/parameter list where at least one item is not on its own line",
      "owner_lens": "Roslyn Analyzer Engineer",
      "time_estimate": "4h",
      "depends_on": ["step1"],
      "acceptance_criteria": "ACME0002 fires correctly for the violating cases and not for single-line lists, implemented in src/Acme.Widgets/Rules/Acme0002Analyzer.cs; basic unit tests pass."
    },
    {
      "step": "Implement rule ACME0003: flag two or more consecutive blank lines",
      "owner_lens": "Roslyn Analyzer Engineer",
      "time_estimate": "2h",
      "depends_on": ["step1"],
      "acceptance_criteria": "ACME0003 fires correctly for >=2 consecutive blank lines and not for a single blank line, implemented in src/Acme.Widgets/Rules/Acme0003Analyzer.cs; basic unit tests pass."
    },
    {
      "step": "Add per-rule disable support in src/Acme.Widgets/RuleConfiguration via #pragma warning disable and .editorconfig for all 3 rules",
      "owner_lens": "Roslyn Analyzer Engineer",
      "time_estimate": "2h",
      "depends_on": ["step2", "step3", "step4"],
      "acceptance_criteria": "Adding #pragma warning disable [rule_id] or an .editorconfig entry suppresses the matching rule."
    },
    {
      "step": "Create the unit test project under src/Acme.Widgets.Tests and register it into the solution",
      "owner_lens": "Roslyn Test Specialist",
      "time_estimate": "1.5h",
      "depends_on": ["step1"],
      "acceptance_criteria": "The test project builds and can run tests against the analyzer."
    },
    {
      "step": "Write unit tests in src/Acme.Widgets.Tests/Rules covering all 3 rules, including edge cases (exactly 150 chars, trailing comma, single-line fluent chain, one blank line, two consecutive blank lines)",
      "owner_lens": "Roslyn Test Specialist",
      "time_estimate": "4h",
      "depends_on": ["step2", "step3", "step4", "step6"],
      "acceptance_criteria": "All unit tests pass with no false positives on the valid cases."
    },
    {
      "step": "Configure NuGet packaging for Acme.Widgets in src/Acme.Widgets/build, with output under build/",
      "owner_lens": "Roslyn Analyzer Engineer",
      "time_estimate": "1.5h",
      "depends_on": ["step2", "step3", "step4", "step7"],
      "acceptance_criteria": "The NuGet package is produced under build/ and contains all 3 rules plus the disable configuration."
    },
    {
      "step": "Verify integration: install the NuGet package into a sample project, confirm warnings show in Visual Studio 2022, and confirm per-rule disabling works",
      "owner_lens": "Acme Developer Proxy",
      "time_estimate": "2h",
      "depends_on": ["step8"],
      "acceptance_criteria": "Warnings show correctly on violations, per-rule disabling works, no errors during use."
    },
    {
      "step": "Write usage documentation describing all 3 rules under docs/",
      "owner_lens": "Acme Developer Proxy",
      "time_estimate": "1.5h",
      "depends_on": ["step9"],
      "acceptance_criteria": "The docs cover all 3 rules, installation, and how to disable each rule."
    }
  ],
  "nextActions": [
    { "action": "implement", "label": "Implement the sprint 1 plan", "reason": "The plan is agreed and has clear execution steps." }
  ]
}
---READABLE---
## Agreed Architecture
The analyzer is built entirely on pure Roslyn compile-time APIs, using SyntaxTreeAnalysisContext to scan the C# syntax tree with no runtime library dependency, keeping it AOT-compatible. It has no dependency on any company business library, is packaged as a NuGet package (Acme.Widgets) targeting netstandard2.0, and is registered into the Acme.sln solution under the company's standard folder layout (src/Acme.Widgets for the analyzer, src/Acme.Widgets.Tests for unit tests, build/ for NuGet output, docs/ for documentation).

## Sprint 1 Acceptance Criteria
- Visual Studio shows warning ACME0001 for lines over 150 characters.
- Visual Studio shows warning ACME0002 for a wrapped argument/parameter list with at least one item not on its own line; no warning for a single-line list.
- Visual Studio shows warning ACME0003 for two or more consecutive blank lines; no warning for a single blank line.
- Disabling via #pragma or .editorconfig suppresses the matching warning.
- A NuGet package targeting netstandard2.0 is produced under build/ in the Acme.sln solution.
- All 3 rules work after installing the package, with no extra configuration.
