import { existsSync } from "fs";
import path from "path";
import { getCurrentLspSettings } from "../utils/settings";
import { createWorkspaceLspManager, summarizeLspDiagnostics, type WorkspaceLspManager } from "./manager";
import type {
  ImpactOfChangeResult,
  LspDiagnosticFile,
  LspQueryInput,
  LspQueryResult,
  LspToolResponse,
  MutationPreviewResult,
} from "./types";

const managers = new Map<string, WorkspaceLspManager>();

export async function queryLsp(cwd: string, input: LspQueryInput): Promise<LspToolResponse> {
  const manager = getOrCreateManager(cwd);
  return manager.query({
    ...input,
    filePath: path.isAbsolute(input.filePath) ? input.filePath : path.resolve(cwd, input.filePath),
  });
}

// Default timeout (ms) when a caller omits one. manager.waitForDiagnostics now
// takes a REQUIRED timeout (Sprint-1 readiness contract, commit 4af6efb1) and no
// longer defaults internally, so the public wrapper supplies the documented 1500ms.
const DEFAULT_WAIT_DIAGNOSTICS_MS = 1500;

export async function waitForDiagnosticsLsp(cwd: string, filePath: string, timeout?: number): Promise<LspQueryResult> {
  const manager = getOrCreateManager(cwd);
  return manager.waitForDiagnostics(
    path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath),
    timeout ?? DEFAULT_WAIT_DIAGNOSTICS_MS,
  );
}

export async function impactOfChangeLsp(cwd: string, filePath: string, query?: string): Promise<ImpactOfChangeResult> {
  const manager = getOrCreateManager(cwd);
  return manager.impactOfChange(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath), query);
}

export async function lspMutationPreview(
  cwd: string,
  filePath: string,
  change: string,
): Promise<MutationPreviewResult> {
  const manager = getOrCreateManager(cwd);
  return manager.lspMutationPreview(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath), change);
}

export async function syncFileWithLsp(
  cwd: string,
  filePath: string,
  content: string,
  save = true,
  waitForDiagnostics = true,
  diagnosticsTimeoutMs?: number,
): Promise<LspDiagnosticFile[]> {
  const manager = getOrCreateManager(cwd);
  return manager.syncFile(
    path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath),
    content,
    save,
    waitForDiagnostics,
    diagnosticsTimeoutMs,
  );
}

export function isLspToolEnabled(_cwd: string): boolean {
  const settings = getCurrentLspSettings();
  return settings.enabled && settings.tool;
}

export function summarizeDiagnostics(diagnostics: LspDiagnosticFile[]): string | null {
  return summarizeLspDiagnostics(diagnostics);
}

export async function shutdownWorkspaceLspManager(cwd: string): Promise<void> {
  const key = resolveManagerKey(cwd);
  const manager = managers.get(key);
  if (!manager) return;
  managers.delete(key);
  await manager.close();
}

export function getOrCreateManager(cwd: string): WorkspaceLspManager {
  const key = resolveManagerKey(cwd);
  const existing = managers.get(key);
  if (existing) return existing;

  const manager = createWorkspaceLspManager(key, getCurrentLspSettings());
  managers.set(key, manager);
  return manager;
}

function resolveManagerKey(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".muonroi-cli")) || existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
