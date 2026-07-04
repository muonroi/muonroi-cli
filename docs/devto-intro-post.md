---
title: "muonroi-cli: An AI coding agent where the models argue before they answer"
published: false
description: "A BYOK terminal AI agent that debates high-stakes decisions across multiple models, routes each task to the cheapest capable model, remembers what it learned across sessions, and QA-tests its own TUI like a real user — for about $5/month."
tags: ai, cli, opensource, productivity
cover_image: https://raw.githubusercontent.com/muonroi/muonroi-cli/master/docs/demo.gif
---

Most AI coding tools give you one model, one answer, and hope it's right.

**muonroi-cli** takes a different bet. It's a bring-your-own-key (BYOK) coding agent that lives in your terminal — built on Bun + React 19 + OpenTUI + the AI SDK v6 — and its whole design assumes that *one model, one shot* is the weakest way to use LLMs. Instead it routes each task to the model best suited for it, makes several models **argue with each other** before committing to a high-stakes decision, and remembers what it learned so it doesn't repeat mistakes next session.

Here's what actually makes it different.

## TL;DR

- 🗣️ **Council** — different models from *different vendors* (DeepSeek, Z.ai GLM, Kimi) debate high-stakes questions with a verify-then-refute, cite-your-evidence protocol before you get an answer.
- 🧠 **Experience Engine** — a self-curating brain that recalls prior gotchas *before* acting, warns you at the moment of risk, and gets sharper the more you use it. Shared across Claude/Codex/Gemini over MCP.
- 💸 **~$5/month by design** — role-based routing + auto-compaction + sub-agent token caps + `usage forensics` attack cost from four sides.
- 🤖 **`/ideal`** — an autonomous idea→ship loop (council → plan → implement → verify-gate, iterate on failure) with an always-on audit log.
- 🧩 **Semantic blocks** — the agent QA-tests its *own* terminal UI as a real user, no screenshots/OCR.
- 🔑 **BYOK, keys in your OS keychain** — 7 providers, OAuth, Bitwarden sync, encrypted cross-device export.

---

## 1. Models that debate — the Council

This is the headline feature, and it's not a gimmick. Run `/council <topic>` and muonroi-cli spins up a **structured, adversarial debate between different models from different vendors** before it answers you.

That last part matters. A debate is only worth running if the participants can actually *disagree* — and two instances of the same model tend to violently agree. So the council defaults to **`prefer_multi_provider: true`** and seats participants from distinct providers:

| Debate role | Provider | Model |
|---|---|---|
| implement | DeepSeek | `deepseek-v4-flash` |
| verify | Z.ai | `glm-5.2` |
| research | opencode-go | `kimi-k2.7-code` |

DeepSeek, a GLM model, and Kimi — three different training lineages — argue the same question. When a participant call fails mid-debate, the fallback deliberately retries on a *different provider* (`[research] … failed; retrying via <model> (different provider)`), so provider outages degrade the debate instead of killing it. This is where BYOK multi-provider stops being a checkbox and becomes the whole point: you're not paying for one opinion, you're paying for a panel that doesn't share blind spots.

