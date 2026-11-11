import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ReviewVerdict } from "../types/index.js";
import { logger, redactSecrets } from "../utils/logger.js";

// Runtime products are excluded; project inputs (including tests and dirty WIP) are not.
const EPHEMERAL = new Set([".git", "node_modules", ".quick-codex-flow", ".muonroi-cli"]);
const excluded = (name: string) => name.split(/[\\/]/).some((part) => EPHEMERAL.has(part));
interface SnapshotState {
  ancestors: Set<string>;
  boundary: string;
  depth: number;
  budget: { gitBytes: number; fileBytes: number; files: number };
}
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
};
const execFileAsync = promisify(execFile);

/** Git runs off the host event loop; deadlines and byte limits remain enforced. */
async function snapshotGit(root: string, args: string[], timeout: number): Promise<string> {
  const started = performance.now();
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  } catch (err) {
    const failure = err as Error & { code?: string | number; status?: number; elapsedMs?: number; timeoutMs?: number };
    // execFile reports nonzero exit status as numeric code; keep the saved
    // diagnostic's status field compatible with the former sync runner.
    if (typeof failure.code === "number") failure.status = failure.code;
    failure.elapsedMs = Math.round(performance.now() - started);
    failure.timeoutMs = timeout;
    logger.file("debug", "orchestrator", "Snapshot Git command failed", {
      cwd: root,
      args,
      elapsedMs: failure.elapsedMs,
      timeoutMs: timeout,
      error: failure.message,
    });
    throw failure;
  }
}

