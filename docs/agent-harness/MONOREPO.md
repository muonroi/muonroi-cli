# Monorepo Workspace Tooling Decision

**Decision: Use Bun workspaces.** No new package manager is introduced.

---

## Why Bun Workspaces

- **Already on Bun runtime.** The project uses `bun install`, `bunx vitest`, and `bun run` everywhere (see root `package.json` `engines` field: `"bun": ">=1.3.13"`). Adding pnpm would mean a second package manager in CI — double the install-cache strategy, double the lockfile to maintain (`bun.lock` + `pnpm-lock.yaml`), and two `install` steps in every pipeline.

- **npm-compatible protocol.** `"workspaces": ["packages/*"]` is the standard npm workspaces field. Bun reads it natively. All tooling already in the repo — vitest, tsup, ng-packagr, TypeScript project references — works without quirks against this layout.

- **Fast, Windows-native symlinks.** `bun install` resolves workspace packages via symlinks in `node_modules/@muonroi/`. On Windows this works without elevated permissions (Bun uses junctions where needed). No POSIX-only symlink caveats.

- **Acceptable trade-offs.** pnpm's `workspace:*` version-range enforcement is marginally stricter than Bun's. For a small four-package monorepo that will not be published independently until Task 6.6, that extra enforcement is not worth the tooling overhead. The `workspace:*` protocol itself is supported in Bun since 1.x and can be verified at first `bun install` after Phase 1.

---

## What Changes in Root `package.json`

**This task only documents the decision.** The actual edit happens in Phase 1, Task 1.x.

The diff fragment to apply at that time:

```diff
 {
   "name": "muonroi-cli",
   "version": "1.2.3",
+  "workspaces": ["packages/*"],
   ...
 }
```

`name` stays `muonroi-cli` — the root package is the CLI binary, not a library. The `packages/*` glob is lazy: it picks up nothing until Phase 1 creates the first sub-package directory containing its own `package.json`.

---

## Package Naming Convention

All extracted packages use the `@muonroi` npm scope:

| Package | Directory |
|---|---|
| `@muonroi/agent-harness-core` | `packages/agent-harness-core/` |
| `@muonroi/agent-harness-opentui` | `packages/agent-harness-opentui/` |
| `@muonroi/agent-harness-react` | `packages/agent-harness-react/` |
| `@muonroi/agent-harness-angular` | `packages/agent-harness-angular/` |

The `@muonroi` scope is the conventional org prefix used across all muonroi repos. Whether the org owns that npm scope for public publishing is deferred — see Task 6.6. During development all packages are workspace-local and never hit the registry.

---

## Workflow Commands

| Goal | Command |
|---|---|
| Install everything | `bun install` (run at repo root) |
| Run a script in one package | `bun --cwd packages/agent-harness-core run build` |
| Run a script in all packages | `bun run -F '*' build` (filter glob `'*'` matches all workspaces) |
| Add an internal dep | Edit the consumer's `package.json`: `"@muonroi/agent-harness-core": "workspace:*"` |
| Build all | Add a root `build:all` script that calls each package's `build` in sequence |
| Run tests across all packages | `bunx vitest run` at root (vitest auto-discovers workspace configs) |

---

## Caveats

- **`workspace:*` protocol verification.** Bun has supported `workspace:*` since 1.x but the exact behaviour of version resolution (pinned vs latest local) should be confirmed on the first `bun install` after Phase 1 scaffolds the packages. If it behaves unexpectedly, pin to `"*"` as a fallback — vitest and tsup do not care about the exact string.

- **Per-package vitest configs.** The root `vitest.config.ts` (and `vitest.harness.config.ts`) currently discover tests via glob. If packages ship their own `vitest.config.ts` files, the root runner may double-count tests. Resolve by either: (a) adding explicit `include`/`exclude` globs, or (b) using vitest's `--project` flag in Phase 3+ when per-package test isolation becomes relevant.

- **Type resolution during dev vs publish.** During development each consumer package's `tsconfig.json` maps `@muonroi/*` paths to the local source via `paths`. The published artifact instead uses the `exports` field in each package's `package.json` to resolve. Both must be maintained in sync; the `tsconfig` path mapping has no effect on consumers that install from npm.

---

## Alternative Considered

**pnpm** was the only realistic alternative — its workspace protocol is mature and widely adopted in large monorepos. It was rejected because the project is already fully committed to the Bun runtime and the added overhead of a second package manager (separate lockfile, separate CI cache, separate install step) outweighs pnpm's stricter enforcement features for a four-package monorepo.
