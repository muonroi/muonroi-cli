import { execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import type { DelegationRun, DelegationStatus, TaskRequest, ToolResult } from "../types/index";
import { withFileLock } from "../utils/file-lock.js";
import { logger, redactSecrets } from "../utils/logger.js";
import type { SandboxMode, SandboxSettings } from "../utils/settings";

const ID_ADJECTIVES = ["brisk", "calm", "clever", "eager", "gentle", "keen", "lively", "nimble", "quiet", "steady"];

const ID_COLORS = ["amber", "blue", "copper", "emerald", "indigo", "ivory", "silver", "teal", "violet", "white"];

const ID_ANIMALS = ["badger", "falcon", "fox", "heron", "lynx", "otter", "owl", "panda", "sparrow", "wolf"];

export interface StoredDelegation {
  id: string;
  agent: "explore";
  description: string;
  prompt: string;
  cwd: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds: number;
  maxTokens: number;
  batchApi?: boolean;
  status: DelegationStatus;
  startedAt: string;
  completedAt?: string;
  pid?: number;
  error?: string;
  title?: string;
  summary?: string;
  outputPath: string;
  notifiedAt?: string;
  parentSessionId?: string;
}

export interface DelegationNotification {
  id: string;
  message: string;
}

interface StartDelegationOptions {
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds: number;
  maxTokens: number;
  batchApi?: boolean;
}

export class DelegationManager {
  constructor(
    private readonly getCwd: () => string,
    private readonly getOwnerId: () => string | undefined = () => undefined,
    private readonly getStorageCwd: () => string = getCwd,
  ) {}

  async start(request: TaskRequest, options: StartDelegationOptions): Promise<ToolResult> {
    if (process.env.MUONROI_BACKGROUND_CHILD === "1") {
      return {
        success: false,
        output: "Nested background delegations are disabled.",
      };
    }

    if (request.agent !== "explore") {
      return {
        success: false,
        output:
          "Background delegations are read-only. Use `delegate` with the `explore` agent, or use `task` for foreground work that may edit files.",
      };
    }

    const cwd = this.getCwd();
    const dir = await ensureDelegationsDir(this.getStorageCwd());
    const id = await generateUniqueId(dir);
    const outputPath = path.join(dir, `${id}.md`);
    const jobPath = path.join(dir, `${id}.json`);

    const record: StoredDelegation = {
      id,
      agent: "explore",
      description: request.description,
      prompt: request.prompt,
      cwd,
      model: options.model,
      sandboxMode: options.sandboxMode,
      sandboxSettings: options.sandboxSettings,
      maxToolRounds: options.maxToolRounds,
      maxTokens: options.maxTokens,
      batchApi: options.batchApi,
      status: "running",
      startedAt: new Date().toISOString(),
      outputPath,
      parentSessionId: this.getOwnerId(),
    };

    await writeRecord(jobPath, record);

    const child = spawn(
      process.execPath,
      [
        ...resolveCliArgs(),
        "--directory",
        cwd,
        "--background-task-file",
        jobPath,
        ...(options.batchApi ? ["--batch-api"] : []),
      ],
      {
        cwd,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MUONROI_BACKGROUND_CHILD: "1" },
      },
    );
    child.unref();

    child.once("error", (err) => {
      logger.error("orchestrator", "Background delegation spawn failed", { id, error: err.message });
      failDelegation(jobPath, err.message).catch((writeErr) => {
        logger.error("orchestrator", "Failed to persist delegation spawn error", { id, error: writeErr.message });
      });
    });
    await withFileLock(jobPath, async () => {
      const current = await loadDelegation(jobPath);
      current.pid = child.pid;
      await writeRecord(jobPath, current);
    });

    const output = [
      `Delegation started: ${id}`,
      "Agent: explore",
      "You will be notified when it completes.",
      `Use \`delegation_read("${id}")\` to retrieve the full result later.`,
    ].join("\n");

    return {
      success: true,
      output,
      delegation: {
        id,
        agent: "explore",
        description: request.description,
        summary: "Running in the background.",
        status: "running",
      },
    };
  }

  async list(): Promise<DelegationRun[]> {
    const dir = await ensureDelegationsDir(this.getStorageCwd());
    const files = await readDelegationFiles(dir);
    const items = await Promise.all(files.map(async (file) => this.reconcile(path.join(dir, file))));

    return items
      .filter((item): item is StoredDelegation => item !== null)
      .filter((item) => this.canAccess(item))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(toDelegationRun);
  }

  async read(id: string): Promise<string> {
    const record = await this.getById(id);
    if (!record) {
      return `Delegation "${id}" not found. Use \`delegation_list()\` to see available results.`;
    }

    if (record.status === "running") {
      return `Delegation "${id}" is still running. Continue working and wait for the completion notice.`;
    }

    try {
      return await fs.readFile(record.outputPath, "utf8");
    } catch (err) {
      logger.warn("orchestrator", "Failed to read delegation output", { id, error: String(err) });
      if (record.error) {
        return `Delegation "${id}" failed.\n\n${record.error}`;
      }
      return `Delegation "${id}" completed, but its saved output could not be read.`;
    }
  }

  async kill(id: string): Promise<ToolResult> {
    const dir = await ensureDelegationsDir(this.getStorageCwd());
    const jobPath = path.join(dir, `${id}.json`);
    const stored = await readRecord(jobPath);
    if (stored && !this.canAccess(stored)) {
      return { success: false, output: `Delegation "${id}" belongs to another session.` };
    }
    const record = await this.reconcile(jobPath);
    if (!record) {
      return {
        success: false,
        output: `Delegation "${id}" not found.`,
      };
    }

    if (record.status !== "running") {
      if (stored?.status === "running" && record.status === "error") {
        return { success: true, output: `Delegation "${id}" already exited; recorded its failure.` };
      }
      return {
        success: false,
        output: `Delegation "${id}" is not running (status: ${record.status}).`,
      };
    }

    const pid = record.pid;
    if (!pid) {
      await failDelegation(jobPath, "Cancelled: Process PID was not recorded.");
      return {
        success: true,
        output: `Delegation "${id}" marked as cancelled (no active process ID was found).`,
      };
    }

    try {
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          execFile("taskkill", ["/F", "/T", "/PID", pid.toString()], { timeout: 3000, windowsHide: true }, (err) =>
            err ? reject(err) : resolve(),
          );
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
      const deadline = Date.now() + 3000;
      while (isProcessAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (isProcessAlive(pid)) throw new Error("Worker remained alive after termination request");
    } catch (err) {
      logger.error("orchestrator", "Delegation termination failed", { id, pid, error: String(err) });
      if (isProcessAlive(pid))
        return { success: false, output: `Failed to terminate delegation "${id}": ${String(err)}` };
    }

    await failDelegation(jobPath, "Cancelled by user.");

    return {
      success: true,
      output: `Delegation "${id}" (PID: ${pid}) has been terminated.`,
    };
  }

  async consumeNotifications(): Promise<DelegationNotification[]> {
    const dir = await ensureDelegationsDir(this.getStorageCwd());
    const files = await readDelegationFiles(dir);
    const notifications: DelegationNotification[] = [];

    for (const file of files) {
      const jobPath = path.join(dir, file);
      await this.reconcile(jobPath);
      await withFileLock(jobPath, async () => {
        const record = await readRecord(jobPath);
        if (!record || record.parentSessionId !== this.getOwnerId() || record.status === "running" || record.notifiedAt)
          return;
        record.notifiedAt = new Date().toISOString();
        await writeRecord(jobPath, record);
        notifications.push({ id: record.id, message: formatNotification(record) });
      });
    }

    return notifications.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async getById(id: string): Promise<StoredDelegation | null> {
    const dir = await ensureDelegationsDir(this.getStorageCwd());
    const record = await this.reconcile(path.join(dir, `${id}.json`));
    return record && this.canAccess(record) ? record : null;
  }

  private canAccess(record: StoredDelegation): boolean {
    return !record.parentSessionId || record.parentSessionId === this.getOwnerId();
  }

  private async reconcile(jobPath: string): Promise<StoredDelegation | null> {
    const initial = await readRecord(jobPath);
    if (!initial || !this.canAccess(initial) || initial.status !== "running") return initial;
    // start() persists the job before spawning; do not race the PID handoff.
    if (!initial.pid && Date.now() - Date.parse(initial.startedAt) < 10_000) return initial;
    if (initial.pid && isProcessAlive(initial.pid)) return initial;
    await failDelegation(jobPath, "Background worker exited before saving a result.");
    return readRecord(jobPath);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger.debug("orchestrator", "Delegation PID check", { pid, code, error: String(err) });
    // An access denial is not evidence of death.
    return code !== "ESRCH";
  }
}

export async function loadDelegation(jobPath: string): Promise<StoredDelegation> {
  const record = await readRecord(jobPath);
  if (!record) {
    throw new Error(`Delegation job not found: ${jobPath}`);
  }
  return record;
}

export async function completeDelegation(jobPath: string, output: string, fallbackSummary?: string): Promise<void> {
  await withFileLock(jobPath, async () => {
    const record = await loadDelegation(jobPath);
    if (record.status !== "running") return;
    record.status = "complete";
    record.completedAt = new Date().toISOString();
    record.title = record.title || createTitle(output, record.description);
    record.summary = createSummary(output || fallbackSummary || record.description);

    await fs.mkdir(path.dirname(record.outputPath), { recursive: true });
    await fs.writeFile(record.outputPath, renderOutput(record, output), "utf8");
    await writeRecord(jobPath, record);
  });
}

export async function failDelegation(jobPath: string, error: string, output = ""): Promise<void> {
  await withFileLock(jobPath, async () => {
    const record = await loadDelegation(jobPath);
    if (record.status !== "running") return;
    // `error` is a caught failure's text from the delegated run. It reaches TWO
    // durable artifacts — the job JSON (`record.error`, via writeRecord) and the
    // rendered `.md` (`renderOutput`'s `**Error:**` line + the body fallback) —
    // so it is redacted ONCE here, before either is built.
    //
    // Scoped deliberately to `error` alone. `record.prompt`, `record.description`
    // and `output` are the delegation's functional payload: the record is read
    // back by `loadDelegation` and the `.md` IS the deliverable. Scrubbing those
    // would corrupt a delegation whose legitimate job was to produce a config or
    // a credential-adjacent snippet. A caught error message is the only field
    // here that is pure diagnostics.
    const safeError = redactSecrets(error);
    record.status = "error";
    record.completedAt = new Date().toISOString();
    record.error = safeError;
    record.title = record.title || createTitle(output || safeError, record.description);
    record.summary = createSummary(output || safeError);

    await fs.mkdir(path.dirname(record.outputPath), { recursive: true });
    await fs.writeFile(record.outputPath, renderOutput(record, output || `Error: ${safeError}`), "utf8");
    await writeRecord(jobPath, record);
  });
}

async function ensureDelegationsDir(cwd: string): Promise<string> {
  const projectId = getProjectId(cwd);
  const dir = path.join(os.homedir(), ".muonroi-cli", "delegations", projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readDelegationFiles(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((file) => file.endsWith(".json"));
  } catch (err) {
    logger.warn("orchestrator", "Failed to list delegation records", { dir, error: String(err) });
    return [];
  }
}

async function readRecord(filePath: string): Promise<StoredDelegation | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as StoredDelegation;
  } catch (err) {
    logger.debug("orchestrator", "Failed to load delegation record", { filePath, error: String(err) });
    return null;
  }
}

async function writeRecord(filePath: string, record: StoredDelegation): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function generateUniqueId(dir: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomId();
    try {
      await fs.access(path.join(dir, `${id}.json`));
    } catch (err) {
      logger.debug("orchestrator", "Delegation ID availability check", { id, error: String(err) });
      return id;
    }
  }

  throw new Error("Failed to allocate a unique delegation ID.");
}

