---
name: readme-redesign-2026-05-13
description: README redesign spec for muonroi-cli — research-paper tone, Approach B (hook + depth), targeting OpenAI/Anthropic reviewers
metadata:
  type: project
---

# README Redesign Spec — muonroi-cli

**Goal:** Redesign README for submission to top AI organizations (OpenAI, Anthropic). Audience: researchers and engineering leads who scan fast but read deep when hooked.

## Tone
Research paper style — accessible like a technical blog post (Andrej Karpathy register). Problem → Insight → Contribution → Architecture → Quick Start.

## Structure

1. Header: tagline `"An AI coding agent where models argue with each other before answering."`
2. Badges (CI, npm, providers, license)
3. Abstract block: 3 contributions in one paragraph
4. Demo GIF (`docs/demo.gif` generated from `docs/demo.tape`)
5. The Problem section (table: 3 structural limitations)
6. §1 Multi-Model Council — most novel contribution, leads
7. §2 Prompt Intelligence Layer — routing + cost story
8. §3 Experience Engine — persistent learning
9. Architecture pipeline (existing ASCII diagram, cleaned)
10. Quick Start (minimal — 3 commands)
11. Supported Providers table
12. Configuration (roleModels example only)
13. Development
14. License

## Curated Features (show these only)
- Council adversarial debate
- PIL routing + role models
- Experience Engine

## Cut from original
- All CLI flags table
- All slash commands table
- Shuru sandbox detail (mention only)
- Sub-agents detail
- Sessions detail
- MCP servers detail

## Demo GIF
- File: `docs/demo.tape` (VHS script)
- File: `docs/demo.sh` (mock terminal output with ANSI colors)
- Shows: council phases → debate rounds → convergence → synthesis
- Width: 140 chars, Dracula theme, ~45s runtime

**Why:** OpenAI/Anthropic reviewers spend 10–30s on a README. The GIF must show the most novel feature (council debate) in that window.
