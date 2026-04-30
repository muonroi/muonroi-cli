# muonroi-cli Status

**Current Version:** v0.1.0-beta
**Stage:** Private Beta
**Last Updated:** 2026-04-30

## Current State

muonroi-cli is in **private beta**. The CLI is functional for daily use with the following capabilities:

- Multi-provider support (Anthropic, OpenAI, Gemini, DeepSeek, Ollama) with BYOK
- 3-tier brain router (local classifier, warm EE/Ollama, cold SiliconFlow)
- Hard usage cap with auto-downgrade (Opus -> Sonnet -> Haiku -> halt)
- Experience Engine integration with PreToolUse/PostToolUse hooks
- `.muonroi-flow/` artifact system with GSD slash commands
- Session continuity with kill-restart recovery
- Three permission modes: safe, auto-edit, yolo

## Known Issues

| Issue | Severity | Workaround | Status |
|-------|----------|------------|--------|
| Standalone binary does not support OS keychain (keytar) | Low | Use `ANTHROPIC_API_KEY` env var | By design for v1 beta |
| LSP smoke test requires `typescript-language-server` in PATH | Low | Install via `bun add -D typescript-language-server` | Documented |
| Qdrant health check in `doctor` reports warn when Qdrant not running | Info | Expected — Qdrant is optional for local v1 use | By design |
| `install.sh` requires manual repo path update for self-hosted forks | Low | Edit APP/REPO vars in install.sh | Will fix in v1.0 |

## Beta Enrollment

### Prerequisites

- **Bun** >= 1.3.13 (`bun --version`)
- **OS:** Windows 10+, macOS, or Linux
- **API Key:** At least one provider API key (Anthropic recommended)

### Installation

**From npm (recommended):**
```bash
npm install -g muonroi-cli
```

**From source:**
```bash
git clone https://github.com/muonroi/muonroi-cli.git
cd muonroi-cli
bun install
bun run dev
```

**Standalone binary:**
Download from [GitHub Releases](https://github.com/muonroi/muonroi-cli/releases). Set `ANTHROPIC_API_KEY` env var (keychain not available in standalone binary).

### First Run

```bash
muonroi-cli                    # Interactive TUI
muonroi-cli doctor             # Check environment health
muonroi-cli --prompt "hello"   # Headless mode
```

### Reporting Issues

1. Run `muonroi-cli doctor` and copy the output
2. Run `muonroi-cli bug-report > report.json` for anonymized diagnostics
3. Open a GitHub issue using the bug report template
4. **Never share API keys** — `bug-report` auto-redacts, but double-check any additional logs

## Rollout Plan

| Phase | Target | Status |
|-------|--------|--------|
| Phase 0: Fork & Skeleton | Dev environment boots | Complete |
| Phase 1: Brain & Cap Chain | Multi-provider + routing + cap | Complete |
| Phase 2: Continuity & Slash Commands | Flow artifacts + session resume | Complete |
| Phase 3: Polish & Beta | CI matrix + binaries + operator tools | In Progress |
| Phase 4: Cloud & Billing | Multi-tenant + Stripe + dashboard | Planned |

## Support

- **Issues:** [GitHub Issues](https://github.com/muonroi/muonroi-cli/issues)
- **Self-diagnosis:** `muonroi-cli doctor`
- **Bug reports:** `muonroi-cli bug-report`
