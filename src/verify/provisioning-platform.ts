/**
 * src/verify/provisioning-platform.ts
 *
 * The ONE definition of "this stored provisioning command names a path that
 * cannot exist on this platform".
 *
 * Sibling of `../product-loop/coverage-signal.ts` and
 * `../product-loop/test-command-signal.ts`: one module, one signal, pure, and the
 * reasoning for the signal lives with the signal rather than in the consumer.
 * The consumer is `./recipe-merge.ts`, which owns the MERGE rule; this module owns
 * only the question of platform possibility.
 *
 * ## The distinction this adds
 *
 * `recipe-merge.ts` defers to a stored provisioning list outright, and that rule
 * is correct — `npm ci` followed by `npm install` is one operation run twice, and
 * a differently-sourced node install joined onto an ordered apt + nodesource
 * sequence is a conflict, not a superset (argued at `./recipe-merge.ts:72`). The
 * rule was missing exactly one distinction:
 *
 * > Deference is owed to a record that knows something the disk scan cannot see.
 * > It is NOT owed to a record asserting an impossibility about the host it is
 * > running on. That is stale garbage, not knowledge.
 *
 * ## The measured case
 *
 * `D:\sources\CompanyLibs\qa-platform\.muonroi-cli\environment.json` (copied
 * byte-for-byte to `__tests__/fixtures/qa-platform-environment.json:12-15`) was
 * authoritative for every run and held, as its second install command:
 *
 *     cd /d/sources/CompanyLibs/qa-platform/backend && python3 -m venv .venv
 *       && .venv/bin/pip install --upgrade pip
 *       && .venv/bin/pip install -r requirements.txt
 *
 * Three things in that one line are false about a win32 host. `python3 -m venv
 * .venv` RE-CREATES an existing venv, and the host's bare `python3` is 3.14, so
 * every sprint replaced a working cp312 venv with a cp314 one and the compiled
 * cp312 wheel vanished — measured from the verify floor's own baseline record:
 * `ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'`, pytest
 * exit 2. The other two are the invariants below.
 *
 * ## Why a filesystem check is the WRONG signal
 *
 * An install command legitimately names paths that do not exist yet — the line
 * above CREATES `.venv` before using it. Existence therefore cannot distinguish
 * "not provisioned yet" from "impossible here". Platform SHAPE can, and is
 * decidable without touching the disk.
 *
 * ## Why the test must stay narrow
 *
 * A false positive silently discards real operator knowledge, which is worse than
 * the bug this closes. So an entry is rejected only on a DOCUMENTED platform
 * invariant that was verified against the installed stdlib or measured on the
 * host — never on a hunch about what a command "probably" means. Both invariants
 * below are win32-only; the same commands are CORRECT on linux, which is why
 * {@link findImpossibleProvisioning} takes the platform as an argument and never
 * reads `process.platform` itself.
 *
 * ## Delegation: the invariants only bind a command that RUNS on this host
 *
 * The first shipped version judged every entry by the host's invariants, and that
 * was wrong for a whole family of correct commands. Measured against those
 * invariants — all four are valid win32 commands, all four were reported
 * impossible:
 *
 *     REJECTED  venv=1 msys=0  docker compose run --rm backend /opt/venv/bin/pip install -r requirements.txt
 *     REJECTED  venv=0 msys=1  wsl -d Ubuntu -- bash -lc 'cd /d/sources/x && make deps'
 *     REJECTED  venv=1 msys=0  ssh host 'cd /opt/app && ./venv/bin/pip install -e .'
 *     REJECTED  venv=0 msys=1  docker run -v /c/Users/phila/app:/app node:20 npm ci
 *
 * When a command hands off to a container, a WSL guest or a remote host, the POSIX
 * path inside it describes THAT environment. It is not a claim about this host, so
 * this host's invariants have nothing to say about it. Whether the path is right
 * over there is not decidable from the string, and is not this module's question.
 *
 * This is live for the project the invariants were built for: qa-platform is a
 * docker-compose project (`./recipe-merge.ts:73` records `docker compose up -d` as
 * its `startCommand`), and this repo's own `CLAUDE.md` documents the harness
 * fallback as `wsl -d Ubuntu -- bash -lc 'cd ~/muonroi-cli && …'`.
 *
 * Two properties make the exemption safe:
 *
 *  - **Anchored on the INVOKED executable**, never a substring. The delegator has
 *    to sit at the start of the command or straight after a shell separator, so
 *    `echo docker && .venv/bin/pip install …` is still rejected — a stray word
 *    cannot disarm the check.
 *  - **Scoped PER ENTRY.** A delegating entry is exempt; a non-delegating
 *    impossible entry in the SAME list still triggers the wholesale fallthrough.
 *    One `docker` line cannot launder an impossible sibling.
 *
 * ### What is deliberately NOT recognised (the residual false-positive surface)
 *
 * Every name below would also delegate, and a stored command using one is still
 * judged by this host's invariants — i.e. it can still be a false positive. Each
 * is excluded because it has no measured case in this repo or this project, and
 * every added name widens the hole through which a genuinely impossible command
 * passes unexamined:
 *
 *  - **Prefix-wrapped delegators**: `sudo docker …`, `env FOO=1 docker …`,
 *    `winpty docker …`, `sshpass -p … ssh …`, `cmd /c wsl …`. The delegator is no
 *    longer the invoked token, and loosening the anchor to "anywhere" is exactly
 *    what lets `echo docker` through.
 *  - **Other container/VM runners**: `nerdctl`, `kubectl exec`, `vagrant ssh`,
 *    `lima`, `colima`, `multipass exec`, `ubuntu.exe run`.
 *  - **Other remote transports**: `scp`, `rsync` with a `host:path` spec, `plink`,
 *    `putty`.
 *  - **Indirection that hides the handoff entirely**: `make deps`, `npm run
 *    docker:deps`, `./scripts/provision.sh` — the delegation is inside a file this
 *    module never reads, so no string test could see it.
 *  - **Same-host shells**: `pwsh -c`, `powershell -c`, `cmd /c`. These are NOT
 *    delegation — they run on this host, so the invariants correctly still apply.
 *
 * A miss here is recoverable and visible: the rejection is named in `notes` with
 * the command and the invariant, so an operator can read exactly what was ignored
 * and why, and the fallback list is re-derived from disk rather than stale.
 *
 * Pure: no disk access, no globals, no mutation of the input.
 */

