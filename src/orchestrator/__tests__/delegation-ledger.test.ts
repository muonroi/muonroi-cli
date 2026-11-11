import { describe, expect, it } from "vitest";
import {
  createDelegationLedgerMessage,
  DELEGATION_LEDGER_HEADER,
  DELEGATION_LEDGER_MAX_ENTRIES,
  formatDelegationLedger,
  isDelegationLedgerMessage,
} from "../delegation-ledger.js";
import type { DelegationLedgerEntry } from "../delegations.js";

const NOW = new Date("2026-11-04T02:09:26.793Z");

function running(id: string, startedAt: string, extra: Partial<DelegationLedgerEntry> = {}): DelegationLedgerEntry {
  return {
    id,
    agent: "general",
    description: `work for ${id}`,
    status: "running",
    startedAt,
    acknowledged: false,
    ...extra,
  };
}

describe("formatDelegationLedger", () => {
  it("carries a running job verbatim (session 4edc02516a92 steady-ivory-panda shape)", () => {
    const text = formatDelegationLedger(
      [
        running("steady-ivory-panda", "2026-11-04T02:07:34.000Z", {
          description: "Wave 2: Docs engine TCIS.MCP.Docs + unit tests",
          writeScope: ["src/TCIS.MCP.Docs/**", "tests/TCIS.MCP.Docs.Tests/**"],
          pendingQuestionId: "msg-7",
        }),
      ],
      { now: NOW },
    )!;
    expect(text.startsWith(DELEGATION_LEDGER_HEADER)).toBe(true);
    expect(text).toContain("2026-11-04T02:09:26.793Z");
    expect(text).toContain(
      '- jobId=steady-ivory-panda agent=general startedAt=2026-11-04T02:07:34.000Z writeScope=["src/TCIS.MCP.Docs/**","tests/TCIS.MCP.Docs.Tests/**"] pendingQuestion messageId=msg-7 — Wave 2: Docs engine TCIS.MCP.Docs + unit tests',
    );
    expect(text).toContain("do NOT dispatch another worker");
    expect(text).toContain("delegation_list");
  });

  it("labels an unscoped worker explicitly", () => {
    const text = formatDelegationLedger([running("calm-blue-panda", "2026-11-04T01:00:00.000Z")], { now: NOW })!;
    expect(text).toContain("writeScope=unscoped");
  });

  it("lists finished-but-unacknowledged results with their resultVersion, and omits acknowledged ones", () => {
    const text = formatDelegationLedger(
      [
        { ...running("done-a", "2026-11-04T01:00:00.000Z"), status: "complete", resultVersion: "v-a" },
        { ...running("failed-b", "2026-11-04T01:01:00.000Z"), status: "error", resultVersion: "v-b" },
        {
          ...running("acked-c", "2026-11-04T01:02:00.000Z"),
          status: "complete",
          resultVersion: "v-c",
          acknowledged: true,
        },
      ],
      { now: NOW },
    )!;
    expect(text).toContain("Running (0)");
    expect(text).toContain("- none");
    expect(text).toContain("- jobId=done-a agent=general status=complete resultVersion=v-a");
    expect(text).toContain("- jobId=failed-b agent=general status=error resultVersion=v-b");
    expect(text).not.toContain("acked-c");
  });

  it("returns null when nothing is live (empty registry, or only acknowledged/legacy unversioned results)", () => {
    expect(formatDelegationLedger([], { now: NOW })).toBeNull();
    expect(
      formatDelegationLedger(
        [
          {
            ...running("acked", "2026-11-04T01:00:00.000Z"),
            status: "complete",
            resultVersion: "v",
            acknowledged: true,
          },
          { ...running("legacy", "2026-11-04T01:00:00.000Z"), status: "complete" },
        ],
        { now: NOW },
      ),
    ).toBeNull();
  });

  it("caps entries, prioritises running jobs, and tails with the omitted count", () => {
    const entries: DelegationLedgerEntry[] = [];
    for (let i = 0; i < 20; i++)
      entries.push(running(`run-${String(i).padStart(2, "0")}`, `2026-11-04T01:${String(i).padStart(2, "0")}:00.000Z`));
    for (let i = 0; i < 5; i++)
      entries.push({
        ...running(`done-${i}`, `2026-11-04T00:0${i}:00.000Z`),
        status: "complete",
        resultVersion: `v${i}`,
      });
    const text = formatDelegationLedger(entries, { now: NOW })!;
    const jobLines = text.split("\n").filter((l) => l.startsWith("- jobId="));
    expect(jobLines).toHaveLength(DELEGATION_LEDGER_MAX_ENTRIES);
    expect(jobLines.every((l) => l.includes("jobId=run-"))).toBe(true);
    expect(text).toContain("Running (20)");
    expect(text).toContain(`… ${20 + 5 - DELEGATION_LEDGER_MAX_ENTRIES} more — call delegation_list.`);
    // Oldest running first.
    expect(jobLines[0]).toContain("jobId=run-00");
  });

  it("bounds long descriptions and write scopes", () => {
    const text = formatDelegationLedger(
      [
        running("wide", "2026-11-04T01:00:00.000Z", {
          description: "x".repeat(5000),
          writeScope: Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`),
        }),
      ],
      { now: NOW },
    )!;
    expect(text.length).toBeLessThan(1200);
    expect(text).toContain("(+34 more)");
  });

  it("round-trips through the ledger message predicate", () => {
    const msg = createDelegationLedgerMessage(formatDelegationLedger([running("a", "2026-11-04T01:00:00.000Z")])!);
    expect(msg.role).toBe("system");
    expect(isDelegationLedgerMessage(msg)).toBe(true);
    expect(isDelegationLedgerMessage({ role: "system", content: "[Context checkpoint summary]\nx" })).toBe(false);
    expect(isDelegationLedgerMessage({ role: "user", content: DELEGATION_LEDGER_HEADER })).toBe(false);
  });
});
