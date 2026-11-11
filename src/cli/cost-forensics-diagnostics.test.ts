import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectCostForensics } from "./cost-forensics.js";

const fixture = vi.hoisted(() => ({ usage: [] as any[], logs: [] as any[], calls: [] as any[] }));
vi.mock("../storage/index.js", () => ({ getSessionChain: () => ["main", "child-a", "child-b"] }));
vi.mock("../storage/session-experience-store.js", () => ({ selectSessionExperience: () => null }));
vi.mock("../storage/db.js", () => ({
  getDatabasePath: () => "/fixture/.muonroi-cli/muonroi.db",
  getDatabase: () => ({
    transaction: (fn: () => unknown) => fn,
    prepare: (sql: string) => ({
      get: () =>
        sql.includes("FROM sessions")
          ? { id: "main", model: "fixture", created_at: "2026-10-15T08:00:00.000Z" }
          : undefined,
      all: (...args: any[]) => {
        fixture.calls.push({ sql, args });
        const until = args.find((x) => typeof x === "string" && /^2026-/.test(x)) ?? "9999";
        const logs = fixture.logs.filter((x) => x.created_at <= until);
        if (sql.includes("FROM usage_events")) return fixture.usage.filter((x) => x.created_at <= until);
        if (sql.includes("GROUP BY event_type"))
          return [...new Set(logs.map((x) => x.event_type))].map((event_type) => ({
            event_type,
            c: logs.filter((x) => x.event_type === event_type).length,
          }));
        if (sql.includes("FROM interaction_logs")) {
          const selected = logs.filter((x) =>
            sql.includes("event_type = 'error'")
              ? x.event_type === "error"
              : ["prompt_breakdown", "call_accounting"].includes(x.event_type),
          );
          const offset = typeof args.at(-1) === "number" ? args.at(-1) : 0;
          return [...selected].sort((a, b) => b.id - a.id).slice(offset, offset + 5);
        }
        return [];
      },
    }),
  }),
}));

const at = "2026-10-15T08:43:06.189Z";
beforeEach(() => {
  fixture.usage = [];
  fixture.logs = [];
  fixture.calls = [];
});