![How a Council debate flows: a question is planned by the leader, argued across DeepSeek, Z.ai GLM, and Kimi over up to 8 verify-then-refute rounds, synthesized to JSON, and gated by a confidence judge.](https://raw.githubusercontent.com/muonroi/muonroi-cli/master/docs/assets/council-flow.png)

A single question flows through a real pipeline:

- **Clarification** — the leader model asks 3–5 clarifying questions before anyone debates.
- **Debate planning** — the leader assigns *stances* (e.g. "Pragmatist", "Performance Analyst") so participants attack the problem from genuinely different angles instead of nodding along.
- **Research phase** — participants can hit `bash`, `grep`, `read_file`, plus MCP tools (Tavily web search, Playwright) to ground claims in evidence. Findings are split into **Source Code Findings** (`[file:line]`), **Internet Findings** (`[url]`), and live **Frontend Findings**.
- **Rounds** — up to 8 rounds of a **verify-then-refute** pattern. A claim isn't rebutted with vibes; it's rebutted with a citation:

  ```
  [Pragmatist] → [Performance Analyst]:
  REST has zero migration cost and our team knows it.
  [REFUTED via tavily: "Proto tooling has improved significantly in 2024"]

  [Performance Analyst] → [Pragmatist]:
  Benchmarks show 40% lower latency for internal calls.
  [CONFIRMED via bash: hyperfine results]
  ```

- **Convergence detection** — the leader tracks an `evidenceDensity` score (citations ÷ claims). If the debate is running on opinion instead of evidence, it *forces a mid-debate research query*. It stops when disagreement is genuinely resolved, not after a fixed number of turns.
- **Synthesis + a confidence judge** — the outcome is structured JSON, then a separate judge scores it 0–1. Below 0.5 it gets stamped `[NEEDS HUMAN REVIEW]` instead of pretending to be sure.

Every debate is persisted. `/council inspect <session-id>` replays the whole thing — participants, per-round evaluations, tool traces, extracted citations. You can audit *why* the agent recommended what it did.

> The tagline on the repo is literal: *"An AI coding agent where models argue with each other before answering."*

---

## 2. ~$5/month is a design goal, not an accident

Running every token through a premium model is how AI CLIs quietly cost $50–100/month. muonroi-cli treats cost as a first-class engineering constraint and attacks it from four directions at once:

**1. Route by role.** The **Prompt Intelligence Layer (PIL)** classifies each turn (task type, complexity, domain) and maps it to a **role** — `leader`, `implement`, `verify`, or `research` — each pointing at whatever model you configured:

```json
"roleModels": {
  "leader":    "deepseek-v4-pro",    // hard decisions → premium
  "implement": "deepseek-v4-flash",  // grunt work     → cheap + fast
  "verify":    "deepseek-v4-pro",
  "research":  "deepseek-v4-flash"
}
```

The premium model only appears for the parts that need it; the cheap, fast model does the mechanical typing.

**2. Compact after every turn** (see below) so long sessions don't cost more per turn as they grow.

**3. Cap the blast radius.** Sub-agents get hard token budgets, so a runaway delegation can't quietly balloon a single call to hundreds of thousands of input tokens.

**4. Make leaks findable.** When something *does* look expensive, `usage forensics` (section 6) tells you exactly where the tokens went instead of leaving you to guess.

The result is real, measured, not aspirational: on your own keys, everyday use lands around **$5/month**. And it's genuinely multi-provider — DeepSeek, SiliconFlow, OpenAI, xAI, Z.ai and more, each with its own key. Keys live in your **OS keychain**, never plaintext config. Log in via **OAuth** (OpenAI/Google/xAI), sync from **Bitwarden**, or move an encrypted, passphrase-protected bundle between machines with `keys export` / `keys import`.

---

## 3. Auto-compaction — long sessions stay cheap

After *every* turn, context is silently compressed. Instead of your prompt cost creeping up as the conversation grows, it stays roughly flat. You don't manage it; it just happens. (There's a manual `/compact` if you want to force it.)

---

## 4. The Experience Engine — an agent that actually learns

This is the feature I'd point to if you only tried one thing. Most agents are amnesiacs: every session starts from zero, and every mistake is available to be made again tomorrow. muonroi-cli ships an **Experience Engine (EE)** — a persistent, self-curating behavioral brain that turns each session's decisions, gotchas, and corrections into knowledge the agent carries forward.

It's not a chat-history dump. It's a **learning flywheel** with real mechanics:

