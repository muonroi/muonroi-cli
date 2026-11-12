/**
 * src/orchestrator/deliverable-gate.ts
 *
 * Host-measured facts about the DELIVERABLE of a run, computed from git and the
 * filesystem instead of from any model's claim, and the refusals that follow.
 *
 * Measured gap (docs-conversion /ideal runs, tcis-libraries): run 0a0d0430e149's
 * prompt said "Commit message tiếng Việt theo AGENTS.md" and required dotnet
 * build/test. It produced 0 commits after base a413be7 (the deliverables were
 * untracked, and docs/ was gitignored by `.gitignore:414 /docs`) and still ended
 * in a final answer: every gate checked process, none checked the deliverable
 * against the request.
 *
 * Inputs are host-recorded: the goal texts (the `/ideal` run goal + the pinned
 * root goal ledger), the run's base commit / start time, and the file paths the
 * run's workers wrote (captured edit/write calls). Output: a refusal list (empty
 * = nothing to refuse) and an evidence block for the verify council.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type FidelityResult, renderFidelityEvidence, runFidelityProbe } from "../workflow/fidelity-probe.js";

const MAX_WRITTEN_PATHS = 200;
const MAX_UNTRACKED_SCAN = 5000;
const MAX_LISTED = 12;
/** Host-owned state trees: bookkeeping, never the task's deliverable. */
const HOST_DIRS = [".planning/", ".muonroi-cli/", ".muonroi-flow/"];

export interface DeliverableInputs {
  cwd: string;
  /** Texts that state what the user asked for: the `/ideal` goal, root goal, constraints, open items. */
  goalTexts: readonly string[];
  /** HEAD when the run started (preferred basis for "commits since"). */
  baseCommit?: string | null;
  /** ISO start of the run/session; fallback basis, and the mtime floor for untracked-file discovery. */
  sinceIso?: string | null;
  /** Targets of the workers' captured edit/write calls (absolute or cwd-relative). */
  writtenPaths: readonly string[];
}

export interface DeliverableReport {
  gitAvailable: boolean;
  /** The goal sentence that asks for a commit, or null. */
  commitRequirement: string | null;
  commits: { count: number; basis: string; subjects: string[] } | null;
  /** Written/new deliverable files git does not track (cwd-relative, posix). */
  untracked: string[];
  /** Written files matched by an ignore rule. */
  ignored: string[];
  /** Written files tracked but with uncommitted changes. */
  uncommitted: string[];
  fidelity: FidelityResult | null;
  /** One named reason per unmet requirement; empty = the completion gate may proceed. */
  refusals: string[];
  /** Markdown block for the verify council ("" when there is nothing to say). */
  evidence: string;
}

