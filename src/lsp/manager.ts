import { readFile } from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { createRuntimeLspDefinitions, type RuntimeLspServerDefinition } from "./builtins";
import { createLspClientSession, type LspClientSession } from "./client";
import type {
  ImpactOfChangeResult,
  LspDiagnostic,
  LspDiagnosticFile,
  LspLocation,
  LspQueryInput,
  LspQueryResult,
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

  const createClient =
    options.createClient ??
    (async ({ serverId, root, definition, settings: normalizedSettings }) => {
      const launch = await definition.resolveLaunch(root, normalizedSettings);
      if (!launch?.command) return null;
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
        } catch {
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

  // ── Sprint 1: readiness contract methods ──────────────────────────────────

  async function waitForDiagnostics(filePath: string, timeout: number): Promise<LspQueryResult> {
    const clampedTimeout = Math.min(Math.max(timeout, 0), 5000);
    const records = await getClientsForFile(filePath);
    if (records.length === 0) {
      return { diagnostics: [], readiness: "partial", fallbackRecommended: true };
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
          // Fall back to whatever diagnostics the client already has
          const stale = record.client.getDiagnostics(filePath);
          allDiagnostics.push(...stale);
        } else {
          anyFailed = true;
        }
      }
    }

    let readiness: LspQueryResult["readiness"];
    if (anyTimedOut) {
      readiness = "timed_out";
    } else if (anyFailed || allDiagnostics.length === 0) {
      readiness = "partial";
    } else {
      readiness = "ready";
    }

    return {
      diagnostics: allDiagnostics,
      readiness,
      fallbackRecommended: readiness !== "ready",
    };
  }

  async function impactOfChange(filePath: string, _query?: string, timeout?: number): Promise<ImpactOfChangeResult> {
    const diagnosticResult = await waitForDiagnostics(filePath, timeout ?? 1500);
    const records = await getClientsForFile(filePath);
    const references: LspLocation[] = [];

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
              references.push({
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

    // safeToRename: true when no conflicting references exist beyond the file itself
    const selfUri = pathToFileURL(path.resolve(filePath)).href;
    const externalRefs = references.filter((ref) => ref.uri !== selfUri);
    const safeToRename = externalRefs.length === 0;

    return {
      diagnostics: diagnosticResult.diagnostics,
      references,
      safeToRename,
      readiness: diagnosticResult.readiness,
      fallbackRecommended: diagnosticResult.fallbackRecommended,
    };
  }

  async function lspMutationPreview(_filePath: string, _change: unknown): Promise<MutationPreviewResult> {
    return { preview: [] };
  }

  async function lspBeforeGrep(filePath: string, query?: string): Promise<PolicyAction> {
    const result = await impactOfChange(filePath, query);
    if (result.fallbackRecommended) {
      return { kind: "allow", reason: "LSP not ready; fall back to grep" };
    }
    if (result.safeToRename) {
      return { kind: "allow", reason: "LSP ready and safe" };
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