![The Experience Engine flywheel: recall-first before acting, a warning fires at the moment of risk, the agent acts with evidence, reports a verdict, and the brain reinforces useful hints and prunes noise — getting sharper each loop and feeding an Experience Auditor stance into the Council.](https://raw.githubusercontent.com/muonroi/muonroi-cli/master/docs/assets/ee-flywheel.png)

- **Recall-first, not react-later.** Before working in an unfamiliar area or taking a risky, hard-to-reverse step, the agent *queries the brain first* — "what did we already prove about this?" — so it orients from prior evidence instead of re-deriving it or walking into a known trap. Recall replaces broad blind exploration: read the one file the brain points at, not ten.
- **Passive hints at the moment of risk.** Before every edit/write/command, learned high-confidence warnings fire inline — `⚠️ [Experience — High Confidence]` — right where you'd otherwise repeat a past mistake.
- **Tiered knowledge.** Retrieval spans tiers: durable **principles** → **behavioral** rules learned from this codebase → session **seeds** → self-QA lessons. General wisdom and project-specific scar tissue both surface, scope-filtered to the repo and language you're in.
- **A closed feedback loop that prunes itself.** Every surfaced hint carries an id; after the agent acts, it reports `followed` / `ignored` / `noise`. Useful hints get reinforced, wrong ones get their scope narrowed or deleted. The brain gets *sharper* with use instead of accumulating cruft.
- **It feeds the Council.** When the brain holds a high-confidence warning relevant to a debate, it auto-injects an **"Experience Auditor"** stance — "watch for the operational pitfalls this team has already hit." Your past incidents become a debate participant.
- **Shared across agents.** The same brain is reachable over MCP, so Claude, Codex, and Gemini driving this codebase all draw from — and contribute to — one memory. A lesson one agent learns on Monday is a warning another agent gets on Tuesday.

Memory that *changes the agent's behavior next time* — and gets more accurate the more you use it — is genuinely rare in this category. Here it's a first-class subsystem, not a bolt-on. It's optional and degrades gracefully: if the brain is unreachable, the agent just proceeds without it.

---

## 5. The agent QA-tests its own TUI — semantic blocks + the Agent Harness

This one is unusual enough that it's worth its own section.

muonroi-cli has an **agent harness** that drives its own terminal UI **as a real user would** — via structured JSON, with **no screenshots and no OCR**.

The trick is **semantic blocks**. Every user-visible element is wrapped in a role-fixed primitive — `<Dialog>`, `<TextBox>`, `<ListItem>`, `<Menu>`, … — that emits an invisible semantic node (`id`, `role`, `name`, focus/selected/disabled state) into a live tree. An automated driver can then `query`, `press`, `type`, and `wait_for` against that tree the way a browser test queries the DOM — except it's a terminal UI. The primitives fix the `role` per component so it can't drift or be typo'd, and mirror interactive state (`focused`, `selected`) to the harness automatically — killing the single biggest source of UI/test drift. They're zero-cost: when the agent runtime is unset (normal user mode) they render nothing at all.

That semantic layer is what unlocks everything below:

- **Self-QA** — change a modal, a slash menu, or the focus chain, and the CLI can spin up a child process, drive the real TUI through template scenarios, and judge pass/fail — catching regressions unit tests structurally cannot reach (modal lifecycle, toast levels, focus restoration). Passing scenarios get emitted as permanent regression specs.
- **MCP driver** — the harness is exposed as an MCP server (`tui.start`, `tui.snapshot`, `tui.press`, `tui.query`, …), so an *external* agent (Claude, Cursor, etc.) can drive the TUI programmatically. It works cross-platform: POSIX `fd 3/4` sidechannels on Linux/macOS, named pipes on Windows.

An agent that can test its own UI is an agent that can safely improve its own UI.

---

## 6. Cost-leak forensics — find out where the tokens went

When a prompt costs more than it should, you don't have to guess:

```bash
muonroi-cli usage forensics <session-id-prefix>
```

You get a per-event breakdown with inline anomaly flags tied to specific spend regressions — e.g. "peak single-call input > 80,000 → the sub-agent budget cap didn't engage." Real measured wins from this tooling: one prompt dropped from a **504,737-token** peak to **31,702** — a 16× reduction — after the caps were wired correctly. That number came from the forensics view, not a hunch.

---

## 7. `/ideal` — idea to ship, autonomously

`/ideal` is the Council, the router, and the Experience Engine wired into one autonomous loop — the **Product Ideal Loop**. Give it a goal and it drives the whole build itself:

- **Discovery & context** — it reads the target project, and when the goal is high-stakes it kicks off a **Council debate** to settle the design before writing a line of code.
- **Plan → implement → verify** — it plans the work, implements it with the cheap `implement`-role model, then runs a **verification gate**. A failing gate doesn't get shrugged off: the loop *iterates again* with the failure as context until the work actually passes.
- **It learns as it goes** — the Experience Engine feeds prior gotchas in, and outcomes flow back out, so each loop is a little less naive than the last.

Crucially, "autonomous" never means "unaccountable." A three-level permission model (`safe` confirms everything → `auto-edit` auto-approves file ops → `yolo` runs hands-off) gates the whole thing, and **every privileged action is written to an always-on audit log**. `usage security-audit --since 7d` surfaces every yolo session, dangerous command (secrets redacted), and approval override after the fact. You can let it run and still prove exactly what it did.

---

## Try it

```bash
# npm (Node ≥ 20)
npm install -g muonroi-cli

# or Bun
bun add -g muonroi-cli

muonroi-cli
```

First launch runs a wizard: paste a key, import a bundle, sync Bitwarden, or add keys later with `/providers`. Then the interesting commands:

| Command | What it does |
|---|---|
| `/council` | Multi-model adversarial debate on your question |
| `/ideal` | Product Ideal Loop — autonomous build from idea to ship |
| `/providers` | Manage providers, keys, and the default |
| `/compact` | Compact conversation context |
| `muonroi-cli usage forensics <id>` | Per-event cost breakdown of a session |

Full docs: **[docs.muonroi.com/docs/cli](https://docs.muonroi.com/docs/cli/overview)** · Source: **[github.com/muonroi/muonroi-cli](https://github.com/muonroi/muonroi-cli)** · MIT licensed.

---

*The pitch in one line: route each task to the right model, make the models argue when it matters, remember what you learned, and keep the bill around $5/month. If your AI CLI does none of those, muonroi-cli is worth a look.*