/** Snapshot identity, not a security sandbox. Unknown or over-budget snapshots fail closed. */
export async function sourceFingerprint(cwd: string, parent?: SnapshotState): Promise<string> {
  const root = await fs.realpath(cwd);
  if (parent?.ancestors.has(root) || (parent?.depth ?? 0) >= 8)
    throw new Error("Source snapshot linked-root cycle/depth limit exceeded.");
  const state: SnapshotState = {
    ancestors: new Set([...(parent?.ancestors ?? []), root]),
    boundary: parent?.boundary ?? root,
    depth: (parent?.depth ?? 0) + 1,
    budget: parent?.budget ?? { gitBytes: 0, fileBytes: 0, files: 0 },
  };
  let files: string[];
  const hash = createHash("sha256");
  hash.update(root);
  const walkFiles = async (): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
        const name = path.join(dir, item.name);
        if (excluded(name)) continue;
        if (item.isDirectory()) await walk(name);
        else found.push(name);
        if (found.length > 50000) throw new Error("Source snapshot file limit exceeded.");
      }
    };
    await walk("");
    return found;
  };
  let git = false;
  try {
    await snapshotGit(root, ["rev-parse", "--show-toplevel"], 10000);
    git = true;
  } catch (err) {
    logger.file("debug", "orchestrator", "Git source probe unavailable", { cwd: root, error: String(err) });
    // Fall back only for an actual nongit workspace, never a broken git checkout.
    let cursor = root;
    while (true) {
      let hasGitMarker = false;
      try {
        await fs.lstat(path.join(cursor, ".git"));
        hasGitMarker = true;
      } catch (probe) {
        logger.file("debug", "orchestrator", "Source snapshot parent Git lookup", {
          cwd: cursor,
          error: String(probe),
        });
        if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
      }
      if (hasGitMarker) {
        const native = err as {
          code?: unknown;
          status?: unknown;
          signal?: unknown;
          stderr?: unknown;
          message?: string;
          elapsedMs?: number;
          timeoutMs?: number;
        } | null;
        const diagnostic = redactSecrets(String(native?.stderr || native?.message || err)).slice(0, 1600);
        const failure = new Error(
          `Source snapshot: git checkout could not be enumerated. git rev-parse --show-toplevel; cwd=${root}; code=${native?.code ?? "none"}; status=${native?.status ?? "none"}; signal=${native?.signal ?? "none"}; elapsedMs=${native?.elapsedMs ?? "unknown"}; timeoutMs=${native?.timeoutMs ?? "unknown"}; ${diagnostic}`,
          { cause: err },
        );
        // Persist the native failure at warning level: debug-only probe logs
        // disappear in normal sessions and cannot explain a refused review.
        logger.file("warn", "orchestrator", "Git source probe failed in checkout", {
          cwd: root,
          gitMarkerRoot: cursor,
          error: failure.message,
        });
        throw failure;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  if (git) {
    const gitRead = async (args: string[]) => {
      const value = await snapshotGit(root, args, 30000);
      state.budget.gitBytes += Buffer.byteLength(value);
      if (state.budget.gitBytes > 256 * 1024 * 1024)
        throw new Error("Source snapshot shared Git metadata/diff limit exceeded (256MiB).");
      return value;
    };
    // Git owns unchanged blob identities. Hash the complete index manifest and
    // binary working diff, rather than reading 100k unchanged blobs ourselves.
    // No index refresh/write, checkout, external diff or textconv runs here.
    const manifest = await gitRead(["ls-files", "--stage", "-z", "--", "."]);
    const flags = await gitRead(["ls-files", "-v", "-z", "--", "."]);
    files = (await gitRead(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]))
      .split("\0")
      .filter(Boolean);
    if (!manifest && !files.length) files = await walkFiles();
    else {
      if (flags.split("\0").some((line) => line && line[0] !== "s" && line[0] === line[0]!.toLowerCase())) {
        throw new Error(
          "Source snapshot cannot verify assume-unchanged inputs. Clear that flag before review; source was not accepted.",
        );
      }
      const capturedGitlinks = new Set<string>();
      const captureGitlink = async (name: string): Promise<void> => {
        if (capturedGitlinks.has(name)) return;
        capturedGitlinks.add(name);
        const location = path.resolve(root, name);
        if (!inside(root, location)) throw new Error("Source snapshot gitlink escaped workspace.");
        hash.update(`\0gitlink:${name}\0`);
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stat = await fs.lstat(location);
        } catch (err) {
          logger.file("debug", "orchestrator", "Source snapshot gitlink lookup", { error: String(err) });
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            hash.update("absent");
            return;
          }
          throw err;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error(`Unsupported gitlink filesystem entry: ${name}`);
        const real = await fs.realpath(location);
        if (!inside(state.boundary, real)) throw new Error(`External gitlink source refused: ${name}`);
        const ownRoot = (await snapshotGit(real, ["rev-parse", "--show-toplevel"], 10000)).trim();
        if (path.relative(await fs.realpath(ownRoot), real) === "") {
          hash.update("initialized");
          hash.update(await sourceFingerprint(real, state));
        } else if ((await fs.readdir(real)).length === 0) hash.update("uninitialized-empty");
        else throw new Error(`Nonempty uninitialized gitlink source is unknown: ${name}`);
      };
      for (const entry of manifest.split("\0")) {
        if (!entry) continue;
        const match = /^(100644|100755|120000|160000) [a-f0-9]+ [0-3]\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Source snapshot unsupported index entry.");
        if (match[1] === "120000") files.push(match[2]!);
        if (match[1] === "160000") await captureGitlink(match[2]!);
      }
      const workingModes = await gitRead(["diff", "--raw", "--no-ext-diff", "--no-textconv", "-z", "--", "."]);
      const raw = workingModes.split("\0");
      for (let index = 0; index < raw.length; index++) {
        const mode = raw[index]?.startsWith(":") ? raw[index]!.split(" ")[1] : undefined;
        if (mode === "120000") files.push(raw[++index]!);
        else if (mode === "160000") await captureGitlink(raw[++index]!);
      }
      hash.update(manifest);
      hash.update(flags);
      hash.update(await gitRead(["config", "--null", "--local", "--list"]));
      const sparsePath = path.resolve(
        root,
        (await gitRead(["rev-parse", "--git-path", "info/sparse-checkout"])).trim(),
      );
      try {
        hash.update(await fs.readFile(sparsePath));
      } catch (err) {
        logger.file("debug", "orchestrator", "Source snapshot sparse pattern lookup", { error: String(err) });
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      hash.update("\0working-diff\0");
      hash.update(await gitRead(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--", "."]));
      // Sparse absent paths retain their index blob identity. Present S/s paths
      // need byte hashing because Git deliberately suppresses their working diff.
      for (const entry of flags.split("\0")) {
        if (!/^[Ss] /.test(entry)) continue;
        const name = entry.slice(2);
        if (capturedGitlinks.has(name)) continue;
        try {
          await fs.lstat(path.resolve(root, name));
          files.push(name);
        } catch (err) {
          logger.file("debug", "orchestrator", "Source snapshot sparse file lookup", { error: String(err) });
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  } else files = await walkFiles();
  files = [...new Set(files)].sort();
  state.budget.files += files.length;
  if (state.budget.files > 50000)
    throw new Error("Source snapshot shared file limit exceeded (50000 materialized/untracked inputs).");
  for (const name of files) {
    const file = path.resolve(root, name);
    const rel = path.relative(root, file);
    if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))
      throw new Error("Source snapshot escaped workspace.");
    hash.update(`\0${name.replaceAll("\\", "/")}\0`);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(file);
    } catch (err) {
      logger.file("debug", "orchestrator", "Source snapshot materialized input lookup", {
        path: name,
        error: String(err),
      });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("missing");
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.realpath(file);
      if (!inside(state.boundary, target)) throw new Error(`External source symlink refused: ${name}`);
      hash.update(`\0symlink:${await fs.readlink(file)}:${target}\0`);
      stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`Source snapshot unsupported entry: ${name}`);
    }
    if (stat.isDirectory()) {
      // ls-files reports an untracked embedded Git repository as "dir/".
      // Reuse the same bounded snapshot instead of treating it as an empty blob.
      const real = await fs.realpath(file);
      if (!inside(state.boundary, real)) throw new Error(`External nested Git root refused: ${name}`);
      const gitRoot = (await snapshotGit(real, ["rev-parse", "--show-toplevel"], 10000)).trim();
      if (path.relative(await fs.realpath(gitRoot), real) !== "")
        throw new Error(`Unknown source directory refused: ${name}`);
      hash.update("nested-git-root");
      hash.update(await sourceFingerprint(real, state));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Source snapshot unsupported entry: ${name}`);
    const handle = await fs.open(file, "r");
    try {
      const before = await handle.stat();
      if (state.budget.fileBytes + before.size > 256 * 1024 * 1024)
        throw new Error(
          `Source snapshot byte limit exceeded: input=${name} bytes=${before.size} cumulativeBytes=${state.budget.fileBytes}; shared limit=256MiB.`,
        );
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let readBytes = 0;
      while (true) {
        const chunk = await handle.read(buffer, 0, buffer.length, null);
        if (!chunk.bytesRead) break;
        readBytes += chunk.bytesRead;
        state.budget.fileBytes += chunk.bytesRead;
        if (state.budget.fileBytes > 256 * 1024 * 1024)
          throw new Error(`Source snapshot byte limit exceeded while reading ${name}; shared limit=256MiB.`);
        hash.update(buffer.subarray(0, chunk.bytesRead));
      }
      const after = await handle.stat();
      const current = await fs.stat(file);
      if (
        readBytes !== before.size ||
        [after, current].some(
          (value) =>
            value.size !== before.size ||
            value.mtimeMs !== before.mtimeMs ||
            value.ctimeMs !== before.ctimeMs ||
            value.ino !== before.ino ||
            value.dev !== before.dev,
        )
      )
        throw new Error(`Source changed while fingerprinting: ${name}`);
    } catch (err) {
      logger.file("warn", "orchestrator", "Source snapshot streamed input failed", { path: name, error: String(err) });
      throw err;
    } finally {
      await handle.close().catch((err) => {
        logger.file("warn", "orchestrator", "Source snapshot file close failed", { path: name, error: String(err) });
        throw err;
      });
    }
  }
  return hash.digest("hex");
}

export function parseReviewVerdict(output: string): ReviewVerdict | undefined {
  const body = output
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const value = JSON.parse(body);
    if (
      !["pass", "fail"].includes(value.verdict) ||
      !Array.isArray(value.evidence) ||
      !value.evidence.length ||
      !value.evidence.every((v: unknown) => typeof v === "string" && v.trim())
    )
      return undefined;
    return { verdict: value.verdict, evidence: value.evidence };
  } catch (err) {
    logger.file("debug", "orchestrator", "Review verdict is not structured JSON", { error: String(err) });
    return undefined;
  }
}
