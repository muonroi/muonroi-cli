/**
 * src/ui/slash/ideal.ts
 *
 * `/ideal` — Product Ideal Loop slash command (Phase 13).
 *
 * Subcommands:
 *   /ideal "<idea>"          start a new product run (default)
 *   /ideal status            list active runs
 *   /ideal status <runId>    detail of one run
 *   /ideal resume [runId]    resume halted/crashed run (no id = newest incomplete)
 *   /ideal abort  <runId>    hard kill
 *   /ideal ship   <runId>    force user-approval gate (skip if Cond #1-#4 pass)
 *
 * Flags (all optional):
 *   --max-cost       <usd>   default 50,  range 1..1000
 *   --max-sprints    <n>     default 8,   range 1..20
 *   --done-threshold <0..1>  default 0.9, range 0.7..1.0   (clamped, warning emitted)
 *   --stack          <text>  free-form stack hint
 *
 * Internal-only env hatch (intentionally not registered with commander so it
 * does not appear in --help):
 *   MUONROI_DEV=1  -> enables --no-customer-debate at the done-gate.
 *
 * Wire format: returns the sentinel string `__PRODUCT_LOOP__\n<json>` which
 * app.tsx parses and dispatches to orchestrator.runProductLoopV1, mirroring
 * the existing __COUNCIL__ pattern in src/ui/slash/council.ts.
 */

import { Command, InvalidArgumentError } from "commander";
import type { SlashHandler } from "./registry.js";
import { registerSlash } from "./registry.js";

export interface IdealFlags {
  budgetTokens?: number;
  maxCost: number;
  maxSprints: number;
  doneThreshold: number;
  stack?: string;
  /** Set internally when MUONROI_DEV=1; never accepted as a CLI flag. */
  noCustomerDebate?: boolean;
  /** P5: --no-prior-context skips cross-run workspace memory injection. */
  noPriorContext?: boolean;
  /** P2.7: --force-council always runs full council debate even for low-complexity ideas. */
  forceCouncil?: boolean;
  /**
   * Mode C — explicit override. `"maintain"` forces single-task PR flow even when cwd
   * has no verify recipe. `"new"` forces Mode A (greenfield) even when cwd has a recipe.
   * Undefined = auto-detect via verify recipe presence. See `.planning/MAINTAIN-MODE.md`.
   */
  mode?: "maintain" | "new";
  /** Mode C only — opt-in: run `gh pr create` after PR is built. Default false. */
  ghPr?: boolean;
}

export type IdealSubcommand = "start" | "status" | "resume" | "abort" | "ship" | "review" | "help";

export interface IdealParseResult {
  subcommand: IdealSubcommand;
  idea?: string;
  runId?: string;
  flags: IdealFlags;
  warnings: string[];
}

const DEFAULTS: IdealFlags = {
  maxCost: 50,
  maxSprints: 8,
  doneThreshold: 0.9,
};

const HELP_TEXT = [
  "/ideal — Product Ideal Loop",
  "",
  "Subcommands:",
  '  /ideal "<idea>"           Start a new product run',
  "  /ideal status [runId]    List active runs (or detail one)",
  "  /ideal resume [runId]    Resume a run (no id = newest incomplete run)",
  "  /ideal review [runId]    Render a run's transcript + sprint scores (no id = newest run)",
  "  /ideal abort  [runId]    Hard-kill a run (no id = newest incomplete run)",
  "  /ideal ship   <runId>    Force user-approval gate (skip Cond #1-#4 if passing)",
  "",
  "Flags (start only):",
  "  --max-cost       <usd>   default 50,  range 1..1000",
  "  --max-sprints    <n>     default 8,   range 1..20",
  "  --done-threshold <0..1>  default 0.9, range 0.7..1.0 (clamped)",
  "  --stack          <hint>  free-form stack description",
  "  --no-prior-context       skip cross-run workspace memory (greenfield)",
  "  --force-council          always run full council debate even for low-complexity ideas",
  "  --maintain               force Mode C (existing project → single PR) regardless of recipe detection",
  "  --new                    force Mode A (greenfield) even if cwd has a verify recipe",
  "  --gh-pr                  Mode C only — run `gh pr create` after building the PR artifact",
].join("\n");

function parseIntInRange(min: number, max: number) {
  return (raw: string): number => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new InvalidArgumentError(`must be an integer in [${min}, ${max}]`);
    }
    return n;
  };
}

function _parseFloatInRange(min: number, max: number) {
  return (raw: string): number => {
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new InvalidArgumentError(`must be a number in [${min}, ${max}]`);
    }
    return n;
  };
}

/**
 * Pure parser — exported so tests can exercise it without wiring through the
 * SlashHandler signature (which depends on a SlashContext).
 */
