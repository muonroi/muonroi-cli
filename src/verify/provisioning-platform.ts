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
 * Every entry in `commands` that names a path impossible on `platform`.
 *
 * Empty when all entries are possible — which is the answer on every non-win32
 * platform today, since both invariants are win32-only.
 */
export function findImpossibleProvisioning(
  commands: readonly string[],
  platform: NodeJS.Platform,
): ImpossibleProvisioningCommand[] {
  const out: ImpossibleProvisioningCommand[] = [];
  for (const command of commands) {
    if (typeof command !== "string" || command.trim() === "") continue;
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
