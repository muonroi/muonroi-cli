const PAGE_SIZE = 10;

interface EvidenceRow {
  tool_call_id: string;
  session_id: string;
  tool_name: string;
  status: string;
  result_available: number;
  arguments_available: number;
}

/** Discovery returns references only. Content recovery still requires an exact ID. */
export async function listToolEvidence(
  sessionId: string | undefined,
  options: { query?: string; prefix?: string; chunkIndex?: number } = {},
) {
  if (!sessionId) throw new Error("Evidence discovery requires the current session binding.");
  const query = options.query ?? "";
  const page = options.chunkIndex ?? 0;
  if (typeof query !== "string" || query.length > 256)
    throw new Error("Evidence index query must be a string of at most 256 characters.");
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(page * PAGE_SIZE))
    throw new Error("Evidence index chunk_index must be a non-negative bounded integer.");
  const { getSessionChain } = await import("./index.js");
  const { getDatabase } = await import("./db.js");
  const chain = getSessionChain(sessionId);
  const params: (string | number)[] = [...chain, query, query, query, query];
  if (options.prefix !== undefined) params.push(options.prefix.length, options.prefix);
  const rows = chain.length
    ? (getDatabase()
        .prepare(`
    SELECT tc.tool_call_id, tc.session_id, tc.tool_name, tc.status,
      EXISTS(SELECT 1 FROM tool_results tr WHERE tr.tool_call_row_id=tc.id AND tr.output_json IS NOT NULL) AS result_available,
      (tc.args_json IS NOT NULL) AS arguments_available
    FROM tool_calls tc WHERE tc.session_id IN (${chain.map(() => "?").join(",")})
      AND (? = '' OR instr(tc.tool_call_id, ?) > 0 OR instr(tc.tool_name, ?) > 0 OR instr(COALESCE(tc.args_json, ''), ?) > 0)
      ${options.prefix !== undefined ? "AND substr(tc.tool_call_id, 1, ?) = ?" : ""}
    ORDER BY tc.id DESC LIMIT ? OFFSET ?
  `)
        .all(...params, PAGE_SIZE + 1, page * PAGE_SIZE) as EvidenceRow[])
    : [];
  return {
    view: "index",
    scope: "current_session_family",
    query,
    chunk_index: page,
    entries: rows.slice(0, PAGE_SIZE).map((row) => ({
      tool_call_id: row.tool_call_id,
      session_id: row.session_id,
      tool_name: row.tool_name,
      status: row.status,
      result_available: Boolean(row.result_available),
      arguments_available: Boolean(row.arguments_available),
      retrieve: { tool_call_id: row.tool_call_id },
    })),
    next_chunk_index: rows.length > PAGE_SIZE ? page + 1 : null,
    note: "References only; copy the complete tool_call_id for an exact read. A prefix match is not retrieved evidence. Worker raw artifacts use delegation_read with the host manifest jobId/toolCallId/resultVersion. EE is not required.",
  };
}
