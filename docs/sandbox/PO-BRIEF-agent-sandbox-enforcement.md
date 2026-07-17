# PO Brief — Agent Bash-Tool Sandbox Enforcement (Increment 1)

> **Role split:** This document is the Product Owner's requirement set. The
> `/ideal` agile team OWNS decomposition: pick the enforcement mechanism,
> split into sprints, right-size increment 1. The PO owns the WHAT, WHY, and
> ACCEPTANCE below — not the HOW.

## Problem (evidence-backed, current state)

The agent's own bash tool runs model-generated commands with **zero OS-level
containment**:

- `src/tools/bash.ts:160-168` (`execute`) and `:264-270` (`startBackground`)
  spawn via `exec`/`spawn` inheriting the **full `process.env`** and the CLI's
  own privileges. No namespaces, seccomp, containers, chroot, or job objects.
- The only pre-exec guard is a **regex denylist** on the command string
  (`src/utils/permission-mode.ts:38-168`) — evadable (`sudo`,
  `echo <b64> | base64 -d | sh`, env-built commands, absolute paths, `../`) and
  bypassable via `MUONROI_ALLOW_CATASTROPHIC=1`.
- Permission modes (safe/auto-edit/yolo) are **advisory prompt-gating only**
  (`toolNeedsApproval`, `tool-engine.ts:2997`); yolo runs everything after just
  logging an audit event.
- The one real sandbox (`shuru`, `src/verify/checkpoint.ts:128-228`) is
  **macOS-only** and confined to the verify subsystem — it never wraps the
  agent bash tool, and it is **absent on Windows** (the primary platform).
- `SandboxMode`/`SandboxSettings` (`src/utils/settings.ts:1465-1477`) and the
  `SandboxSecretConfig` skeleton survive but **nothing enforces them**;
  `setSandboxMode` is a no-op stub (`orchestrator/sandbox.test.ts:47-61`).

**Consequence:** an autonomous `/ideal` loop, a sub-agent, or yolo mode can read
`~/.ssh`, exfiltrate credentials, reach the network, or write outside the
workspace, with only regex + (in yolo) nothing stopping it.

## Goal (Increment 1)

Deliver a **real, evasion-resistant enforcement boundary** for the agent bash
tool that genuinely contains the command on **Windows 10 (primary) + POSIX** —
not merely inspects or prompts. Reuse the dormant `SandboxSettings` skeleton.
Land a mergeable first slice; defer advanced OS-primitive hardening
(custom seccomp-BPF policies, full per-command VM, AppContainer capability
tuning) to later increments if the council deems them necessary.

## Requirements

- **R1 — Real enforcement at the bash choke-point.** Wrap `execute` +
  `startBackground` in `src/tools/bash.ts` (the `bash.ts:475-484` "Layer 2"
  stub is the intended point). Enforcement MUST live at the OS/process boundary,
  not the command-string layer.
- **R2 — Default-deny filesystem WRITE** outside an allowlist (cwd + configured
  roots + a temp dir). Reads may be broader but configurable. Driven by
  `SandboxSettings`.
- **R3 — Default-deny network**, per-host allowlist actually enforced
  (`allowNet` / `allowedHosts`). `SandboxSecretConfig` host-scoping honored
  (a secret is only injectable for its declared hosts).
- **R4 — Windows-first.** MUST provide real containment on Windows 10 plus
  POSIX. If a platform cannot enforce, degradation MUST be **explicit and
  visible** (a surfaced warning + audit event) — NEVER a silent fall-through to
  "off".
- **R5 — Resource caps** (cpus/memory) enforced where the chosen mechanism
  allows; a clean no-op with rationale where it does not.
- **R6 — Reactivate `SandboxMode` end-to-end**: settings persistence, TUI
  toggle, delegation propagation, verify path. Remove or make-real the no-op
  stubs (`bash.ts:31-64`, `orchestrator/sandbox.test.ts`).
- **R7 — Full audit.** Every sandboxed exec AND every deny emits a real
  decision-log kind (e.g. `sandbox-exec` / `sandbox-deny`, not the `[shuru]`
  display placeholder), surfaced in `usage security-audit`.
- **R8 — Permission modes compose ON TOP of enforcement.** yolo relaxes
  *prompts*, it MUST NOT relax the OS boundary. A yolo command is still
  contained.

## Acceptance (the bar — regex-theater is a FAIL)

An automated evasion test suite MUST show each of the following is **CONTAINED
at the enforcement layer** (blocked or sandboxed so the effect cannot escape) —
merely printing an approval prompt is a FAIL:

1. Write to an absolute path outside the allowed roots (e.g. the user home
   config dir) — denied.
2. `../` traversal write escaping cwd — denied.
3. Obfuscated privilege/exfil command (env-built or base64-decoded) that the
   regex denylist misses — contained (cannot read `~/.ssh` / cannot exfil).
4. Network fetch to a host NOT on the allowlist — blocked; a host ON the
   allowlist — permitted.
5. The same command under **yolo** mode — still contained (R8).
6. On a platform where enforcement is unavailable — an explicit visible
   degrade warning + audit event fire (R4), never silent.

Plus: `bunx tsc --noEmit` clean, full `bunx vitest run` green, and the harness
self-verify passes on any touched UI/harness surface.

## Global Constraints (bind every task)

- **Zero-hardcode:** no literal model/provider IDs (catalog/settings/runtime
  only). Sandbox roots/hosts come from `SandboxSettings`, not literals.
- **No silent catch:** every catch logs module + operation + `err.message`
  (HTTP/child-process errors log status/exit-code + context).
- **Core/UI separation:** enforcement core must not import `src/ui` or opentui.
- **Evidence-first:** the evasion suite is the proof; a claim that a boundary
  holds MUST be backed by a passing containment test, not by code reading.
- **Commit hygiene:** conventional-commit subject ≤72 chars; body ≤100
  chars/line.

## Non-Goals (Increment 1)

- Full per-command VM/container for EVERY bash call (perf-prohibitive).
- Custom seccomp-BPF / Landlock rule authoring beyond a default-deny profile.
- Sandboxing the TUI process itself (only the bash tool's child commands).
- Replacing the macOS `shuru` verify path (keep it; the council may unify later).
