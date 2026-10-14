/**
 * The `tui.start` argv contract — ONE declaration that is both published and
 * enforced.
 *
 * Why this file exists
 * --------------------
 * `tui.start` accepted an `args: string[]` vetted against a regex that lived
 * only in `mcp-server.ts`. Nothing in the information budget of a fresh agent
 * (`tools/list` + `tui.capabilities`) said what that regex was: the tool
 * description said "sanitized argv" — that a rule exists, never what it is —
 * and the capabilities payload had no argv field at all. A graduation-test
 * agent given only "start the TUI" therefore had no path to a valid call except
 * reading this package's source, which is precisely the failure the graduation
 * criterion measures.
 *
 * The specific trap it walked into: `--mock-llm(=.+)?` accepts ONLY the
 * attached form, so the natural spelling — the one the repo's own docs use on a
 * command line — `["--agent-mode", "--mock-llm", "<dir>"]` puts `<dir>` in its
 * own argv element, which matches no form and is rejected. Per-token matching
 * with no positional pairing is not guessable; it has to be stated.
 *
 * Single source of truth
 * ----------------------
 * {@link ARGV_FORMS} carries, per form, the human spelling AND the exact regex
 * fragment. {@link ARGV_ALLOW_RE} is ASSEMBLED from those fragments — the
 * allowlist the server enforces and the contract it publishes are the same
 * array, so a form cannot be advertised without being enforced or vice versa.
 * What assembly alone cannot pin is the prose and the examples, so every
 * `examples` token is required to be ACCEPTED and every {@link ARGV_REJECTED}
 * token to be REJECTED by the assembled regex — asserted in
 * `__tests__/argv-contract.spec.ts`, which goes red the moment the published
 * description and the enforced behaviour disagree.
 *
 * This publishes the boundary. It does not widen it: the assembled source is
 * byte-identical to the literal it replaced, pinned by a frozen-source test.
 */

/** One accepted argv form: how an agent spells it, and how the server matches it. */
export interface ArgvForm {
  /** The spelling an agent should write, with `<...>` placeholders. */
  readonly form: string;
  /** The exact RegExp source fragment this form contributes to the allowlist. */
  readonly pattern: string;
  /** What the form does, and the constraint that is not obvious from the pattern. */
  readonly what: string;
  /** Tokens that MUST be accepted. Verified against the assembled regex. */
  readonly examples: readonly string[];
}

/** A token that MUST be rejected, with the reason an agent needs to fix its call. */
export interface ArgvRejectedExample {
  readonly arg: string;
  readonly why: string;
}

/**
 * Every accepted `tui.start` argv form.
 *
 * Order is the alternation order of the assembled regex; changing it changes
 * only which branch reports a match, never the accepted language.
 */
export const ARGV_FORMS: readonly ArgvForm[] = [
  {
    form: "--agent-<name>  |  --agent-<name>=<value>",
    pattern: "--agent-[a-z-]+(=.*)?",
    what:
      "Agent-mode flags. <name> is lowercase letters and dashes only; the value, when present, is unconstrained. " +
      "`--agent-mode` is appended automatically when absent, so `args: []` is a valid, complete call.",
    examples: ["--agent-mode", "--agent-cols=80", "--agent-rows=24"],
  },
  {
    form: "--mock-llm  |  --mock-llm=<dir>",
    pattern: "--mock-llm(=.+)?",
    what:
      "Fixture directory for the mock LLM. The value MUST be attached with `=`; a directory placed in the NEXT " +
      "args element is a bare token and is rejected. Prefer the separate `mockLlmDir` input, which takes the path " +
      "unattached and is additionally validated against the repo root.",
    examples: ["--mock-llm", "--mock-llm=tests/harness/fixtures/llm"],
  },
  {
    form: "--profile=<id>",
    pattern: "--profile=[a-zA-Z0-9_-]+",
    what: "Settings profile to boot under. `=` form only; <id> is [A-Za-z0-9_-]+ and may not be empty.",
    examples: ["--profile=default", "--profile=e2e_01"],
  },
  {
    form: "--session=<id>",
    pattern: "--session=[a-zA-Z0-9_-]+",
    what:
      "Resume a persisted session in the child. `=` form only; <id> is [A-Za-z0-9_-]+ so it can never carry a path " +
      "or a shell metacharacter. Restart-to-resume is `tui.stop` then `tui.start` with this flag.",
    examples: ["--session=abc123", "--session=my-session_42"],
  },
] as const;

/**
 * Tokens that MUST be rejected, each naming the fix.
 *
 * The first entry is the exact token that failed the graduation run — kept here
 * so the case that motivated this contract is a permanent assertion, not an
 * anecdote.
 */
export const ARGV_REJECTED: readonly ArgvRejectedExample[] = [
  {
    arg: "tests/harness/fixtures/llm",
    why: "A bare value token. args carries flags only — attach it as `--mock-llm=<dir>`, or pass it as the `mockLlmDir` input.",
  },
  { arg: "--profile", why: "`--profile` requires the attached `=<id>` form." },
  { arg: "--session", why: "`--session` requires the attached `=<id>` form." },
  { arg: "--session=../../etc/passwd", why: "Session ids are [A-Za-z0-9_-]+ — a path can never be one." },
  { arg: "-s", why: "Short flags are not in the allowlist; only the long forms listed in `forms` are accepted." },
  { arg: "--require", why: "Not an allowlisted form. Loader/preload flags are excluded deliberately." },
  { arg: "--preload=evil", why: "Not an allowlisted form. Loader/preload flags are excluded deliberately." },
  { arg: "--eval", why: "Not an allowlisted form. Code-evaluation flags are excluded deliberately." },
] as const;