/** One stored command, and every platform invariant it violates. */
export interface ImpossibleProvisioningCommand {
  /** The stored command, verbatim. */
  command: string;
  /** Every invariant this command violates, in declaration order. Never empty. */
  invariants: string[];
}

interface PlatformInvariant {
  /** Only applies when the host platform is one of these. */
  readonly platforms: readonly NodeJS.Platform[];
  /** Matches the impossible SHAPE — never consults the filesystem. */
  readonly shape: RegExp;
  /** Names the invariant for the audit trail. Written for a human reading `notes`. */
  readonly because: string;
}

const INVARIANTS: readonly PlatformInvariant[] = [
  {
    platforms: ["win32"],
    // `.venv/bin/`, `venv\bin\`, `backend/.venv/bin/pip`. The lookbehind keeps the
    // segment to exactly `venv` or `.venv`, so `myvenv/bin/` does NOT match — a
    // narrower test is the safe direction when a false positive discards knowledge.
    shape: /(?<![A-Za-z0-9_])\.?venv[/\\]bin[/\\]/i,
    because:
      "on win32 a virtualenv has no `bin/` directory — CPython resolves the venv script " +
      'directory through `sysconfig.get_path("scripts", scheme="venv")` ' +
      "(Lib/venv/__init__.py:102-107, used at :175), and Lib/sysconfig/__init__.py:104-105 " +
      "aliases that scheme to `nt_venv`, whose only script path is `{base}/Scripts` (:98); " +
      "`posix_venv` is the one with `{base}/bin` (:88). Verified on this host: " +
      "`python3 -m venv` created Include/Lib/Scripts and no `bin`. The real path is `.venv/Scripts/`",
  },
  {
    platforms: ["win32"],
    // A `/x/` token where `x` is a single letter: the MSYS spelling of a drive root.
    // The leading boundary is stated POSITIVELY (start of string, or a shell
    // separator) rather than as a negated character class, because the negated form
    // has to spell a literal backslash inside the class and `biome check --write`
    // silently rewrites `[…\\-]` to `[…-]` — which DROPS the backslash and makes the
    // pattern match `cd foo\/c/bar`, i.e. drifts toward false positives, the one
    // direction this predicate must not drift. Measured: with `\\` the probe is
    // false, without it true. This spelling is escape-free and therefore stable.
    //
    // It matches `cd /d/…`, `cd /c/…` and `--prefix=/c/…`, and NOT `sed 's/a/b/'`,
    // `.venv/Scripts/…`, `https://host/setup.x` or `2>/dev/null` — every one of
    // those is pinned as a non-match in `__tests__/provisioning-platform.test.ts`.
    shape: /(?:^|[\s=;&|(])\/[A-Za-z]\//,
    because:
      "on win32 the verify floor spawns through `spawn(command, {shell: true})`, i.e. cmd.exe, " +
      "which cannot resolve an MSYS absolute drive path. Measured on this host: " +
      '`cd /d/sources/CompanyLibs/qa-platform/backend && echo ARRIVED` exits 1 with "The syntax ' +
      'of the command is incorrect." (cmd.exe reads the leading `/d` as its own drive-switch flag), ' +
      'and `cd /c/Windows && echo ARRIVED` exits 1 with "The system cannot find the path specified."',
  },
];

/**
 * The command position a delegator has to occupy: the start of the command, or
 * immediately after a shell separator.
 *
 * Stated POSITIVELY and assembled with `new RegExp`, for the same two reasons the
 * MSYS invariant above is: a negated class would have to spell a literal backslash,
 * which `biome check --write` rewrites (dropping it and widening the match), and one
 * shared source string cannot drift between the patterns built from it.
 *
 * This anchor is the whole reason `echo docker && …` cannot disarm the check.
 */
const INVOKED = String.raw`(?:^|[\n;|&(])\s*`;

/**
 * Executables that hand the command off to another OS or host. The set is small on
 * purpose — the module header lists what is excluded and why.
 */
const DELEGATORS: readonly RegExp[] = [
  // `docker run`, `docker compose run`, `docker exec`, `docker-compose up`.
  new RegExp(`${INVOKED}docker(?:-compose)?\\s`, "i"),
  new RegExp(`${INVOKED}podman(?:-compose)?\\s`, "i"),
  // `wsl -d Ubuntu -- …`, `wsl.exe …`.
  new RegExp(`${INVOKED}wsl(?:\\.exe)?\\s`, "i"),
  new RegExp(`${INVOKED}ssh\\s`, "i"),
  // A POSIX shell invoked to run a command string: `bash -lc '…'`, `sh -c '…'`.
  // Requires the `-…c` flag, so `bash install.sh` (a file this module cannot read)
  // is not treated as delegation.
  new RegExp(`${INVOKED}(?:bash|sh)\\s+-[A-Za-z]*c\\b`, "i"),
];

/**
 * True when the command's INVOKED executable hands work to another OS or host, so
 * this host's platform invariants do not bind it.
 *
 * Platform-independent by construction: it asks what the command does, not where it
 * is running.
 */
function delegatesOffHost(command: string): boolean {
  return DELEGATORS.some((shape) => shape.test(command));
}

/**
 * Every entry in `commands` that names a path impossible on `platform`.
 *
 * Empty when all entries are possible — which is the answer on every non-win32
 * platform today, since both invariants are win32-only.
 *
 * Entries that delegate off-host are skipped before the invariants are consulted,
 * per entry, so one delegating command never excuses a non-delegating sibling.
 */
export function findImpossibleProvisioning(
  commands: readonly string[],
  platform: NodeJS.Platform,
): ImpossibleProvisioningCommand[] {
  const out: ImpossibleProvisioningCommand[] = [];
  for (const command of commands) {
    if (typeof command !== "string" || command.trim() === "") continue;
    // A delegated command's POSIX paths describe the container / guest / remote
    // host, not this one. Judging them by this host's invariants is the false
    // positive this guard exists to prevent.
    if (delegatesOffHost(command)) continue;
    const invariants = INVARIANTS.filter((rule) => rule.platforms.includes(platform) && rule.shape.test(command)).map(
      (rule) => rule.because,
    );
    if (invariants.length > 0) out.push({ command, invariants });
  }
  return out;
}

/**
 * The `notes` line recording one rejection.
 *
 * A silent drop would reproduce the very defect class this area exists to close —
 * a signal reporting something other than what it measured — so the rejected
 * command and the invariant it violates both go into the audit trail.
 */
export function describeImpossibleProvisioning(
  field: "installCommands" | "bootstrapCommands",
  platform: NodeJS.Platform,
  rejected: readonly ImpossibleProvisioningCommand[],
): string[] {
  return rejected.map(
    ({ command, invariants }) =>
      `Stored \`${field}\` ignored on ${platform}: the recorded command \`${command}\` names a path that ` +
      `cannot exist on this platform, so the list is not a trustworthy record of this host and the live disk ` +
      `derivation was used for the whole field instead. Invariant violated: ${invariants.join(" Also: ")}.`,
  );
}
