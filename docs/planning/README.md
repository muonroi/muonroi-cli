# `.planning/` — what is tracked, what is not, and why

`.gitignore` has listed `.planning/` since commit `9863968a`, but gitignore never
applies to already-tracked paths, so 29 files under `.planning/` stayed tracked.
Two of them are rewritten by the runtime, which meant every `/ideal` run dirtied
the branch point and every worktree-based sprint would collide with the others at
merge (`docs/agent-first/SELF-IMPROVEMENT-PLAN.md` §3.1, §10 row 8).

This records the split. **Runtime-written files are untracked; authored files stay
tracked.**

## Untracked (runtime state)

| Path | Written by | Recreated when absent by |
|---|---|---|
| `.planning/STATE.md` | every turn — `syncWorkflowContext` → `setStateField` (`src/gsd/workflow-engine.ts:32`, `src/gsd/native-state.ts:40`) | `ensurePlanningWorkspace` (`src/gsd/config-bridge.ts:100-103`), from `DEFAULT_STATE_MD` |
| `.planning/ROADMAP.md` | `nativeRoadmapAddPhase` (`src/gsd/native-roadmap.ts:219`), `syncPhase` (`:335`) | `ensureTaskRoadmap` (`src/gsd/phase-sync.ts:75-88`) |

Both **self-heal**: the runtime creates them on first use, so untracking them is
safe by construction rather than by convention.

Evidence they were state, not content:

- `STATE.md` appears in **117 of the last 200 commits**. Commit `2a7217c6`
  ("chore(planning): update workflow depth") changes exactly one line —
  `| Depth | heavy |` → `| Depth | standard |` — a value written by
  `syncWorkflowContext`, committed by hand.
- `ROADMAP.md` appears in **88 of the last 200 commits**, and its tracked content
  was no longer this repo's roadmap at all: commit `b4575887`
  ("chore(planning): sync workspace state from the sandbox /ideal run")
  overwrote it with the four phases of a throwaway sandbox run, down to a
  truncated Vietnamese prompt as the title.

`STATE.md` was genuinely mixed — machine rows plus hand-written project history.
That history is preserved verbatim in `STATE-archive-2026-09.md`. `ROADMAP.md`'s
content was replaced by run residue, so nothing authored was lost; the last
hand-written roadmap remains reachable in git history at `d5b2d7ca`.

## Still tracked (authored content)

| Path | Why it stays |
|---|---|
| `.planning/config.json` | **Not** runtime-written: `ensurePlanningWorkspace` writes it only when absent, and nothing else writes it. Its hand-tuned `workflow.*` keys drive hook activation via `resolveConfigKey` (`src/gsd/loop-resolver.ts:60`). 7/200 commits. |
| `.planning/REQUIREMENTS.md` | No runtime writer. |
| `.planning/RETROSPECTIVE.md` | No runtime writer. 1/200 commits. |
| `.planning/phases/**` (24 files) | No runtime writer for existing files; only *new* phase directories are appended, and those land untracked + ignored. |

Keeping `phases/**` tracked also preserves runtime behaviour: `planningRoot()`
(`src/gsd/paths.ts:22-36`) returns `.planning/` **only when the directory
exists**, and otherwise falls back to `.muonroi-flow/planning/`. Because the
phase docs keep `.planning/` present in every checkout and every worktree, GSD
keeps resolving to the same location it always has. Untracking the whole
directory would have silently moved the planning root.

## Consequence for a fresh worktree

A sprint worktree starts with **no** `STATE.md`, so `ensurePlanningWorkspace`
writes `DEFAULT_STATE_MD` (`config-bridge.ts:62-90`) whose extension table reads
`| Depth | standard |` and `| Phase | discuss |`. That is a known, identical
starting state for every sprint — which is option (a) of
`SELF-IMPROVEMENT-PLAN.md` §3.4 ("reset `STATE.md` to a known depth at worktree
creation"), obtained without a bootstrap step anyone can forget.