/** Max elements in `args` — the value the tui.start input schema enforces. */
export const ARGV_MAX_ARGS = 20;
/** Max length of one `args` element — the value the tui.start input schema enforces. */
export const ARGV_MAX_ARG_LENGTH = 200;

/**
 * The argv allowlist, assembled from {@link ARGV_FORMS}.
 *
 * Byte-identical to the literal it replaced; `__tests__/argv-contract.spec.ts`
 * pins the source string so an edit that widens the boundary cannot pass as a
 * documentation change.
 */
export const ARGV_ALLOW_RE = new RegExp(`^(${ARGV_FORMS.map((f) => f.pattern).join("|")})$`);

/**
 * The published contract, embedded in `tui.capabilities` as `argv`.
 *
 * Shaped like the `selector` / `predicate` grammars already in that payload:
 * machine-readable forms plus ready-to-send examples, so an agent constructs a
 * valid call from the handshake instead of from this file.
 */
export const ARGV_CONTRACT = {
  appliesTo: "tui.start",
  field: "args",
  /**
   * The rule the failing run could not guess: matching is per-element and
   * whole-token, so a flag's value NEVER rides in the following element.
   */
  matching:
    "Each element of `args` is matched WHOLE against the allowlist. There is no positional pairing: a flag's value never rides in the following element — attach it with `=`.",
  required: true,
  emptyAllowed: true,
  autoAppended: ["--agent-mode"],
  maxArgs: ARGV_MAX_ARGS,
  maxArgLength: ARGV_MAX_ARG_LENGTH,
  forms: ARGV_FORMS,
  rejected: ARGV_REJECTED,
  /** Complete, ready-to-send `tui.start` argument objects. */
  callExamples: [
    { args: [] },
    { args: ["--agent-mode", "--agent-cols=80"] },
    { args: ["--mock-llm=tests/harness/fixtures/llm"] },
    { args: [], mockLlmDir: "tests/harness/fixtures/llm" },
    { args: ["--session=abc123"] },
  ],
  otherInputs: {
    cwd: "Optional. Contained to the user home, the muonroi-cli repo root, or a configured extra root; rejected otherwise with `cwd_rejected` (the containment rule itself is NOT published here).",
    env: "Optional. Merged over the server's own env, then dangerous keys are stripped (the strip list is NOT published here).",
    mockLlmDir:
      "Optional. Mock-LLM fixture directory as a plain path — the unattached alternative to `--mock-llm=<dir>`; must resolve inside the repo root.",
    pushMode: "Optional boolean. Opt in to server→client push when the client advertises the capability.",
  },
  errors: {
    argv_rejected:
      "One `args` element matched no form. The payload names the element, its index, and every accepted form.",
    cwd_rejected: "`cwd` escaped the containment roots.",
    mock_llm_rejected: "`mockLlmDir` resolved outside the repo root.",
    already_started: "A TUI is already attached — call `tui.stop` first.",
    spawn_failed: "The child process could not be spawned.",
  },
} as const;

/**
 * Explain WHY one argv element was rejected, in terms an agent can act on
 * without reading source.
 *
 * `argv_rejected` previously returned only the offending token. The single most
 * common cause — a value written as its own element after `--mock-llm` — is
 * invisible in that token alone, so the message is derived from the token's
 * NEIGHBOUR as well as itself.
 *
 * @param args  the full args array as submitted.
 * @param index position of the rejected element within it.
 */
export function explainRejectedArg(args: readonly string[], index: number): string {
  const bad = args[index] ?? "";
  const prev = index > 0 ? (args[index - 1] ?? "") : "";

  // A value that followed an attached-value flag — the observed failure mode.
  const prevFlag = prev.split("=")[0] ?? "";
  const attachedValueForms = ["--mock-llm", "--profile", "--session"];
  if (!prev.includes("=") && attachedValueForms.includes(prevFlag) && !bad.startsWith("-")) {
    const suffix =
      prevFlag === "--mock-llm" ? " — or drop both from `args` and pass the directory as the `mockLlmDir` input." : ".";
    return `\`${prevFlag}\` takes its value ATTACHED: write \`${prevFlag}=${bad}\` as a single element instead of two${suffix}`;
  }

  if (!bad.startsWith("-")) {
    return "Bare value tokens are never accepted: `args` carries flags only, and each element is matched whole.";
  }

  const flagName = bad.split("=")[0] ?? bad;
  const known = ARGV_FORMS.find((f) => f.form.includes(flagName) && flagName.length > 2);
  if (known) {
    return `\`${flagName}\` is an allowlisted flag but \`${bad}\` does not match its form (${known.form}). ${known.what}`;
  }

  const explicit = ARGV_REJECTED.find((r) => r.arg === bad);
  if (explicit) return explicit.why;

  return "No allowlisted form matches this element. See `allowed` for every accepted form, or `tui.capabilities` → `argv`.";
}