function randomId(): string {
  return `${pick(ID_ADJECTIVES)}-${pick(ID_COLORS)}-${pick(ID_ANIMALS)}`;
}

function pick(values: readonly string[]): string {
  return values[Math.floor(Math.random() * values.length)];
}

function resolveCliArgs(): string[] {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Could not resolve the CLI entrypoint for background delegation.");
  }
  return [entry];
}

function getProjectId(cwd: string): string {
  const base =
    path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 10);
  return `${base}-${hash}`;
}

function createTitle(text: string, fallback: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const source = firstLine || fallback.trim() || "Background delegation";
  return source.length <= 48 ? source : `${source.slice(0, 45).trimEnd()}...`;
}

function createSummary(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No summary available.";
  // Re-insert space when model token-stream glommed sentence terminators
  // against the next capital ("changes.Now" → "changes. Now").
  const spaced = compact.replace(/([.!?:])(?=[A-Z])/g, "$1 ");
  // Prefer the first sentence so the notification stays a one-liner.
  const sentenceMatch = spaced.match(/^.+?[.!?](?=\s|$)/);
  const candidate = (sentenceMatch ? sentenceMatch[0] : spaced).trim();
  return candidate.length <= 120 ? candidate : `${candidate.slice(0, 117).trimEnd()}...`;
}

