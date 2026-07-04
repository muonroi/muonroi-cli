# Quickstart

Welcome! This guide takes you from nothing to your first working prompt in about five minutes.

**muonroi-cli** is a BYOK (bring-your-own-key) AI coding agent that lives in your terminal. It routes each task to the model best suited for it, can run adversarial multi-model "council" debates for high-stakes decisions, and automatically compacts context after every turn so long sessions stay cheap. You plug in your own provider API keys — the CLI orchestrates the rest.

---

## 1. Install

The easiest path is a global install (requires Node.js >= 20, or Bun):

```bash
# npm
npm install -g muonroi-cli

# or Bun
bun add -g muonroi-cli
```

That gives you two equivalent commands on your PATH: `muonroi-cli` and the short alias `mu`.

Running from a source checkout instead? Use `bun run dev` (see `AGENTS.md` for the developer workflow).

## 2. Start it up

```bash
muonroi-cli
```

On first launch a setup wizard walks you through adding provider credentials. You can paste an API key directly, import an encrypted key bundle, sync from Bitwarden, or skip and add keys later with `/providers` inside the TUI.

Not sure everything is wired up? Run the built-in health check any time:

```bash
muonroi-cli doctor
```

## 3. Set an API key

Keys are stored in your OS keychain — never in plaintext config files. The `keys` subcommand manages them:

```bash
# Prompt for a key and store it securely
muonroi-cli keys set deepseek

# See what's stored (values are masked)
muonroi-cli keys list

# Remove one
muonroi-cli keys delete deepseek
```

A few useful extras:

- **OAuth login instead of a raw key** (supported: openai, google/agy, xai):
  `muonroi-cli keys login openai` (and `keys logout <provider>` to revoke)
- **Move keys between machines** with an encrypted, passphrase-protected bundle:
  `muonroi-cli keys export ~/muonroi-keys.json` on the old machine, then
  `muonroi-cli keys import ~/muonroi-keys.json` on the new one.

You can also pass a key ad-hoc for a single run with `-k <key>` — handy for CI or quick tests.

## 4. Your first prompt

Interactive — just launch the TUI and type. You can even pass an opening message straight from the shell:

```bash
muonroi-cli "explain what src/router does in this repo"
```

Headless — perfect for scripts and CI. `-p` runs a single prompt and exits:

```bash
muonroi-cli -p "Reply with exactly: PONG"
```

Add `--format json` if you want machine-readable output instead of plain text.

## 5. Pick a model and provider

See every model the CLI knows about — with context window, pricing, and capability tags:

```bash
muonroi-cli models
```

Then pick one for a run with `-m`:

```bash
muonroi-cli -m deepseek-v4-flash -p "summarize the diff I just described"
```

Inside the TUI, `/providers` is the home for everything provider-related: enable/disable providers, set the default, and manage keys. Under the hood, role-based routing maps task types (leader / implement / verify / research) to the models you configure in `~/.muonroi-cli/user-settings.json` — so different parts of a task can use different models automatically.

## 6. Example invocations

Five real commands worth knowing early:

```bash
# 1. One-shot headless prompt with JSON output (great for scripting)
muonroi-cli -p "List three risks in this repo's release process" --format json

# 2. Resume where you left off — 'latest' reopens your most recent session
muonroi-cli -s latest

# 3. Run against a different directory without cd'ing there
muonroi-cli -d ../other-project -p "what test framework does this project use?"

# 4. Loosen the permission gate for a hands-off refactor session
#    (safe = confirm everything, auto-edit = auto-approve file ops, yolo = approve all)
muonroi-cli --permission auto-edit "rename the FooService class to BarService"

# 5. Find out where your tokens went — spend report grouped by model
muonroi-cli usage report --by model
```

Bonus for the curious: `muonroi-cli usage forensics <session-id-prefix>` gives a per-event cost breakdown of a single session when something looked expensive.

## 7. Inside the TUI

Once you're in the interactive UI, slash commands drive the experience. The primary surface:

| Command | What it does |
|---|---|
| `/providers` | Manage providers and API keys, set the default |
| `/council` | Multi-model adversarial debate on your question |
| `/ideal` | Product Ideal Loop — autonomous build from idea to ship |
| `/compact` | Compact conversation context |
| `/clear` | Clear the conversation and start fresh |
| `/help` | List all available commands |
| `/exit` | Quit |

## 8. Staying up to date

The CLI checks for new versions once a day and prompts you. To update manually:

```bash
muonroi-cli update
```

---

**Where to next?** Full documentation lives at [docs.muonroi.com/docs/cli](https://docs.muonroi.com/docs/cli/overview) — including deep dives on the council debate system, the Prompt Intelligence Layer, and the Experience Engine.
