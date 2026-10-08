<p align="center">
  <h1 align="center">muonroi-cli</h1>
  <p align="center">
    <em>An AI coding agent where models argue with each other before answering.</em>
  </p>
  <p align="center">
    <a href="https://github.com/muonroi/muonroi-cli/actions/workflows/ci-matrix.yml"><img alt="CI" src="https://github.com/muonroi/muonroi-cli/actions/workflows/ci-matrix.yml/badge.svg"></a>
    <a href="https://www.npmjs.com/package/muonroi-cli"><img alt="npm" src="https://img.shields.io/npm/v/muonroi-cli.svg"></a>
    <img alt="Providers" src="https://img.shields.io/badge/providers-8%20supported-blue">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-yellow">
    <img alt="Runtime" src="https://img.shields.io/badge/runtime-Bun%201.3%2B-orange">
  </p>
</p>

---

> Routes each task to the optimal model, runs adversarial multi-model debates for high-stakes decisions, and persists behavioral memory across sessions. Bring your own API keys. Total cost: ~$5/month.

<p align="center">
  <img src="https://raw.githubusercontent.com/muonroi/muonroi-cli/master/docs/demo.gif" alt="Council debate — REST vs gRPC decision" width="840" />
</p>

## Quick Start

### Install

**Recommended — install globally via NPM (requires Node.js ≥ 20) or Bun (requires Bun ≥ 1.x):**

Using NPM:
```bash
npm install -g muonroi-cli
```

Using Bun:
```bash
bun add -g muonroi-cli
```

Once installed, run:
```bash
muonroi-cli
```

**Alternative — Prebuilt standalone binary (requires access to the GitHub repository):**

Linux / macOS:
```bash
# Note: Requires github authorization if the repository is private
curl -fsSL https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.sh | bash
```

Windows PowerShell:
```powershell
# Note: Requires github authorization if the repository is private
irm https://raw.githubusercontent.com/muonroi/muonroi-cli/master/install.ps1 | iex
```

The installers download a `bun --compile` binary from GitHub Releases — single executable, all native deps bundled, no Node/Bun/build tools required.

### First run

A fresh launch opens the chat composer. Open `/providers` to set up a provider;
sending a message without credentials also opens this picker and preserves your
prompt. Select a provider and press **Enter** to sign in or configure its key.
For Anthropic, setup asks for the API key, its workspace scope, and the workspace
ID when needed. Completing setup through Enter selects that provider immediately.
**K** adds or updates credentials without changing the active provider.

You can also configure credentials using `keys set`, import an encrypted bundle
with `keys import`, or add them later through `/providers`.

After setup, role routing auto-balances across enabled providers:

```json
// ~/.muonroi-cli/user-settings.json (example settings — edit if needed)
{
  "defaultProvider": "deepseek",
  "providers": {
    "deepseek":    { "enabled": true },
    "stepfun":     { "enabled": true }
  },
  "roleModels": {
    "leader":    "deepseek-v4-pro",
    "implement": "deepseek-v4-flash",
    "verify":    "deepseek-v4-pro",
    "research":  "deepseek-v4-flash"
  }
}
```

### Supported providers

| Provider | Settings ID | Authentication |
|---|---|---|
| Anthropic | `anthropic` | API key |
| OpenAI | `openai` | API key or ChatGPT OAuth |
| DeepSeek | `deepseek` | API key |
| xAI (Grok) | `xai` | API key or xAI OAuth |
| Ollama | `ollama` | Local endpoint; no API key required |
| Z.ai | `zai` | API key |
| OpenCode Go | `opencode-go` | API key |
| StepFun | `stepfun` | API key |

Use `/providers` in the TUI to configure credentials and select an available model. Provider and model availability follows the built-in catalog and your configured credentials.

On an OAuth-capable provider, **Enter** signs in if needed and then selects that
provider's model. **O** signs in while keeping the current model. The CLI confirms
successful sign-in with a message; browser authorization alone does not change
the active provider.

To set up Anthropic, open `/providers`, select Anthropic, and press **K**.
The CLI asks for your API key, then whether it was created for a specific
workspace. For a key that is **not workspace-scoped** (or if you are unsure),
it also asks for the **workspace ID** from Claude Console **Settings > Workspaces**
(the ID starts with `wrkspc_`). Empty or malformed workspace IDs cannot be saved.
Choose the workspace-scoped option only for a key created for a specific workspace.

The same prompts are available through `muonroi-cli keys set anthropic` and
**K** in the terminal config's Providers screen. Credentials are saved only
when all requested fields are complete; Escape in the TUI or Ctrl+C in the
terminal cancels setup. The TUI rebuilds the provider connection immediately,
so you can press **Enter** to use Anthropic without restarting.

The key is stored in the environment store; the workspace ID is stored under
`providers.anthropic.workspaceId` in `~/.muonroi-cli/user-settings.json`.
Requests include `anthropic-workspace-id` for the selected workspace, including
main and helper calls. Selecting a workspace-scoped key clears any previously
saved workspace ID. See [Anthropic authentication](https://platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace).

### Moving keys between devices

```bash
# Source device — encrypts every stored key into one passphrase-protected file
muonroi-cli keys export ~/muonroi-keys.json

# Move the file via any channel (USB, Drive, AirDrop, email...)

# Target device — same passphrase rehydrates the OS keychain
muonroi-cli keys import ~/muonroi-keys.json
```

Inside the TUI press `/providers` then `B` to sync directly from a Bitwarden vault instead.

### Updates

The CLI checks npm once per day on startup and prompts when a newer version is available. Set `autoUpdate: true` in `user-settings.json` to skip the prompt and update silently. Manual: `muonroi-cli update`.

## Documentation

Full documentation at **[docs.muonroi.com/docs/cli](https://docs.muonroi.com/docs/cli/overview)**

| Topic | Link |
|---|---|
| Overview & architecture | [CLI Overview](https://docs.muonroi.com/docs/cli/overview) |
| Multi-Model Council | [Council Debate Guide](https://docs.muonroi.com/docs/cli/guides/council-debate) |
| Prompt Intelligence Layer | [PIL Pipeline Guide](https://docs.muonroi.com/docs/cli/guides/pil-pipeline) |
| Experience Engine | [Experience Engine Guide](https://docs.muonroi.com/docs/cli/guides/experience-engine) |
| Agent Harness | [Agent Harness Guide](https://docs.muonroi.com/docs/cli/guides/agent-harness) |
| Settings reference | [CLI Settings Reference](https://docs.muonroi.com/docs/cli/reference/cli-settings-reference) |
| Commands reference | [Commands Reference](https://docs.muonroi.com/docs/cli/reference/commands-reference) |
| Providers reference | [Providers Reference](https://docs.muonroi.com/docs/cli/reference/providers-reference) |

## Development

```bash
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli && bun install

bun run dev           # run from source
bun run typecheck     # type check
bun run test          # vitest
bun run lint          # biome check
bun run build:binary  # standalone binary
```

## License

MIT