describe("cost forensics diagnostic evidence", () => {
  it("exposes bounded numeric tool schema rows without leaking schema content", () => {
    fixture.logs.push({
      id: 5,
      session_id: "main",
      event_type: "prompt_breakdown",
      created_at: at,
      metadata_json: JSON.stringify({
        contextStageSource: "observed",
        nativeToolsChars: 20,
        mcpToolsChars: 30,
        toolSchemas: Array.from({ length: 25 }, (_, i) => ({
          name: `mcp_fixture__tool${i}`,
          origin: "mcp",
          totalChars: i,
          inputSchemaChars: 10,
          description: "DO_NOT_LEAK_SCHEMA",
        })),
      }),
    });
    const row = collectCostForensics("main").requestMeasurements!.records[0]!;
    expect(row.contextStageSource).toBe("observed");
    expect(row.toolSchemasTotal).toBe(25);
    expect(row.toolSchemas).toHaveLength(5);
    expect(row.toolSchemas![0]!.totalChars).toBe(24);
    expect(row.components).toMatchObject({ nativeToolsChars: 20, mcpToolsChars: 30 });
    expect(JSON.stringify(row)).not.toContain("DO_NOT_LEAK_SCHEMA");
  });
  it("reports measurement kinds across the snapshot, independently of the selected page", () => {
    fixture.logs = Array.from({ length: 8 }, (_, id) => ({
      id,
      session_id: "main",
      event_type: id < 2 ? "prompt_breakdown" : "call_accounting",
      created_at: at,
      metadata_json: "{}",
    }));
    fixture.logs.push({
      id: 99,
      session_id: "main",
      event_type: "prompt_breakdown",
      created_at: "2026-10-15T10:00:00.000Z",
      metadata_json: "{}",
    });
    const result = collectCostForensics("main", { until: "2026-10-15T09:00:00.000Z", measurementOffset: 5 });
    expect(result.requestMeasurements).toMatchObject({
      total: 8,
      byKind: { "prepared-request": 2, "gate-accounting": 6 },
      offset: 5,
      nextOffset: null,
    });
    expect(result.requestMeasurements?.records).toHaveLength(3);
    expect(result.telemetry?.notes.join(" ")).toContain("messagesChars includes historyChars and toolResultsChars");
    expect(result.telemetry?.notes.join(" ")).toContain("Character lengths are measured");
  });

  it("exposes rejected requests separately from usage with source record and snapshot provenance", () => {
    fixture.logs.push({
      id: 58365,
      session_id: "child-b",
      event_type: "error",
      event_subtype: "api",
      model: null,
      created_at: at,
      metadata_json: JSON.stringify({
        message: "maximum context length is 262144; requested 411902 tokens; Bearer fixture-secret",
        forensics: { statusCode: 400, urlHost: "provider.invalid" },
      }),
    });
    const result = collectCostForensics("main", { until: "2026-10-15T09:00:00.000Z" });
    expect(result.totalInput).toBe(0);
    expect(result.rowCount).toBe(0);
    expect(result.requestMeasurements?.byKind).toEqual({ "prepared-request": 0, "gate-accounting": 0 });
    expect(result.errors?.records[0]).toMatchObject({ id: 58365, sessionId: "child-b", statusCode: 400 });
    expect(result.errors?.records[0].message).toContain("411902");
    expect(JSON.stringify(result.errors)).not.toContain("fixture-secret");
    expect(result.telemetry?.databasePath).toBe("/fixture/.muonroi-cli/muonroi.db");
    expect(result.telemetry?.sessionIds).toEqual(["main", "child-a", "child-b"]);
    expect(result.snapshot?.until).toBe("2026-10-15T09:00:00.000Z");
  });

  it("labels old gate estimates and missing schema measurements without inventing zeros", () => {
    fixture.logs.push({
      id: 3,
      session_id: "main",
      event_type: "call_accounting",
      event_subtype: "main",
      model: "fixture",
      created_at: at,
      metadata_json: JSON.stringify({
        estInputTokens: 382637,
        bySegment: { system: 69871, history: 33366, toolResults: 1427311 },
        ceiling: 256000,
      }),
    });
    const row = collectCostForensics("main").requestMeasurements?.records[0];
    expect(row).toMatchObject({ id: 3, kind: "gate-accounting", estimatedInputTokens: 382637 });
    expect(row?.components).toMatchObject({ systemChars: 69871, toolResultsChars: 1427311, toolSchemasChars: null });
  });

  it("returns new prepared-request measurements with exact record/call references", () => {
    fixture.logs.push({
      id: 4,
      session_id: "child-a",
      event_type: "prompt_breakdown",
      event_subtype: "prepared",
      model: "fixture",
      created_at: at,
      metadata_json: JSON.stringify({
        callId: "call-fixture",
        stepNumber: 2,
        systemChars: 100,
        messagesChars: 500,
        historyChars: 200,
        toolResultsChars: 300,
        toolsChars: 150,
        estimatedInputTokens: 250,
        contextStage: "verify",
        taskContextRevision: 2,
        taskContextChars: 100,
        taskHandoffChars: 20,
      }),
    });
    expect(collectCostForensics("main").requestMeasurements?.records[0]).toMatchObject({
      id: 4,
      sessionId: "child-a",
      callId: "call-fixture",
      stepNumber: 2,
      kind: "prepared-request",
      contextStage: "verify",
      taskContextRevision: 2,
      components: {
        historyChars: 200,
        toolResultsChars: 300,
        toolSchemasChars: 150,
        taskContextChars: 100,
        taskHandoffChars: 20,
      },
    });
  });

  it("paginates errors and bounds malicious messages while retaining totals", () => {
    fixture.logs = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      session_id: "main",
      event_type: "error",
      created_at: at,
      metadata_json: JSON.stringify({ message: "x".repeat(100000) }),
    }));
    const result = collectCostForensics("main", { errorOffset: 5 });
    expect(result.errors?.total).toBe(12);
    expect(result.errors?.records).toHaveLength(5);
    expect(result.errors?.nextOffset).toBe(10);
    expect(JSON.stringify(result.errors).length).toBeLessThan(8000);
  });

  it("filters usage and diagnostics with the same explicit cutoff", () => {
    fixture.usage = [at, "2026-10-15T10:00:00.000Z"].map((created_at, i) => ({
      id: i,
      source: "message",
      model: "fixture",
      created_at,
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_micros: 1,
    }));
    fixture.logs = fixture.usage.map((r) => ({ ...r, session_id: "main", event_type: "error", metadata_json: "{}" }));
    const result = collectCostForensics("main", { until: "2026-10-15T09:00:00.000Z", usageOffset: 0 });
    expect(result.totalInput).toBe(100);
    expect(result.errors?.total).toBe(1);
    expect(
      fixture.calls
        .filter((x) => x.sql.includes("FROM usage_events") || x.sql.includes("FROM interaction_logs"))
        .every((x) => x.args.includes(result.snapshot?.until)),
    ).toBe(true);
  });
});
