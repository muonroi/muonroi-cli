/**
 * src/council/research-mode.ts
 *
 * ONE declaration of (a) how the council decides between internet-first and
 * codebase-first research, and (b) the source-preference prompt block both
 * research paths render.
 *
 * ## Why this module exists
 *
 * Measured across four `/ideal` runs on a 1,557-file C# repo: the council's
 * research role made 0 `web_search` calls and 0 context7 calls, while an
 * *implementation* sub-agent's single `web_search`
 * ("Microsoft.CodeAnalysis.CSharp.Testing NuGet package Roslyn analyzer testing
 * standalone") returned 2,439 useful characters. The same run then emitted a
 * test project referencing NuGet package `Microsoft.CodeAnalysis.Testing`
 * `Version="1.1.1"` — a package id that does not exist (`dotnet restore` fails
 * `NU1101`; the real id is `Microsoft.CodeAnalysis.CSharp.Analyzer.Testing`).
 * A confident hallucination about a third-party contract, which is exactly the
 * class of fact that lives in documentation rather than in the customer's repo.
 *
 * It was never a capability gap. `web_search` / `fetch_url` are unconditional
 * builtins (`src/tools/registry.ts:226`), and the in-process research path
 * loads the full MCP set (`src/council/llm.ts:1112`). Two prompt decisions
 * steered the model away:
 *
 *  1. The repo-first branch named NO external tool at all, so the model had to
 *     recall unprompted, from a list of dozens, that web/library-docs tools
 *     existed. Both research prompt builders had this asymmetry — the
 *     internet-first branch named `tavily`/`web-fetch`/`context7`, the
 *     codebase-first branch named only `grep`/`file read`/`repo-deep-map`.
 *  2. "Use the internet only to fill gaps" is advice with no trigger. Nothing
 *     tells the model WHEN a gap exists, so it relies on noticing that it is
 *     guessing — which is precisely what a confabulation does not do.
 *
 * {@link buildResearchSourcePreference} fixes both for BOTH branches: it names
 * the tools in the repo-first branch too, and replaces "genuine gap" with a
 * checkable trigger — a claim you cannot cite as a `file:line` in this repo.
 */

/**
 * Shared by both modes: WHEN to leave the repo, and WHICH tool to leave it with.
 *
 * The trigger is deliberately syntactic ("cannot cite as a file:line in THIS
 * repo") rather than epistemic ("you have a gap") — a model can evaluate the
 * former against what it has actually read; it demonstrably cannot evaluate the
 * latter against what it merely believes.
 */
const EXTERNAL_SOURCE_RULE =
  `### External sources — when to reach for them\n` +
  `Reach for an external source, instead of answering from memory, the moment a claim is about a third-party API, ` +
  `framework, SDK, package name or package version — that is, anything you cannot cite as a \`file:line\` in THIS repo. ` +
  `Those facts live in documentation, not in this repo, and guessing them produces a confident, wrong answer ` +
  `(a fabricated package id carrying an invented version number is exactly this failure).\n` +
  `- The question names a library, framework, SDK or package → prefer the library-documentation MCP tool ` +
  `(context7, exposed as \`mcp_context7__*\`) over generic search; it is version-accurate where search is not. ` +
  `If context7 is not in your tool list, use \`web_search\` and say so.\n` +
  `- Anything else → \`web_search\` for an open-ended lookup, \`fetch_url\` for a known documentation URL. ` +
  `Both are always available to you.\n` +
  `Never assert a package id, version, API signature or config key that you have neither read in this repo nor ` +
  `confirmed from a source you cite.\n`;

/**
 * The source-preference block rendered into BOTH research prompts — the
 * in-process `llm.research` system prompt (`buildResearchSystemPrompt`) and the
 * isolated explore sub-agent's user prompt (`runResearchIsolated`). Declared
 * once so the two cannot drift apart again.
 */
export function buildResearchSourcePreference(internetFirst: boolean): string {
  const modeBlock = internetFirst
    ? `## Research Mode: INTERNET-FIRST\n` +
      `The workspace has little or no existing source code, so there is nothing local to ground in. ` +
      `Lead with documentation and search. Do NOT spend cycles grep-ing an empty repo.\n`
    : `## Research Mode: CODEBASE-FIRST\n` +
      `The workspace contains source code. Ground every claim about THIS system in it first ` +
      `(grep, read_file, repo-deep-map) and cite a concrete file:line.\n`;
  return `${modeBlock}${EXTERNAL_SOURCE_RULE}`;
}

/** Inputs to {@link decideInternetFirst}. */
export interface ResearchModeInputs {
  /**
   * A working OPEN-ENDED web capability exists for this call: a reachable
   * native-web model, or a configured Tavily key. Builtin `fetch_url` alone
   * does not count — it needs a URL you already have.
   */
  webCapable: boolean;
  /**
   * HINT, not the determinant: the workspace has no source to ground in.
   * Answers "is there anything local to prefer?", which is a real and cheaply
   * measured ordering signal — but on its own it is not an answer to "can we
   * research the web at all?".
   */
  repoIsEmpty: boolean;
}

/**
 * The ONE rule both research paths follow.
 *
 * Before this existed the two paths asked different questions about the same
 * decision: `index.ts` asked "is the repo empty?" (`projectInfo.isEmpty`) and
 * `clarifier.ts` asked "do we have a web tier?" (`webTier !== "none"`).
 *
 * Why the conjunction rather than either one alone:
 *
 * - `repoIsEmpty` alone (the old council rule) can declare internet-first while
 *   no web capability exists. That is self-contradictory in the rendered
 *   prompt: `buildResearchSourcePreference(true)` says "lead with documentation
 *   and search" while `research()` simultaneously appends
 *   "## Research Gap — no working web-search capability" (`llm.ts:1136-1141`).
 *   Gating on `webCapable` removes that contradiction outright.
 * - `webCapable` alone (the old clarifier rule) declares internet-first inside a
 *   1,557-file repo and tells the research role not to grep — false, and the
 *   opposite over-correction. The measured defect was never "wrong mode chosen";
 *   it was "the repo-first mode named no external tool", which
 *   {@link buildResearchSourcePreference} closes directly in BOTH modes.
 *
 * So `isEmpty` survives as one input rather than as the determinant, and the
 * resolved value is computed at each research call site — where the accurate,
 * blocklist-aware web tier is already known (`pickResearchWebModel` in
 * debate.ts, the `webTier` ladder in clarifier.ts) — instead of being guessed
 * upstream in `runCouncilV2`.
 */
export function decideInternetFirst({ webCapable, repoIsEmpty }: ResearchModeInputs): boolean {
  return webCapable && repoIsEmpty;
}
