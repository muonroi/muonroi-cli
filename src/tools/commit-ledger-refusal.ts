/**
 * src/tools/commit-ledger-refusal.ts
 *
 * The message `git_commit` returns when its write ledger is empty.
 *
 * Measured (run muc2joffe506 / session 2a116648b48e): the old string —
 * "Nothing to commit — you have not created or edited any file via
 * write_file/edit_file this session." — was returned at 06:13:58 and again at
 * 06:53:00 while THREE commits landed in that repo over the same span (4d73157,
 * 1ca6267, a301b06), every one of them through `bash git commit`. The sentence
 * was true about the tool's own ledger and read as a claim about the repository,
 * and it named no alternative, so the agent stopped trying: 1 edit_file followed
 * by 163 bash calls.
 *
 * The BEHAVIOUR is deliberately unchanged — staging only tool-written paths is
 * what keeps `.env` and `.muonroi-cli` out of the index. This module changes only
 * what the refusal SAYS: it names the ledger as a scope limit, reports the
 * repository's actual state, and names the route that works.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";

const pexecFile = promisify(execFile);

/**
 * Count of uncommitted changes in `cwd`, or null when git could not be read.
 *
 * Worth one spawn: this runs ONLY on the empty-ledger refusal, a path reached a
 * handful of times per session and always behind an LLM round-trip that dwarfs
 * the spawn (measured in this repo: 73/84/73ms for the read, 65ms for the
 * not-a-repo failure). The number is the whole point of the message — without it
 * the refusal is the same half-truth that made the agent give up. Never throws:
 * a git failure degrades to null and is logged with module + operation + cwd +
 * err.message.
 */
export async function countUncommittedChanges(cwd: string): Promise<number | null> {
  try {
    const { stdout } = await pexecFile("git", ["status", "--porcelain"], {
      cwd,
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    // `--porcelain` emits exactly one line per changed path (a rename is one
    // line), so non-empty lines ARE the change count.
    return stdout.split("\n").filter((line) => line.trim().length > 0).length;
  } catch (err) {
    logger.error(
      "orchestrator",
      `[git_commit] uncommitted-change count unavailable — \`git status --porcelain\` failed in ${cwd}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * The refusal text. Three facts, in order: the ledger this tool reads (scope,
 * not a verdict on the repo), the repository's real state, and the working
 * route.
 *
 * Naming `bash git commit` is NOT the same as advertising the
 * `MUONROI_COMMIT_SCOPE` / `MUONROI_COMMIT_GATE` bypasses that
 * registry.ts deliberately withholds (see the comment there): those switch a
 * gate OFF, while a bash `git commit` stays fully gated — it passes the live
 * git-safety checks and the LSP commit gate. Pointing at a gated route is
 * guidance; pointing at an escape hatch is an invitation to circumvent.
 *
 * @param uncommitted change count from {@link countUncommittedChanges}, or null
 *   when the git query failed (the message then claims nothing either way).
 */
export function emptyLedgerRefusalMessage(uncommitted: number | null): string {
  const state =
    uncommitted === null
      ? "the repository's own state could not be read (git status failed)"
      : uncommitted === 0
        ? "the repository has no uncommitted changes"
        : `the repository has ${uncommitted} uncommitted change(s)`;
  return (
    "git_commit stages only files you wrote via write_file/edit_file, and that ledger is empty this session — " +
    `so it has nothing to stage. That is this tool's scope, not the state of the repo: ${state}. ` +
    "To commit work made any other way, run `git commit` through the bash tool — it still passes the " +
    "git-safety checks and the LSP commit gate."
  );
}
