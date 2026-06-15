/**
 * harness-env-isolation.ts — per-file env snapshot/restore for the E2E harness.
 *
 * The harness suite runs with `fileParallelism: false` (vitest.harness.config.ts),
 * i.e. ONE shared worker process for all spec files. Several specs
 * (cost-leak-b3/b4-tui, bash-output-get-tui, scope-adherence-tui) mutate
 * compaction/dedup knobs on `process.env` in their own `beforeAll` to exercise a
 * specific code path. Without restoration those mutations LEAK forward into every
 * later spec's child env, because `spawnHarness` merges `...process.env` into the
 * spawned TUI's environment. The result is order-dependent prompt-compaction
 * behaviour and assertions that pass or fail depending on which spec ran first.
 *
 * This setup file registers a root-level snapshot/restore. The root `beforeAll`
 * runs BEFORE any describe-level `beforeAll` (so it captures the pristine,
 * pre-mutation value), and the root `afterAll` runs AFTER any describe-level
 * `afterAll` (so it restores once the file is fully done). By induction every
 * file starts from — and is restored to — the same baseline, so a spec's
 * mutation can never bleed into the next file. A genuinely pre-existing value
 * (e.g. exported in the shell) is preserved rather than deleted.
 */
import { afterAll, beforeAll } from "vitest";

const HARNESS_SCOPED_ENV_KEYS = [
  "MUONROI_TOP_LEVEL_COMPACT_THRESHOLD_CHARS",
  "MUONROI_TOP_LEVEL_COMPACT_KEEP_LAST",
  "MUONROI_SUBAGENT_COMPACT_THRESHOLD_CHARS",
  "MUONROI_SUBAGENT_COMPACT_KEEP_LAST",
  "MUONROI_CROSS_TURN_DEDUP",
] as const;

const snapshot: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of HARNESS_SCOPED_ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
});

afterAll(() => {
  for (const key of HARNESS_SCOPED_ENV_KEYS) {
    const prev = snapshot[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
});
