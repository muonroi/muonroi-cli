#!/usr/bin/env node

// ee-seed-principles.js — Seed foundational principles into experience-principles
// Runs on VPS: node ~/.experience/scripts/ee-seed-principles.js [--dry-run]
const path = require("path");
const core = require(path.join(require("os").homedir(), ".experience", "experience-core.js"));

const DRY_RUN = process.argv.includes("--dry-run");

// Universal engineering principles — language/framework agnostic, high-confidence
const PRINCIPLES = [
  {
    trigger: "pre-mature optimization",
    solution:
      "Make it correct first, then make it fast. Profile before optimizing. 90% of performance issues come from 10% of code.",
  },
  {
    trigger: "error swallowing",
    solution:
      "Never use empty catch blocks. Every caught error must be logged with context (message, stack, inputs). Silent failures are the hardest bugs to diagnose.",
  },
  {
    trigger: "hardcoded values",
    solution:
      "Never hardcode configuration values (connection strings, API keys, URLs, magic numbers). Use environment variables, config files, or secret managers. The only acceptable literals are type definitions and test fixtures.",
  },
  {
    trigger: "copy-paste code duplication",
    solution:
      "DRY (Don't Repeat Yourself): extract shared logic into a single function/module. Duplication multiplies maintenance cost linearly — fixing a bug in N places is N× the work.",
  },
  {
    trigger: "missing tests for critical path",
    solution:
      "Every critical path (auth, payment, data mutation) must have automated tests. Tests are the only proof the code works — static analysis and code review catch syntax/pattern issues but not logic gaps.",
  },
  {
    trigger: "implicit type coercion bug",
    solution:
      "Use strict equality (===) and explicit type conversion. Implicit coercion is the source of subtle, hard-to-reproduce bugs. In typed languages, prefer strict mode and avoid 'any'.",
  },
  {
    trigger: "no input validation",
    solution:
      "Validate ALL external input at the boundary: query params, request bodies, headers, file uploads, environment variables. Never trust client-side validation alone.",
  },
  {
    trigger: "tight coupling to framework",
    solution:
      "Keep domain logic framework-agnostic. Depend on abstractions (interfaces), not concrete framework types. This enables testing in isolation and future framework migration.",
  },
  {
    trigger: "N+1 query problem",
    solution:
      "Always batch database queries. One query fetching N related records is exponentially cheaper than N+1 individual queries. Use eager loading (.Include), batch endpoints, or GraphQL DataLoader.",
  },
  {
    trigger: "large pull request",
    solution:
      "Keep PRs small and focused (<400 lines changed). Small PRs are reviewed more thoroughly, merged faster, and have fewer merge conflicts. Split large features into stacked PRs.",
  },
  {
    trigger: "no logging in production",
    solution:
      "Structured logging (JSON) with correlation IDs on every request. Log levels: Debug (dev only), Info (key events), Warning (recoverable), Error (needs attention). Never log secrets or PII.",
  },
  {
    trigger: "circular dependency",
    solution:
      "Dependency graph must be a DAG (directed acyclic graph). Circular dependencies cause initialization order bugs, memory leaks, and make testing impossible. Break cycles with interfaces, events, or mediation.",
  },
  {
    trigger: "mutable global state",
    solution:
      "Avoid mutable global/static state. It makes tests order-dependent, prevents parallel execution, and creates action-at-a-distance bugs. Use dependency injection with scoped lifetimes.",
  },
  {
    trigger: "SQL injection via string concatenation",
    solution:
      "Always use parameterized queries or an ORM. Never concatenate user input into SQL strings. Even 'trusted' internal data should go through parameters.",
  },
  {
    trigger: "no retry on transient failure",
    solution:
      "Network calls, database connections, and external APIs can fail transiently. Implement exponential backoff retry (jittered) for idempotent operations. Circuit breaker for non-idempotent.",
  },
  {
    trigger: "monolithic function",
    solution:
      "Functions should do ONE thing (Single Responsibility). A function >50 lines is a warning sign. Extract sub-steps into well-named helper functions. The function name should fully describe its behavior.",
  },
  {
    trigger: "no graceful degradation",
    solution:
      "When a non-critical dependency fails, degrade gracefully instead of crashing. Return cached/default data, disable the feature, or queue for retry. The system should stay partially functional.",
  },
  {
    trigger: "missing API versioning",
    solution:
      "Version your API from day one (URL path /v1/, header Accept-Version, or content negotiation). Breaking changes without versioning break all existing clients simultaneously.",
  },
];

async function main() {
  console.log(`EE Seed Principles — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  let count = 0;

  for (const p of PRINCIPLES) {
    const entry = {
      trigger: p.trigger,
      failureMode: p.trigger,
      solution: p.solution,
      judgment: "principle",
      conditions: ["source:seed", "scope:universal"],
      sourceSession: "maturity-bootstrap-20260626",
      createdFrom: "seed",
    };

    if (!DRY_RUN) {
      try {
        await core.storeExperience(entry, null, null);
        count++;
        console.log(`  ✓ ${p.trigger.slice(0, 50)}`);
      } catch (e) {
        console.error(`  ✗ ${p.trigger.slice(0, 50)}: ${e.message}`);
      }
    } else {
      console.log(`  [dry] ${p.trigger.slice(0, 50)}`);
      count++;
    }
  }

  const { activityLog } = require(path.join(require("os").homedir(), ".experience", "src", "activity.js"));
  activityLog({ op: "maturity-seed-principles", count, dryRun: DRY_RUN });
  console.log(`Done. Seeded: ${count} principles.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
