import type { FileResult } from "../tools/file.js";
import { WorkerWriteScope } from "../tools/worker-write-scope.js";
import { withFileLock } from "../utils/file-lock.js";
import { logger } from "../utils/logger.js";
import { loadDelegation } from "./delegations.js";

/** Serialize effect application with owner scope decisions; capture persistence runs outside this lock. */
export async function runScopedDelegationWrite(
  jobPath: string,
  operation: (scope: WorkerWriteScope) => Promise<FileResult>,
): Promise<FileResult> {
  try {
    return await withFileLock(jobPath, async () => {
      const record = await loadDelegation(jobPath);
      if (
        record.status !== "running" ||
        record.writeScope === undefined ||
        !record.writeScopeBinding ||
        !Number.isSafeInteger(record.writeScopeVersion)
      )
        throw new Error("Active host-bound file scope is unavailable; no write performed.");
      const result = await operation(new WorkerWriteScope(record.cwd, record.writeScope, record.writeScopeBinding));
      return { ...result, writeScopeVersion: record.writeScopeVersion };
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.file("warn", "orchestrator", "Scoped worker write authorization failed", { error });
    return { success: false, output: `worker_write_scope_refused: ${error} Ask main for an explicit scope decision.` };
  }
}
