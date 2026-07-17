import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRuntimeLspDefinitions, type RuntimeLspServerDefinition } from "./builtins";
import { createLspClientSession, type LspClientSession } from "./client";
import type {
  DegradedReason,
  ImpactOfChangeResult,
  LspDiagnostic,
  LspDiagnosticFile,
  LspLocation,
  LspQueryInput,
  LspQueryResult,
  LspStatus,
  LspToolResponse,
  MutationPreviewResult,
  NormalizedLspSettings,
  PolicyAction,
} from "./types";

interface ManagedClient {
  key: string;
  definition: RuntimeLspServerDefinition;
  root: string;
  client: LspClientSession;
}

interface WorkspaceLspManagerOptions {
  createClient?: (input: {
    serverId: string;
    root: string;
    definition: RuntimeLspServerDefinition;
    settings: NormalizedLspSettings;
  }) => Promise<LspClientSession | null>;
}

export interface WorkspaceLspManager {
  touchFile(filePath: string, waitForDiagnostics?: boolean): Promise<LspDiagnosticFile[]>;
  syncFile(
    filePath: string,
    content: string,
    save?: boolean,
    waitForDiagnostics?: boolean,
    diagnosticsTimeoutMs?: number,
  ): Promise<LspDiagnosticFile[]>;
  query(input: LspQueryInput): Promise<LspToolResponse>;
  waitForDiagnostics(filePath: string, timeout: number): Promise<LspQueryResult>;
  impactOfChange(filePath: string, query?: string, timeout?: number): Promise<ImpactOfChangeResult>;
  lspMutationPreview(filePath: string, change: string): Promise<MutationPreviewResult>;
  lspBeforeGrep(filePath: string, query?: string): Promise<PolicyAction>;
  close(): Promise<void>;
}