/** The sentence of `texts` that asks for a commit, ignoring negated mentions ("do not commit"). */
export function goalRequiresCommit(texts: readonly string[]): string | null {
  const NEGATED =
    /(?:\b(?:do\s+not|don'?t|dont|never|no|not|without|avoid|skip)\b|\b(?:không|đừng|chưa|cấm|chớ)\b)[^.!?\n]{0,30}$/i;
  const PRIOR = /\b(?:last|latest|previous|recent|prior|existing)\s+$/i;
  for (const text of texts) {
    for (const m of text.matchAll(/\bcommit(?:s|ted|ting)?\b/gi)) {
      const at = m.index ?? 0;
      const sentenceStart =
        Math.max(
          text.lastIndexOf(".", at),
          text.lastIndexOf("\n", at),
          text.lastIndexOf("!", at),
          text.lastIndexOf("?", at),
        ) + 1;
      const before = text.slice(sentenceStart, at);
      const after = text.slice(at + m[0].length);
      if (NEGATED.test(before) || PRIOR.test(before)) continue;
      if (/^\s+(?:hooks?|history|log|sha|hash|id)\b/i.test(after)) continue;
      const end = text.slice(at).search(/[.!?\n]/);
      return text
        .slice(sentenceStart, end < 0 ? text.length : at + end)
        .trim()
        .slice(0, 200);
    }
  }
  return null;
}

function git(cwd: string, args: string[], input?: string): string {
  // check-ignore takes plain paths on stdin (no pathspecs) and rejects the global flag.
  const global = args[0] === "check-ignore" ? [] : ["--literal-pathspecs"];
  return execFileSync("git", [...global, ...args], {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 20_000,
  });
}

/** HEAD of the repository at `cwd`, or null (not a repository, or no commit yet). Recorded when `/ideal` starts. */
export function readHeadCommit(cwd: string): string | null {
  try {
    return git(cwd, ["rev-parse", "HEAD"]).trim() || null;
  } catch (err) {
    console.error(`[deliverable-gate] no HEAD commit to record in ${cwd}: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

const isHostPath = (rel: string) => HOST_DIRS.some((d) => `${rel}/`.startsWith(d) || rel.startsWith(d));

function relativeInRepo(cwd: string, p: string): string | null {
  let rel = path.relative(cwd, path.resolve(cwd, p));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    // The same directory can be spelled two ways (macOS /var vs /private/var, Windows 8.3 names).
    try {
      rel = path.relative(realpathSync.native(cwd), realpathSync.native(path.resolve(cwd, p)));
    } catch (err) {
      console.error(`[deliverable-gate] cannot canonicalize ${p}: ${(err as Error).message}`);
      return null;
    }
  }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join("/");
  return isHostPath(posix) ? null : posix;
}

function nul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

const CONVERSION_WORDING =
  /\b(?:convert(?:ing|ed|s)?|conversion|transcod\w+|export(?:ing)?\s+(?:to|as|into)|chuyển\s+đổi|chuyển\s+\S+\s+(?:sang|thành)|(?:html|docx?|confluence|wiki)\s+(?:to|->|sang|thành)\s+(?:markdown|md))\b/i;
const SOURCE_TOKEN = /[^\s"'`<>|*?()[\],;]+\.(?:html?|xhtml|xml|md|txt)\b/gi;
const OUTPUT_EXT = /\.(?:md|mdx|txt)$/i;

/** Source document named by the goal (an existing file) and the written text outputs, or null. */
export function conversionTarget(
  cwd: string,
  goalTexts: readonly string[],
  writtenAbs: readonly string[],
): { source: string; outputs: string[] } | null {
  const joined = goalTexts.join("\n");
  if (!CONVERSION_WORDING.test(joined)) return null;
  const outputs = writtenAbs.filter((p) => OUTPUT_EXT.test(p));
  for (const m of joined.matchAll(SOURCE_TOKEN)) {
    const abs = path.resolve(cwd, m[0].replace(/[.:]+$/, ""));
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    } catch (err) {
      console.error(`[deliverable-gate] cannot stat candidate source ${abs}: ${(err as Error).message}`);
      continue;
    }
    const outs = outputs.filter((o) => path.resolve(o) !== abs);
    if (outs.length) return { source: abs, outputs: outs };
  }
  return null;
}

const list = (paths: readonly string[]) =>
  paths.slice(0, MAX_LISTED).join(", ") + (paths.length > MAX_LISTED ? `, … ${paths.length - MAX_LISTED} more` : "");

export function collectDeliverableReport(input: DeliverableInputs): DeliverableReport {
  const { cwd } = input;
  const commitRequirement = goalRequiresCommit(input.goalTexts);
  const written = [...new Set(input.writtenPaths.map((p) => path.resolve(cwd, p)))]
    .filter((p) => existsSync(p))
    .slice(0, MAX_WRITTEN_PATHS);
  const report: DeliverableReport = {
    gitAvailable: false,
    commitRequirement,
    commits: null,
    untracked: [],
    ignored: [],
    uncommitted: [],
    fidelity: null,
    refusals: [],
    evidence: "",
  };
  if (!commitRequirement && !written.length) return report;

  // Fidelity probe: independent of git, so a plain directory is still probed.
  const target = conversionTarget(cwd, input.goalTexts, written);
  if (target) {
    report.fidelity = runFidelityProbe(target.source, target.outputs, cwd);
    for (const f of report.fidelity.failures)
      report.refusals.push(`fidelity probe: ${f}. Fix the converter output and re-run the check.`);
  }

  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    report.gitAvailable = true;
  } catch (err) {
    // Not a repository (or git missing): nothing git-based can be measured, so nothing is refused on it.
    console.error(`[deliverable-gate] git unavailable in ${cwd}: ${(err as Error).message.split("\n")[0]}`);
  }

  if (report.gitAvailable) {
    try {
      measureCommits(report, input);
      measureTracking(report, input, relPaths(written, cwd));
    } catch (err) {
      console.error(`[deliverable-gate] git measurement failed in ${cwd}: ${(err as Error).message.split("\n")[0]}`);
      report.gitAvailable = false;
    }
    if (report.gitAvailable) addGitRefusals(report);
  }
  report.evidence = renderEvidence(report, relPaths(written, cwd));
  return report;
}

const relPaths = (abs: readonly string[], cwd: string) =>
  abs.map((p) => relativeInRepo(cwd, p)).filter((p): p is string => p !== null);

function measureCommits(report: DeliverableReport, input: DeliverableInputs): void {
  const { cwd, baseCommit, sinceIso } = input;
  let basis = "";
  let range: string[] | null = null;
  if (baseCommit) {
    try {
      git(cwd, ["cat-file", "-e", `${baseCommit}^{commit}`]);
      basis = `base commit ${baseCommit.slice(0, 8)}`;
      range = [`${baseCommit}..HEAD`];
    } catch (err) {
      console.error(
        `[deliverable-gate] base commit ${baseCommit} not found, using run start time: ${(err as Error).message.split("\n")[0]}`,
      );
    }
  }
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  if (!range && Number.isFinite(sinceMs)) {
    basis = `run start ${sinceIso}`;
    range = [`--since=${Math.floor(sinceMs / 1000)}`, "HEAD"];
  }
  if (!range) return;
  let subjects: string[] = [];
  try {
    subjects = git(cwd, ["log", "--format=%h %s", ...range])
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    // An unborn HEAD (no commits at all) is a legitimate 0.
    console.error(`[deliverable-gate] git log failed (treated as 0 commits): ${(err as Error).message.split("\n")[0]}`);
  }
  report.commits = { count: subjects.length, basis, subjects: subjects.slice(0, 5) };
}

function measureTracking(report: DeliverableReport, input: DeliverableInputs, relWritten: readonly string[]): void {
  const { cwd, sinceIso } = input;
  const untracked = new Set<string>();
  const sinceMs = sinceIso ? Date.parse(sinceIso) : Number.NaN;
  if (relWritten.length) {
    for (const p of nul(git(cwd, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...relWritten])))
      untracked.add(p);
    try {
      report.ignored = nul(git(cwd, ["check-ignore", "-z", "--stdin"], `${relWritten.join("\0")}\0`)).filter(
        (p) => !isHostPath(p),
      );
    } catch (err) {
      // `check-ignore` exits 1 when nothing matches; any other failure is a real error.
      const status = (err as { status?: number }).status;
      if (status !== 1) throw err;
    }
    try {
      report.uncommitted = nul(git(cwd, ["diff", "--name-only", "--relative", "-z", "HEAD", "--", ...relWritten]));
    } catch (err) {
      // No HEAD yet (nothing was ever committed): there is no committed state to differ from.
      console.error(
        `[deliverable-gate] git diff HEAD failed, uncommitted changes not measured: ${(err as Error).message.split("\n")[0]}`,
      );
    }
  }
  // Files the run created through a shell (no captured write call): new, untracked, newer than the run start.
  if (Number.isFinite(sinceMs)) {
    for (const p of nul(git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])).slice(0, MAX_UNTRACKED_SCAN)) {
      if (isHostPath(p) || untracked.has(p)) continue;
      try {
        if (statSync(path.resolve(cwd, p)).mtimeMs >= sinceMs) untracked.add(p);
      } catch (err) {
        console.error(`[deliverable-gate] cannot stat untracked ${p}: ${(err as Error).message}`);
      }
    }
  }
  report.untracked = [...untracked].sort();
}

