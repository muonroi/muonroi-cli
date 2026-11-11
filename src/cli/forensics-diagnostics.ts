import { getDatabase, getDatabasePath } from "../storage/db.js";
import { logger, redactSecrets } from "../utils/logger.js";

export const FORENSICS_TOOL_DESCRIPTION =
  "Inspect CLI SQLite telemetry for a session prefix: recorded usage, failures (including rejected requests), source DB/record IDs, measurement counts by kind and available request components. Does not search repository application logs. Output is paginated; reuse snapshot.until with offsets to keep a stable cutoff. Estimates are not HTTP captures or provider billing tokens.";

export interface ForensicsOptions {
  until?: string;
  usageOffset?: number;
  errorOffset?: number;
  measurementOffset?: number;
}

interface DiagnosticRow {
  id: number;
  session_id: string;
  event_type: string;
  event_subtype: string | null;
  model: string | null;
  metadata_json: string | null;
  created_at: string;
}

export function forensicsCutoff(options: ForensicsOptions): string {
  for (const value of [options.usageOffset, options.errorOffset, options.measurementOffset]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Forensics offsets must be non-negative integers");
  }
  const date = options.until === undefined ? new Date() : new Date(options.until);
  if (!Number.isFinite(date.getTime())) throw new Error("Forensics until must be a valid timestamp");
  return date.toISOString();
}