function renderOutput(record: StoredDelegation, content: string): string {
  const title = record.title || record.id;
  const summary = record.summary || "No summary available.";
  const completed = record.completedAt || "N/A";
  const error = record.error ? `\n**Error:** ${record.error}\n` : "";

  return [
    `# ${title}`,
    "",
    summary,
    "",
    `**ID:** ${record.id}`,
    `**Agent:** ${record.agent}`,
    `**Status:** ${record.status}`,
    `**Started:** ${record.startedAt}`,
    `**Completed:** ${completed}`,
    "",
    `**Prompt:** ${record.description}`,
    error.trimEnd(),
    "",
    "---",
    "",
    content.trim() || "(No output)",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatNotification(record: StoredDelegation): string {
  const title = record.title || record.description || record.id;
  const summary = record.summary || (record.error ? createSummary(record.error) : "No summary available.");
  const statusText = record.status === "complete" ? "complete" : "failed";
  const lines = [`Background agent ${statusText}: \`${record.id}\``, `Title: ${title}`, `Summary: ${summary}`];

  if (record.error) {
    lines.push(`Error: ${record.error}`);
  }

  lines.push(`Use \`delegation_read("${record.id}")\` to retrieve the full result.`);
  return lines.join("\n");
}

function toDelegationRun(record: StoredDelegation): DelegationRun {
  return {
    id: record.id,
    agent: "explore",
    description: record.description,
    summary: record.summary || (record.status === "running" ? "Running in the background." : "No summary available."),
    status: record.status,
  };
}