function addGitRefusals(report: DeliverableReport): void {
  const commit = report.commitRequirement;
  if (commit && report.commits && report.commits.count === 0)
    report.refusals.push(
      `the goal asks for a commit (${JSON.stringify(commit)}) but there are 0 commits since ${report.commits.basis}. Stage the deliverables (git add -f for ignored paths) and commit them with the requested message.`,
    );
  if (report.ignored.length)
    report.refusals.push(
      `deliverable(s) written by workers are ignored by git and invisible to any commit: ${list(report.ignored)}. Remove the ignore rule or force-add them, or move the output to a tracked path.`,
    );
  if (commit && report.untracked.length)
    report.refusals.push(
      `the goal asks for a commit but new deliverable file(s) are untracked: ${list(report.untracked)}. git add and commit them.`,
    );
  if (commit && report.uncommitted.length)
    report.refusals.push(
      `the goal asks for a commit but written file(s) have uncommitted changes: ${list(report.uncommitted)}. Commit them.`,
    );
}

function renderEvidence(report: DeliverableReport, writtenRel: readonly string[]): string {
  const lines = ["### Host-measured deliverable facts (git and filesystem, not worker claims)"];
  lines.push(
    `- commit requirement: ${report.commitRequirement ? `yes, ${JSON.stringify(report.commitRequirement)}` : "none stated in the goal"}`,
  );
  if (!report.gitAvailable) lines.push("- git: unavailable here, so commits and tracking were not measured");
  else {
    lines.push(
      report.commits
        ? `- commits since ${report.commits.basis}: ${report.commits.count}${report.commits.subjects.length ? ` (${report.commits.subjects.join("; ")})` : ""}`
        : "- commits since the run start: not measurable (no base commit or start time recorded)",
    );
    lines.push(`- files written by workers: ${writtenRel.length ? list(writtenRel) : "none captured"}`);
    lines.push(`- untracked deliverables: ${report.untracked.length ? list(report.untracked) : "none"}`);
    lines.push(`- ignored by git: ${report.ignored.length ? list(report.ignored) : "none"}`);
    lines.push(`- tracked but uncommitted: ${report.uncommitted.length ? list(report.uncommitted) : "none"}`);
  }
  if (report.fidelity)
    lines.push("- source-vs-output fidelity probe:", renderFidelityEvidence(report.fidelity).replace(/^/gm, "  "));
  lines.push(
    report.refusals.length
      ? `- HOST VERDICT: deliverable requirements UNMET (${report.refusals.length}); completion is refused.`
      : "- host verdict: no unmet deliverable requirement found",
  );
  return lines.join("\n");
}