export function createWorkspaceLspManager(
  cwd: string,
  settings: NormalizedLspSettings,
  options: WorkspaceLspManagerOptions = {},
): WorkspaceLspManager {
  const definitions = createRuntimeLspDefinitions(cwd, settings);
  const clients = new Map<string, Promise<ManagedClient | null>>();

  // Servers we have already reported as not installed. Without this the "no
  // command" path is silent: a Go/Rust/C++/Java file just gets no LSP and the
  // caller sees "unavailable" with no way to learn WHICH server is missing.
  const reportedMissing = new Set<string>();

  const createClient =
    options.createClient ??
    (async ({ serverId, root, definition, settings: normalizedSettings }) => {
      const launch = await definition.resolveLaunch(root, normalizedSettings);
      if (!launch?.command) {
        if (!reportedMissing.has(serverId)) {
          reportedMissing.add(serverId);
          console.error(
            `[lsp] no language server found for "${serverId}" (${definition.extensions.join(", ")}). ` +
              `Install it and make sure it is on PATH, or set lsp.builtins.${serverId}.command in settings.`,
          );
        }
        return null;
      }
      return createLspClientSession({
        serverId,
        root,
        launch,
        startupTimeoutMs: normalizedSettings.startupTimeoutMs,
        diagnosticsDebounceMs: normalizedSettings.diagnosticsDebounceMs,
      });
    });

  async function getClientsForFile(filePath: string): Promise<ManagedClient[]> {
    if (!settings.enabled) return [];

    const normalizedPath = path.resolve(filePath);
    const extension = path.extname(normalizedPath).toLowerCase();
    const matches = definitions.filter((definition) => definition.extensions.includes(extension));
    if (matches.length === 0) return [];

    const resolved = await Promise.all(
      matches.map(async (definition) => {
        const root = await definition.resolveRoot(normalizedPath, cwd);
        if (!root) return null;

        const cacheKey = `${definition.id}:${root}`;
        const inflight = clients.get(cacheKey);
        if (inflight) return inflight;

        const next = (async () => {
          const client = await createClient({
            serverId: definition.id,
            root,
            definition,
            settings,
          });
          if (!client) return null;
          return { key: cacheKey, definition, root, client };
        })();

        clients.set(cacheKey, next);
        try {
          const value = await next;
          if (!value) {
            clients.delete(cacheKey);
          }
          return value;
        } catch (err) {
          clients.delete(cacheKey);
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[lsp] Failed to start ${definition.id} for ${cacheKey}: ${msg}`);
          return null;
        }
      }),
    );

    return resolved.filter((value): value is ManagedClient => value !== null);
  }

  async function touchFile(filePath: string, waitForDiagnostics = true): Promise<LspDiagnosticFile[]> {
    try {
      const content = await readFile(filePath, "utf8");
      return await syncFile(filePath, content, false, waitForDiagnostics);
    } catch (err) {
      if (err instanceof Error && (err as any).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async function syncFile(
    filePath: string,
    content: string,
    save = true,
    waitForDiagnostics = true,
    diagnosticsTimeoutMs?: number,
  ): Promise<LspDiagnosticFile[]> {
    const records = await getClientsForFile(filePath);
    if (records.length === 0) return [];

    const extension = path.extname(filePath).toLowerCase();
    const diagnostics = await Promise.all(
      records.map(async ({ key, definition, client }) => {
        const languageId = definition.languageIds[extension] ?? (extension.slice(1) || "plaintext");
        try {
          await client.openOrChangeFile(filePath, languageId, content);
          if (save) {
            await client.saveFile(filePath);
          }
          if (waitForDiagnostics) {
            await client.waitForDiagnostics(filePath, diagnosticsTimeoutMs);
          }
          return {
            filePath,
            serverId: client.serverId,
            diagnostics: client.getDiagnostics(filePath),
          };
        } catch (err) {
          // Dropping the client silently here is what let a dead language server
          // look like "no diagnostics" for the whole session.
          console.error(
            `[lsp:${definition.id}] sync failed for ${filePath}, dropping client: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          clients.delete(key);
          return null;
        }
      }),
    );

    return diagnostics.filter((entry): entry is LspDiagnosticFile => entry !== null && entry.diagnostics.length > 0);
  }

  async function query(input: LspQueryInput): Promise<LspToolResponse> {
    const normalizedPath = path.resolve(cwd, input.filePath);
    const records = await getClientsForFile(normalizedPath);
    if (records.length === 0) {
      return {
        success: false,
        output: `No LSP server available for ${path.extname(normalizedPath) || "this file type"}.`,
      };
    }

    const lspDiagnostics = input.operation === "workspaceSymbol" ? [] : await touchFile(normalizedPath, true);
    const params = createOperationParams(input, normalizedPath);
    const timeoutMs = settings.requestTimeoutMs;
    const results = (
      await Promise.all(
        records.map(async ({ key, client }) => {
          const onError = (err: unknown): unknown[] => {
            // Timeout: the server is likely still loading its workspace (e.g. csharp-ls
            // indexing an MSBuild solution). Return no results for this call but KEEP the
            // client so a retry hits the warmed-up server instead of cold-starting again.
            if (err instanceof LspRequestTimeoutError) {
              console.error(
                `[lsp:${client.serverId}] ${input.operation} timed out after ${timeoutMs}ms ` +
                  `(server may still be loading the workspace); returning no results for this client`,
              );
              return [];
            }
            // Hard error: drop the client so the next query re-spawns it.
            clients.delete(key);
            console.error(
              `[lsp:${client.serverId}] ${input.operation} request failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
          };

          if (input.operation === "incomingCalls" || input.operation === "outgoingCalls") {
            try {
              const items = await withRequestTimeout(
                client.sendRequest<unknown[]>("textDocument/prepareCallHierarchy", params),
                timeoutMs,
              );
              const firstItem = Array.isArray(items) ? items[0] : undefined;
              if (!firstItem) return [];
              return await withRequestTimeout(
                client.sendRequest<unknown[]>(
                  input.operation === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
                  { item: firstItem },
                ),
                timeoutMs,
              );
            } catch (err) {
              return onError(err);
            }
          }

          try {
            return await withRequestTimeout(
              client.sendRequest<unknown>(getOperationMethod(input.operation), params),
              timeoutMs,
            );
          } catch (err) {
            return onError(err);
          }
        }),
      )
    )
      .flatMap((result) => (Array.isArray(result) ? result : result ? [result] : []))
      .filter(Boolean);

    const output = results.length > 0 ? JSON.stringify(results, null, 2) : `No results found for ${input.operation}.`;
    return {
      success: true,
      output,
      lspDiagnostics,
    };
  }

  async function close(): Promise<void> {
    const entries = await Promise.allSettled([...clients.values()]);
    const active = entries
      .filter((entry): entry is PromiseFulfilledResult<ManagedClient | null> => entry.status === "fulfilled")
      .map((entry) => entry.value)
      .filter((value): value is ManagedClient => value !== null);
    await Promise.allSettled(active.map((entry) => entry.client.stop()));
    clients.clear();
  }

  // ── Sprint 1: impact/readiness contract (SLICE1-BUILD-NOTE.md) ─────────────

  const TOKEN_BUDGET_CAP = 500; // hard cap (spec §49-54)
  const REF_TOKEN_COST = 30; // per-reference estimate (spec §53)
  const MAX_REFS = Math.floor(TOKEN_BUDGET_CAP / REF_TOKEN_COST); // 16 — truncation threshold

  /** Error-level = severity ≤ 1 (Error). Warnings/infos ignored (spec §21-25). */
  function errorLevel(diags: LspDiagnostic[]): LspDiagnostic[] {
    return diags.filter((d) => (d.severity ?? 1) <= 1);
  }

  /** tokenBudgetUsed = elapsed estimate + refs×30, clamped ≤500 (spec §49-54). */
  function tokenBudget(elapsedMs: number, refCount: number): number {
    const elapsedTokens = Math.min(200, Math.round(elapsedMs / 25));
    return Math.min(TOKEN_BUDGET_CAP, elapsedTokens + refCount * REF_TOKEN_COST);
  }

  /** Top-2 distinct error messages joined "; ", ≤120 chars; "none" when clean (spec §42-47). */
  function suggestedGuardFrom(errs: LspDiagnostic[]): string {
    if (errs.length === 0) return "none";
    const seen = new Set<string>();
    const messages: string[] = [];
    for (const d of errs) {
      const cat = (d.source ?? d.code ?? d.message.split(/[:.]/)[0] ?? "error").toString().trim();
      const key = `${cat}:${d.message.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(d.message.trim());
      if (messages.length === 2) break;
    }
    return messages.join("; ").slice(0, 120) || "none";
  }

  /**
   * didOpen `filePath` on every client that is about to be asked for its
   * diagnostics, so the server actually analyses it. Returns true when the file
   * cannot be read — nothing to diagnose, and reporting it "clean" would lie.
   */
  async function openForDiagnostics(filePath: string, records: ManagedClient[]): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      console.error(
        `[lsp] cannot read ${filePath} for diagnostics: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }

    const extension = path.extname(filePath).toLowerCase();
    await Promise.all(
      records.map(async ({ key, definition, client }) => {
        const languageId = definition.languageIds[extension] ?? (extension.slice(1) || "plaintext");
        try {
          await client.openOrChangeFile(filePath, languageId, content);
        } catch (err) {
          // Drop the client so the next call re-spawns it; the diagnostics wait
          // below will surface this as a failure rather than a clean verdict.
          console.error(
            `[lsp:${definition.id}] didOpen failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          clients.delete(key);
        }
      }),
    );
    return false;
  }

  async function waitForDiagnostics(filePath: string, timeout: number): Promise<LspQueryResult> {
    const clampedTimeout = Math.min(Math.max(timeout, 0), 5000);
    const t0 = Date.now();
    const records = await getClientsForFile(filePath);
    if (records.length === 0) {
      return {
        diagnostics: [],
        lspStatus: "unavailable",
        clean: false,
        metadata: { tokenBudgetUsed: tokenBudget(Date.now() - t0, 0) },
      };
    }

    // A language server only publishes diagnostics for files it has been told
    // about. Without this didOpen, waiting on a file the server has never seen
    // waits out the full timeout, gets nothing, and reports lspStatus "ok" /
    // clean: true — a green verdict on a file that was never analysed at all.
    // (Proven: a file with two tsc type errors reported clean.) Callers that
    // already synced the buffer (syncFile) are unaffected: openOrChangeFile is
    // idempotent, and diagnostics already cached short-circuit the wait below.
    const unreadable = await openForDiagnostics(filePath, records);
    if (unreadable) {
      return {
        diagnostics: [],
        lspStatus: "unavailable",
        clean: false,
        metadata: { tokenBudgetUsed: tokenBudget(Date.now() - t0, 0) },
      };
    }

    let anyTimedOut = false;
    let anyFailed = false;
    const allDiagnostics: LspDiagnostic[] = [];

    for (const record of records) {
      try {
        const diags = await withRequestTimeout(
          record.client.waitForDiagnostics(filePath, clampedTimeout),
          clampedTimeout,
        );
        allDiagnostics.push(...diags);
      } catch (err) {
        if (err instanceof LspRequestTimeoutError) {
          anyTimedOut = true;
          allDiagnostics.push(...record.client.getDiagnostics(filePath));
        } else {
          anyFailed = true;
        }
      }
    }

    const lspStatus: LspStatus = anyTimedOut
      ? "partial"
      : anyFailed && allDiagnostics.length === 0
        ? "unavailable"
        : "ok";
    // clean: true only when we actually have data and zero error-level diags (spec §85).
    const clean = lspStatus !== "unavailable" && errorLevel(allDiagnostics).length === 0;

    return {
      diagnostics: allDiagnostics,
      lspStatus,
      clean,
      metadata: { tokenBudgetUsed: tokenBudget(Date.now() - t0, 0) },
    };
  }

  async function impactOfChange(filePath: string, _query?: string, timeout?: number): Promise<ImpactOfChangeResult> {
    const t0 = Date.now();
    const diag = await waitForDiagnostics(filePath, timeout ?? 1500);

    if (diag.lspStatus === "unavailable") {
      const errs = errorLevel(diag.diagnostics);
      return {
        references: [],
        diagnostics: diag.diagnostics,
        referencesComplete: false,
        safeToRename: false,
        clean: false,
        suggestedGuard: suggestedGuardFrom(errs),
        degraded: "lsp_unavailable",
        lspStatus: "unavailable",
        metadata: { tokenBudgetUsed: tokenBudget(Date.now() - t0, 0) },
      };
    }

    const records = await getClientsForFile(filePath);
    const rawReferences: LspLocation[] = [];
    for (const record of records) {
      try {
        const uri = pathToFileURL(path.resolve(filePath)).href;
        const params = {
          textDocument: { uri },
          position: { line: 0, character: 0 },
          context: { includeDeclaration: true },
        };
        const refs = await record.client.sendRequest<unknown[]>("textDocument/references", params);
        if (Array.isArray(refs)) {
          for (const ref of refs) {
            const r = ref as {
              uri?: string;
              range?: { start: { line: number; character: number }; end: { line: number; character: number } };
            };
            if (r?.uri && r?.range) {
              rawReferences.push({
                uri: r.uri,
                range: {
                  start: { line: r.range.start.line + 1, character: r.range.start.character + 1 },
                  end: { line: r.range.end.line + 1, character: r.range.end.character + 1 },
                },
              });
            }
          }
        }
      } catch {
        // Individual reference query failure: continue with partial results
      }
    }

    // Truncate so references×30 stays within budget headroom (spec §38, §53).
    const truncated = rawReferences.length > MAX_REFS;
    const references = truncated ? rawReferences.slice(0, MAX_REFS) : rawReferences;
    const referencesComplete = !truncated;

    // Frozen union: the symbol file's waited diagnostics + each unique referenced
    // file's already-published diagnostics (cheap getDiagnostics, no extra waits).
    // clean is computed over this union of error-level diagnostics (spec §19-25).
    const unionDiags: LspDiagnostic[] = [...diag.diagnostics];
    const seenFiles = new Set<string>([path.resolve(filePath)]);
    for (const ref of references) {
      let refPath: string;
      try {
        refPath = fileURLToPath(ref.uri);
      } catch {
        continue;
      }
      if (seenFiles.has(refPath)) continue;
      seenFiles.add(refPath);
      for (const record of records) unionDiags.push(...record.client.getDiagnostics(refPath));
    }
    const unionErrors = errorLevel(unionDiags);
    const clean = unionErrors.length === 0;

    // Precedence: lsp_unavailable (handled above) > diagnostics_timeout > refs_truncated > none.
    const degraded: DegradedReason =
      diag.lspStatus === "partial" ? "diagnostics_timeout" : truncated ? "refs_truncated" : "none";
    // safeToRename only when refs are complete, the union is clean, and nothing degraded (spec §27-31).
    const safeToRename = referencesComplete && clean && degraded === "none" && diag.lspStatus === "ok";

    return {
      references,
      diagnostics: diag.diagnostics,
      referencesComplete,
      safeToRename,
      clean,
      suggestedGuard: suggestedGuardFrom(unionErrors),
      degraded,
      lspStatus: diag.lspStatus,
      metadata: { tokenBudgetUsed: tokenBudget(Date.now() - t0, references.length) },
    };
  }

  async function lspMutationPreview(_filePath: string, _change: unknown): Promise<MutationPreviewResult> {
    // Fixed stub schema — no workspaceEdit, no apply path (spec §55-71).
    return { op: "allowlist", dryRunResult: { proposedEdits: [], tokenEstimate: 0 }, schemaVersion: "1.0" };
  }

  async function lspBeforeGrep(filePath: string, query?: string): Promise<PolicyAction> {
    const result = await impactOfChange(filePath, query);
    // Policy keys on lspStatus: grep fallback allowed unless the LSP was fully ok (spec §73-77).
    if (result.lspStatus !== "ok") {
      return { kind: "allow", reason: `LSP ${result.lspStatus}; fall back to grep` };
    }
    if (result.safeToRename) {
      return { kind: "allow", reason: "LSP ok and rename is safe" };
    }
    return { kind: "enrich", enrichWith: result };
  }

  return {
    touchFile,
    syncFile,
    query,
    close,
    waitForDiagnostics,
    impactOfChange,
    lspMutationPreview,
    lspBeforeGrep,
  };
}

class LspRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LSP request timed out after ${timeoutMs}ms`);
    this.name = "LspRequestTimeoutError";
  }
}

function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LspRequestTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getOperationMethod(operation: LspQueryInput["operation"]): string {
  switch (operation) {
    case "goToDefinition":
      return "textDocument/definition";
    case "findReferences":
      return "textDocument/references";
    case "hover":
      return "textDocument/hover";
    case "documentSymbol":
      return "textDocument/documentSymbol";
    case "workspaceSymbol":
      return "workspace/symbol";
    case "goToImplementation":
      return "textDocument/implementation";
    case "prepareCallHierarchy":
      return "textDocument/prepareCallHierarchy";
    case "incomingCalls":
    case "outgoingCalls":
      return "textDocument/prepareCallHierarchy";
    case "waitForDiagnostics":
      return "textDocument/diagnostic";
  }
}

function createOperationParams(input: LspQueryInput, absolutePath: string): Record<string, unknown> {
  const uri = pathToFileURL(absolutePath).href;
  const position = {
    line: (input.line ?? 1) - 1,
    character: (input.character ?? 1) - 1,
  };

  switch (input.operation) {
    case "goToDefinition":
    case "hover":
    case "goToImplementation":
    case "prepareCallHierarchy":
    case "incomingCalls":
    case "outgoingCalls":
      return {
        textDocument: { uri },
        position,
      };
    case "findReferences":
      return {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      };
    case "documentSymbol":
      return {
        textDocument: { uri },
      };
    case "workspaceSymbol":
      return {
        query: input.query ?? "",
      };
    case "waitForDiagnostics":
      return {
        textDocument: { uri },
      };
  }
}

export function summarizeLspDiagnostics(diagnostics: LspDiagnosticFile[]): string | null {
  const counts = diagnostics
    .flatMap((entry) => entry.diagnostics)
    .reduce(
      (acc, diagnostic) => {
        const severity = diagnostic.severity ?? 1;
        if (severity === 1) acc.errors += 1;
        else if (severity === 2) acc.warnings += 1;
        else acc.infos += 1;
        return acc;
      },
      { errors: 0, warnings: 0, infos: 0 },
    );

  const total = counts.errors + counts.warnings + counts.infos;
  if (total === 0) return null;

  const parts = [`${total} LSP issue${total === 1 ? "" : "s"}`];
  if (counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  if (counts.warnings > 0) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
  if (counts.infos > 0) parts.push(`${counts.infos} info`);
  return parts.join(" · ");
}
