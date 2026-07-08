# Council debate language (Feature B) — design

Date: 2026-07-08
Status: implemented
Related: `2026-07-08-council-detail-readability-design.md` (Feature A)

## Problem

Council debate detail is hard for the user to focus on partly because the
debate always runs in **English** while the user thinks in another language
(Vietnamese here). The original design forced English for machine-stability
(citation tags, JSON, cross-turn citations) and translated only the final
synthesis back to the user's language.

## Decision

**The language the user chooses IS the debate language — there is no separate
translate-back pass.** The user's insight: making the whole debate run directly
in the chosen language avoids extra LLM translation rounds (cost + latency) that
a translate layer would add.

## Mechanism

The hard-coded English rule (`ENGLISH_ONLY_RULE` in `src/council/prompts.ts`)
becomes a function `buildLanguageRule(lang)` that selects the per-turn language
rule from the resolved setting. A parallel `buildSynthesisLanguageRule(lang)`
governs the synthesis prompt.

Machine-readable tokens stay verbatim English regardless of language, preserving
the original stability guarantee:

- citation tags `[CONFIRMED via …]` / `[REFUTED via …]` / `[UNVERIFIED: …]`
- JSON keys and the `type` field
- code identifiers, tool output
- STACK LOCK technology names

Only prose/analysis text switches language.

### Setting: `councilLanguage`

- `"auto"` (**default**) — debate + conclusion follow the language of the
  user's prompt/brief. Zero-config; a Vietnamese prompt yields a Vietnamese
  debate. This is what best serves "user dễ focus".
- `"english"` — force the historical English-only debate. Returns the prior
  rule strings **byte-for-byte**, so machine-stability and existing prompt tests
  are unaffected.
- any locale label (e.g. `"vietnamese"`, `"日本語"`) — pin the debate prose to
  that language regardless of the prompt's language.

Resolution: `getCouncilLanguage()` (`src/utils/settings.ts`) normalizes via
`normalizeCouncilLanguage()` (lowercases the two reserved modes, preserves
locale labels with original casing, empty/non-string → `"auto"`).

### Where the language is applied

`runDebate` (`src/council/debate.ts`) resolves the language once
(`config.debateLanguage ?? getCouncilLanguage()`) and threads it into every
debate/eval/summary prompt: opening, response, follow-up, leader evaluation,
round summary. `runPlanning` (`src/council/planner.ts`) passes it into the
synthesis prompt. `config.debateLanguage` lets a caller/test override the
setting.

### How the user chooses

`/council lang [value]` (alias `/council language`):
- no value → prints the current language + the value legend.
- with value → normalizes and persists via `saveUserSettings`.

## Safety / regression posture

- The `"english"`/undefined branch returns the exact original rule strings, so
  the default-English path and all prompt-string tests are byte-identical.
- Builders default to English when called without a `language` param, so
  direct-call tests (`decisions-lock`, `clarification-prompt`) are unaffected.
- `auto` default is a deliberate behavior change (debates now run in the user's
  language) approved by the user; the English-stability guardrail is honored by
  keeping tags/JSON/code verbatim English via `NON_ENGLISH_TOKENS_RULE`.

## Tests

- `src/council/__tests__/language-rule.test.ts` — `buildLanguageRule` /
  `buildSynthesisLanguageRule` modes + builder threading; asserts the
  english/undefined branch is byte-identical.
- `src/utils/settings.test.ts` — `normalizeCouncilLanguage` cases.
- `src/ui/slash/__tests__/council-lang.test.ts` — `/council lang` read path.
- `tests/council/council-e2e.test.ts` + `council-edge-cases.test.ts` — settings
  mocks extended with `getCouncilLanguage`.

## Out of scope

- No per-invocation `/council <lang> <topic>` flag — the persistent setting +
  `auto` default covers the common case.
- No translate-back pass for a language different from the debate language (the
  whole point is to avoid that cost).