export function parseIdealArgs(args: string[]): IdealParseResult {
  const warnings: string[] = [];

  // Internal dev escape hatch: NOT registered with commander.
  // Intentionally not surfaced in --help.
  const noCustomerDebate = process.env.MUONROI_DEV === "1" || undefined;

  // No args at all -> help.
  if (args.length === 0) {
    return { subcommand: "help", flags: { ...DEFAULTS, noCustomerDebate }, warnings };
  }

  // Detect non-start subcommands by first token (subcommand keywords are reserved).
  const RESERVED = new Set(["status", "resume", "abort", "ship", "review", "help", "--help", "-h"]);
  const head = args[0]!;

  if (RESERVED.has(head)) {
    if (head === "help" || head === "--help" || head === "-h") {
      return { subcommand: "help", flags: { ...DEFAULTS, noCustomerDebate }, warnings };
    }
    const sub = head as IdealSubcommand;
    const runId = args[1];
    return {
      subcommand: sub,
      runId,
      flags: { ...DEFAULTS, noCustomerDebate },
      warnings,
    };
  }

  // Otherwise: start. Build a fresh commander program scoped to this invocation.
  const program = new Command();
  program
    .name("ideal")
    .description("Start a new product run")
    .argument("[idea...]", "free-form product idea")
    .option("--max-cost <usd>", "max cost in USD (1..1000)", parseIntInRange(1, 1000), DEFAULTS.maxCost)
    .option("--max-sprints <n>", "max sprints (1..20)", parseIntInRange(1, 20), DEFAULTS.maxSprints)
    .option(
      "--done-threshold <ratio>",
      "done threshold (0.7..1.0)",
      (raw: string) => {
        // Soft-clamp + warn rather than throw so a typo doesn't abort the workflow.
        const n = Number.parseFloat(raw);
        if (!Number.isFinite(n)) {
          throw new InvalidArgumentError("must be a number");
        }
        if (n < 0.7) {
          warnings.push(`--done-threshold ${n} below 0.7 — clamped to 0.7`);
          return 0.7;
        }
        if (n > 1.0) {
          warnings.push(`--done-threshold ${n} above 1.0 — clamped to 1.0`);
          return 1.0;
        }
        return n;
      },
      DEFAULTS.doneThreshold,
    )
    .option("--stack <text>", "tech stack hint")
    .option("--no-prior-context", "skip cross-run workspace memory (greenfield start)")
    .option("--force-council", "always run full council debate even for low-complexity ideas")
    .option("--maintain", "force Mode C (existing project → single PR)")
    .option("--new", "force Mode A (greenfield) — overrides verify-recipe auto-detect")
    .option("--gh-pr", "Mode C only — run gh pr create after building the PR artifact")
    .option("--budget-tokens <N>", "halt when total tokens exceed N", parseInt)
    .exitOverride(); // never call process.exit on parse error

  // commander expects a leading argv with [node, script, ...args]; we synthesize.
  let parsed: ReturnType<typeof program.parse>;
  try {
    parsed = program.parse(args, { from: "user" });
  } catch (err: any) {
    // Surface parse error as help-with-error so the slash handler returns text
    // rather than crashing the host process.
    return {
      subcommand: "help",
      flags: { ...DEFAULTS, noCustomerDebate },
      warnings: [`error: ${err?.message ?? String(err)}`],
    };
  }

  const opts = parsed.opts() as {
    maxCost: number;
    maxSprints: number;
    doneThreshold: number;
    stack?: string;
    budgetTokens?: number;
    /** Commander emits priorContext=false when user passes --no-prior-context. */
    priorContext?: boolean;
    forceCouncil?: boolean;
    maintain?: boolean;
    new?: boolean;
    ghPr?: boolean;
  };
  const ideaParts = (parsed.args as string[]) ?? [];
  const idea = ideaParts
    .join(" ")
    .trim()
    .replace(/^["']|["']$/g, "");

  if (!idea) {
    return {
      subcommand: "help",
      flags: { ...DEFAULTS, noCustomerDebate },
      warnings: ["error: idea is required"],
    };
  }

  // --maintain and --new are mutually exclusive — surface as a warning + prefer --maintain.
  let mode: "maintain" | "new" | undefined;
  if (opts.maintain === true && opts.new === true) {
    warnings.push("--maintain and --new are mutually exclusive; --maintain takes precedence");
    mode = "maintain";
  } else if (opts.maintain === true) {
    mode = "maintain";
  } else if (opts.new === true) {
    mode = "new";
  }
  // --gh-pr only makes sense for Mode C — warn if used outside maintain.
  if (opts.ghPr === true && mode !== "maintain") {
    warnings.push("--gh-pr is Mode C only and is ignored without --maintain (or auto-detected recipe)");
  }

  return {
    subcommand: "start",
    idea,
    flags: {
      maxCost: opts.maxCost,
      maxSprints: opts.maxSprints,
      doneThreshold: opts.doneThreshold,
      stack: opts.stack,
      noCustomerDebate,
      noPriorContext: opts.priorContext === false ? true : undefined,
      forceCouncil: opts.forceCouncil === true ? true : undefined,
      budgetTokens: opts.budgetTokens ? opts.budgetTokens : undefined,
      mode,
      ghPr: opts.ghPr === true ? true : undefined,
    },
    warnings,
  };
}

/**
 * Slash handler. Returns a sentinel string parseable by app.tsx, OR a help/error
 * string when no orchestrator dispatch is appropriate.
 */
export const handleIdealSlash: SlashHandler = async (args) => {
  const result = parseIdealArgs(args);

  if (result.subcommand === "help") {
    const warnings = result.warnings.length ? `\n\n${result.warnings.join("\n")}` : "";
    return `${HELP_TEXT}${warnings}`;
  }

  // Status/resume/abort without a runId are allowed: status lists all runs,
  // resume + abort auto-detect the newest incomplete run (A/B). ship still
  // requires an explicit runId.
  if (
    result.subcommand !== "start" &&
    result.subcommand !== "status" &&
    result.subcommand !== "resume" &&
    result.subcommand !== "abort" &&
    result.subcommand !== "review" &&
    !result.runId
  ) {
    return `error: /ideal ${result.subcommand} requires a runId\n\n${HELP_TEXT}`;
  }

  const payload = {
    subcommand: result.subcommand,
    idea: result.idea,
    runId: result.runId,
    flags: result.flags,
  };
  const warningPrefix = result.warnings.length ? `${result.warnings.join("\n")}\n` : "";
  return `${warningPrefix}__PRODUCT_LOOP__\n${JSON.stringify(payload)}`;
};

/** Returned for --help introspection in tests. */
export function getIdealHelpText(): string {
  return HELP_TEXT;
}

registerSlash("ideal", handleIdealSlash);
