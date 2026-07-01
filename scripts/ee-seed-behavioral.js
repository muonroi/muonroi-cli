#!/usr/bin/env node
'use strict';
// ee-seed-behavioral.js — Bootstrap experience-behavioral with muonroi-cli patterns
// Runs on VPS: node ~/.experience/scripts/ee-seed-behavioral.js [--dry-run]
const path = require('path');
const core = require(path.join(require('os').homedir(), '.experience', 'experience-core.js'));

const DRY_RUN = process.argv.includes('--dry-run');

// Behavioral patterns — specific to muonroi-cli, TypeScript, React TUI, AI agent development
const BEHAVIORAL = [
  // --- muonroi-cli specific ---
  { trigger: "agent ignores custom instructions", failureMode: "CLAUDE.md / AGENTS.md rules not followed", solution: "Place highest-priority rules in AGENT OPERATING CONTRACT section at the VERY FRONT of the system prompt. Rules in CUSTOM INSTRUCTIONS (AGENTS.md tail) have lower primacy. Evidence: forensics sessions d95113d3be09, 5f349ef73ccb.", conditions: ["repo:muonroi-cli", "scope:system-prompt"] },
  { trigger: "sub-agent huge prompt cost", failureMode: "peak single-call input > 80,000 tokens", solution: "Use task(explore) for research, enforce getSubAgentBudgetChars() cap via wrapToolSetWithCap. Phase B3/B4 auto-compaction keeps cumulative input under 80K per call. Track with usage_forensics <prefix>.", conditions: ["repo:muonroi-cli", "scope:cost"] },
  { trigger: "hardcoded model ID in production code", failureMode: "model ID string literal bypasses catalog", solution: "Use getModelByTier() / getModelsForProvider() from registry.ts. Resolve via catalog.json + user settings + runtime detection. Throw error on unresolvable — never fallback ?? 'anthropic'.", conditions: ["repo:muonroi-cli", "scope:providers"] },
  { trigger: "silent error in catch block", failureMode: "empty catch {} hides crash cause", solution: "Always log err.message + context. For HTTP calls, also log statusCode + responseBody. Use logger.error() or console.error() — never empty catch or catch { return null }.", conditions: ["repo:muonroi-cli", "scope:error-handling"] },
  { trigger: "self-verify not run after TUI change", failureMode: "UI regression caught in production", solution: "After changing src/ui/**/*.tsx, run selfverify_start(mode='tier1'). Pre-push hook auto-triggers Tier 1 on watched surfaces. Run a full Tier 2 agentic when intent-vs-reality edge cases possible.", conditions: ["repo:muonroi-cli", "scope:testing"] },
  { trigger: "cost-leak from maxOutputTokens on OAuth provider", failureMode: "OpenAI-compatible providers reject max_output_tokens", solution: "Use shouldDropParam(runtime, 'maxOutputTokens') from providers/runtime.ts before passing to streamText. Never inline unsupportedParams check — the central rule covers all providers.", conditions: ["repo:muonroi-cli", "scope:providers"] },
  { trigger: "ee_query tool not used before risky step", failureMode: "repeating past mistakes that were already learned", solution: "Call ee_query before starting work in unfamiliar area. Recall-first rule: EE brain holds prior decisions/gotchas. After acting on recall, rate with ee_feedback. After fixing an error, save lesson with ee_write.", conditions: ["repo:muonroi-cli", "scope:ee"] },
  { trigger: "bun test fails on WSL due to native bindings", failureMode: "Windows node_modules contains Windows-native bindings, Linux can't load them", solution: "Clone repo separately into WSL home directory (~/muonroi-cli) with bun install. Never share node_modules between Windows and WSL. Run WSL tests: wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && bun test'.", conditions: ["repo:muonroi-cli", "scope:environment"] },
  { trigger: "compaction elides important tool output", failureMode: "critical evidence lost after compaction", solution: "Mark high-value tool outputs with ee_query('tool-artifact id=XXX') to rehydrate. Use PRESERVE_FULL_CONTEXT veto or KEEP_TOOL_IDS policy for source reads, config files, test results.", conditions: ["repo:muonroi-cli", "scope:context"] },
  { trigger: "new dependency without ponytail check", failureMode: "unnecessary dependency adds bundle size and security surface", solution: "Before adding a dependency: (1) Can stdlib solve it? (2) Can native API solve it? (3) Can a one-liner solve it? (4) Is this YAGNI? Only fall back to npm package when 1-4 exhausted.", conditions: ["repo:muonroi-cli", "scope:dependencies"] },
  { trigger: "push without running full test suite", failureMode: "broken main with tests that fail on CI", solution: "Pre-push gate: bun test (0 failures) + bunx tsc --noEmit (0 errors). For UI/harness: selfverify_start(mode='tier1'). No exceptions for pre-existing failures. Fix or revert.", conditions: ["repo:muonroi-cli", "scope:git"] },
  { trigger: "agent cognitive overload from context bloat", failureMode: "agent ignores rules when prompt exceeds attention budget", solution: "Max tool rounds default 8 (not 12). Strip irrelevant tool descriptions from text prompt (wallet, computer, generate, schedule). Add SELF-LIMIT section prompting sub-agents for >5 rounds.", conditions: ["repo:muonroi-cli", "scope:system-prompt"] },
  // --- React TUI / Ink patterns ---
  { trigger: "React state update during streaming freezes TUI", failureMode: "Ink re-renders on every stream token, UI locks up", solution: "Throttle state updates to at most once every 150ms. Use useRef for accumulator, setTimeout/flush pattern. Store reasoning in ChatEntry to display in history.", conditions: ["repo:muonroi-cli", "scope:ui"] },
  { trigger: "Semantic component missing on new TUI element", failureMode: "agent harness cannot see UI element in E2E tests", solution: "Wrap every user-visible root with <Semantic id='...' role='...' name='...'>. Pick role from protocol.ts union. Mirror focus/selected/disabled state. Run lint:semantic to catch unwrapped components.", conditions: ["repo:muonroi-cli", "scope:testing"] },
  // --- TypeScript patterns ---
  { trigger: "TypeScript 'any' escape hatch overuse", failureMode: "type safety lost, runtime errors in production", solution: "Prefer 'unknown' over 'any'. Use type guards, discriminated unions, and Zod for runtime validation. 'any' is only acceptable in test mocks and third-party type stubs.", conditions: ["lang:typescript", "scope:code-quality"] },
  { trigger: "async function without error handling", failureMode: "unhandled promise rejection crashes process", solution: "Every async call must have either try/catch, .catch() handler, or be inside an async function with a top-level error boundary. Use Promise.allSettled() for parallel operations.", conditions: ["lang:typescript", "scope:error-handling"] },
  { trigger: "zod schema not matching runtime reality", failureMode: "parse() throws on production data that was valid in dev", solution: "Use .safeParse() in production paths, .parse() only at boundaries where throwing is acceptable. Add .passthrough() or .strip() explicitly — never rely on defaults.", conditions: ["lang:typescript", "scope:validation"] },
  // --- .NET / BB patterns ---
  { trigger: "Building Block project compile error after scaffold", failureMode: "dotnet build fails with missing package references", solution: "run dotnet restore before dotnet build. Ensure NuGet source includes private feed for commercial packages. Check Directory.Build.props for package references.", conditions: ["framework:building-block", "scope:scaffold"] },
  { trigger: "rule engine expression throws at runtime", failureMode: "expression evaluation fails on valid input", solution: "Test rules with ExpressionTestHelper before deploying. Use [RulePriority] for ordering. Wrap expressions in try/catch with logged context — never let one rule failure block the pipeline.", conditions: ["framework:building-block", "scope:rule-engine"] },
  { trigger: "tenant context not propagating to background job", failureMode: "background tasks lose tenant identity", solution: "Capture ITenantContext at enqueue time. Restore in job handler via TenantContext.Restore(tenantId, claims). Use AsyncLocal<T> for flow across async boundaries.", conditions: ["framework:building-block", "scope:tenancy"] },
];

async function main() {
  console.log(`EE Seed Behavioral — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  let count = 0;

  for (const b of BEHAVIORAL) {
    const entry = {
      trigger: b.trigger,
      failureMode: b.failureMode,
      solution: b.solution,
      judgment: 'behavioral',
      conditions: b.conditions,
      sourceSession: 'maturity-bootstrap-20260626',
      createdFrom: 'seed',
    };

    if (!DRY_RUN) {
      try {
        await core.storeExperience(entry, null, 'muonroi-cli');
        count++;
        console.log(`  ✓ ${b.trigger.slice(0, 60)}`);
      } catch (e) {
        console.error(`  ✗ ${b.trigger.slice(0, 60)}: ${e.message}`);
      }
    } else {
      console.log(`  [dry] ${b.trigger.slice(0, 60)}`);
      count++;
    }
  }

  const { activityLog } = require(path.join(require('os').homedir(), '.experience', 'src', 'activity.js'));
  activityLog({ op: 'maturity-seed-behavioral', count, dryRun: DRY_RUN });
  console.log(`Done. Seeded: ${count} behavioral entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