function metadata(row: DiagnosticRow): Record<string, any> {
  try {
    const value = JSON.parse(row.metadata_json ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    logger.file("warn", "storage", "Invalid forensics diagnostic metadata", { id: row.id, error });
    return {};
  }
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function collectForensicsDiagnostics(
  sessionIds: string[],
  counts: Map<string, number>,
  until: string,
  options: ForensicsOptions,
) {
  const db = getDatabase();
  const placeholders = sessionIds.map(() => "?").join(",");
  const select = (predicate: string, offset: number) =>
    db
      .prepare(`
    SELECT id, session_id, event_type, event_subtype, model, metadata_json, created_at
    FROM interaction_logs WHERE session_id IN (${placeholders}) AND created_at <= ? AND ${predicate}
    ORDER BY id DESC LIMIT 5 OFFSET ?
  `)
      .all(...sessionIds, until, offset) as DiagnosticRow[];
  const errorOffset = options.errorOffset ?? 0;
  const errorRows = select("event_type = 'error'", errorOffset);
  const errors = errorRows.map((row) => {
    const m = metadata(row);
    const f = m.forensics && typeof m.forensics === "object" ? m.forensics : {};
    const raw =
      typeof m.message === "string"
        ? m.message
        : typeof m.error === "string"
          ? m.error
          : "No stored error message; inspect the referenced interaction record.";
    return {
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      subtype: row.event_subtype,
      model: row.model ? redactSecrets(row.model).slice(0, 200) : null,
      statusCode: number(f.statusCode),
      providerHost: typeof f.urlHost === "string" ? redactSecrets(f.urlHost).slice(0, 160) : null,
      message: redactSecrets(raw).slice(0, 800),
      messageTruncated: raw.length > 800,
    };
  });
  const measurementOffset = options.measurementOffset ?? 0;
  const measurementRows = select("event_type IN ('prompt_breakdown', 'call_accounting')", measurementOffset);
  const measurements = measurementRows.map((row) => {
    const m = metadata(row);
    const segment = m.bySegment && typeof m.bySegment === "object" ? m.bySegment : {};
    return {
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      model: row.model ? redactSecrets(row.model).slice(0, 200) : null,
      kind: row.event_type === "prompt_breakdown" ? "prepared-request" : "gate-accounting",
      callId: typeof m.callId === "string" ? m.callId.slice(0, 128) : null,
      stepNumber: number(m.stepNumber),
      estimator:
        row.event_type === "prompt_breakdown" ? "proxy tokenizer; prepared text" : "chars/4; provider prompt text",
      estimatedInputTokens: number(m.estimatedInputTokens) ?? number(m.estInputTokens),
      contextWindowTokens: number(m.contextWindowTokens) ?? number(m.ceiling),
      reservedOutputTokens: number(m.reservedOutputTokens),
      contextStage: ["orient", "research", "plan", "implement", "verify"].includes(m.contextStage)
        ? m.contextStage
        : null,
      contextStageSource: ["initial", "observed", "explicit"].includes(m.contextStageSource)
        ? m.contextStageSource
        : null,
      taskContextRevision: number(m.taskContextRevision),
      toolSchemas: Array.isArray(m.toolSchemas)
        ? m.toolSchemas
            .filter((t: any) => t && typeof t.name === "string")
            .sort((a: any, b: any) => (number(b.totalChars) ?? 0) - (number(a.totalChars) ?? 0))
            .slice(0, 5)
            .map((t: any) => ({
              name: redactSecrets(t.name).slice(0, 160),
              origin: ["native", "mcp"].includes(t.origin) ? t.origin : null,
              nameChars: number(t.nameChars),
              descriptionChars: number(t.descriptionChars),
              inputSchemaChars: number(t.inputSchemaChars),
              totalChars: number(t.totalChars),
              estimatedTokens: number(t.estimatedTokens),
              schemaMeasured: typeof t.schemaMeasured === "boolean" ? t.schemaMeasured : null,
            }))
        : null,
      toolSchemasTotal: Array.isArray(m.toolSchemas) ? m.toolSchemas.length : null,
      components: {
        systemChars: number(m.systemChars) ?? number(segment.system),
        historyChars: number(m.historyChars) ?? number(segment.history),
        toolResultsChars: number(m.toolResultsChars) ?? number(segment.toolResults),
        messagesChars: number(m.messagesChars),
        toolSchemasChars: number(m.toolsChars),
        nativeToolsChars: number(m.nativeToolsChars),
        mcpToolsChars: number(m.mcpToolsChars),
        taskContextChars: number(m.taskContextChars),
        taskHandoffChars: number(m.taskHandoffChars),
        systemContractChars: number(m.systemContractChars),
        systemNativeChars: number(m.systemNativeChars),
        systemModeChars: number(m.systemModeChars),
        systemCustomChars: number(m.systemCustomChars),
        systemSkillsChars: number(m.systemSkillsChars),
        systemSubagentsChars: number(m.systemSubagentsChars),
      },
    };
  });
  const errorTotal = counts.get("error") ?? 0;
  const byKind = {
    "prepared-request": counts.get("prompt_breakdown") ?? 0,
    "gate-accounting": counts.get("call_accounting") ?? 0,
  };
  const measurementTotal = byKind["prepared-request"] + byKind["gate-accounting"];
  return {
    telemetry: {
      databasePath: getDatabasePath(),
      sessionIds,
      usageTable: "usage_events",
      diagnosticsTable: "interaction_logs",
      notes: [
        "These are CLI SQLite records, not application/build/test logs in the working repository.",
        "Usage totals span recorded events and included sessions; event sources can aggregate model steps. Peak usage events do not bound rejected requests.",
        "Errors are separate evidence, not additional consumed tokens. Stored costs are CLI estimates, not provider invoices.",
        "Request measurements are estimates at different layers, not HTTP captures or provider token counts. Do not add them as separate requests; missing components are null, not zero.",
        "Measurement byKind counts cover the selected session family and snapshot, not just this page. Legacy gate-accounting records lack newer prepared-request fields; absent historical fields cannot be reconstructed from these records.",
        "Character lengths are measured at the labeled CLI layer; tokens and costs are estimates. messagesChars includes historyChars and toolResultsChars: do not add it to those components. Disjoint text components are systemChars, historyChars, toolResultsChars and toolSchemasChars; character shares are not token or billing shares.",
        "Tool inventory describes availability, not the tool schemas sent on a particular request. A recorded 429 alone does not establish exhausted credit or identify the counter reached.",
        "System section counts are parts of the static prefix, not additional input. taskContextChars is included in message text; taskHandoffChars is part of taskContextChars. Do not add these nested counts again. Stage labels select guidance, not edit authorization.",
        "Per-tool schemas contain numeric estimates only. Origin groups use the mcp_ naming convention; they are not billing attribution. The largest 5 tool rows are shown per measurement; toolSchemasTotal states the full stored count. Native/MCP totals include names and descriptions, and sum to toolSchemasChars. Observed stage changes follow successful known native tools; explicit stage selection overrides observation.",
      ],
    },
    errors: {
      total: errorTotal,
      offset: errorOffset,
      nextOffset: errorOffset + errors.length < errorTotal ? errorOffset + errors.length : null,
      records: errors,
    },
    requestMeasurements: {
      total: measurementTotal,
      byKind,
      offset: measurementOffset,
      nextOffset:
        measurementOffset + measurements.length < measurementTotal ? measurementOffset + measurements.length : null,
      records: measurements,
    },
  };
}

export type ForensicsDiagnostics = ReturnType<typeof collectForensicsDiagnostics>;
