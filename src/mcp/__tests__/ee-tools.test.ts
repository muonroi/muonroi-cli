import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecallLedger, sessionRecallLedger } from "../../ee/recall-ledger.js";
import { registerEETools } from "../ee-tools.js";

// Minimal harness: register tools onto a real McpServer, then invoke a tool's
// handler by reaching into the registered tool. We test the handler via the
// public callTool path using an in-process client would be heavier; instead we
// capture handlers through a thin fake that records registrations.
function collectTools(register: (s: McpServer) => void) {
  const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
  const fake = {
    registerTool(name: string, _def: unknown, handler: (args: unknown) => Promise<unknown>) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  register(fake);
  return handlers;
}

function textOf(result: unknown): unknown {
  // result is { content: [{ type:"text", text }], isError? }
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { json: JSON.parse(r.content[0]!.text), isError: r.isError };
}
function rawTextOf(result: unknown): { text: string; isError?: boolean } {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError };
}

describe("ee-tools", () => {
  // Isolate the process-singleton ledger + gate env between tests so default-ledger
  // tests never inherit pending debt or a gate mode from a prior test.
  beforeEach(() => {
    sessionRecallLedger.reset();
    delete process.env.EXPERIENCE_RECALL_FEEDBACK_GATE;
    delete process.env.EXPERIENCE_RECALL_FEEDBACK_THRESHOLD;
  });
  afterEach(() => {
    sessionRecallLedger.reset();
    delete process.env.EXPERIENCE_RECALL_FEEDBACK_GATE;
    delete process.env.EXPERIENCE_RECALL_FEEDBACK_THRESHOLD;
  });

  it("ee_query returns the compact recall index (raw text + count footer, not JSON)", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async (q) => ({
          text: `recall:${q} [id:abc col:experience-behavioral]`,
          entries: [{ id: "abc", collection: "experience-behavioral" }],
          count: 1,
        }),
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    const out = rawTextOf(await handlers["ee_query"]!({ query: "redactor" }));
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("recall:redactor");
    expect(out.text).toContain("[id:abc col:experience-behavioral]"); // handle preserved for exp-feedback
    expect(out.text).toContain("[recall: 1 entries"); // count footer
    expect(() => JSON.parse(out.text)).toThrow(); // no longer a JSON dump
  });

  it("ee_query caps an oversized recall index so it cannot overflow the MCP token cap", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async () => ({ text: "x".repeat(50_000), entries: [], count: 42 }),
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    const out = rawTextOf(await handlers["ee_query"]!({ query: "wide", maxChars: 6000 }));
    expect(out.isError).toBeFalsy();
    expect(out.text.length).toBeLessThan(7000); // capped, not the full 50k dump
    expect(out.text).toContain("truncated");
    expect(out.text).toContain("42 entries");
  });

  it("ee_query forwards the project scope to recall", async () => {
    let seenProject: string | undefined;
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async (_q, o) => {
          seenProject = o.project;
          return { text: null, entries: [], count: 0 };
        },
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    await handlers["ee_query"]!({ query: "scope filter", project: "storyflow" });
    expect(seenProject).toBe("storyflow");
  });

  it("ee_query returns ee_unavailable when recall yields null", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { recall: async () => null, health: async () => ({ ok: false, status: 0 }) }),
    );
    const out = textOf(await handlers["ee_query"]!({ query: "x" })) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ee_unavailable");
  });

  it("ee_health returns the injected status", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { recall: async () => null, health: async () => ({ ok: true, status: 200 }) }),
    );
    const out = textOf(await handlers["ee_health"]!({})) as { json: { ok: boolean; status: number } };
    expect(out.json).toEqual({ ok: true, status: 200 });
  });

  it("ee_health returns ee_unavailable when health throws", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, {
        recall: async () => null,
        health: async () => {
          throw new Error("boom");
        },
      }),
    );
    const out = textOf(await handlers["ee_health"]!({})) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("ee_unavailable");
  });

  // ─── feedback gate (Layer 2) + ee_feedback (Layer 1) ───────────────────────

  it("ee_feedback maps followed→FOLLOWED, clears the ledger debt, reports remaining", async () => {
    const ledger = createRecallLedger();
    ledger.record([{ id: "abc", collection: "experience-behavioral" }], "redactor");
    expect(ledger.pendingCount()).toBe(1);
    let seen: { id: string; collection: string; verdict: string; reason?: string } | null = null;
    const handlers = collectTools((s) =>
      registerEETools(s, {
        ledger,
        feedback: async (id, collection, verdict, reason) => {
          seen = { id, collection, verdict, reason };
          return { ok: true, resolvedId: id, verdict: verdict === "followed" ? "FOLLOWED" : verdict };
        },
      }),
    );
    const out = textOf(
      await handlers["ee_feedback"]!({ id: "abc", collection: "experience-behavioral", verdict: "followed" }),
    ) as { json: { ok: boolean; pendingRemaining: number }; isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(seen).toEqual({ id: "abc", collection: "experience-behavioral", verdict: "followed", reason: undefined });
    expect(out.json.ok).toBe(true);
    expect(out.json.pendingRemaining).toBe(0); // debt cleared
    expect(ledger.pendingCount()).toBe(0);
  });

  it("ee_feedback requires a reason for verdict=noise", async () => {
    const handlers = collectTools((s) => registerEETools(s, { feedback: async () => ({ ok: true }) }));
    const out = textOf(
      await handlers["ee_feedback"]!({ id: "x", collection: "experience-selfqa", verdict: "noise" }),
    ) as { json: { error?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("reason_required");
  });

  it("ee_feedback surfaces a feedback_failed error and keeps the debt unrated", async () => {
    const ledger = createRecallLedger();
    ledger.record([{ id: "abc", collection: "experience-behavioral" }], "q");
    const handlers = collectTools((s) =>
      registerEETools(s, { ledger, feedback: async () => ({ ok: false, error: "HTTP 500" }) }),
    );
    const out = textOf(
      await handlers["ee_feedback"]!({ id: "abc", collection: "experience-behavioral", verdict: "ignored" }),
    ) as { json: { error?: string; message?: string }; isError?: boolean };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("feedback_failed");
    expect(ledger.pendingCount()).toBe(1); // NOT cleared on failure
  });

  it("ee_query soft gate: a later recall is prefixed with the prior unrated debt", async () => {
    const ledger = createRecallLedger();
    const handlers = collectTools((s) =>
      registerEETools(s, {
        ledger,
        recall: async (q) => ({
          text: `recall:${q} [id:dup col:experience-behavioral]`,
          entries: [{ id: q === "first" ? "id1" : "id2", collection: "experience-behavioral" }],
          count: 1,
        }),
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    // First recall — no prior debt, so no gate prefix.
    const first = rawTextOf(await handlers["ee_query"]!({ query: "first" }));
    expect(first.text).not.toContain("still unrated");
    expect(ledger.pendingCount()).toBe(1);
    // Second recall — the prior id1 is still unrated → soft prefix, but recall still returned.
    const second = rawTextOf(await handlers["ee_query"]!({ query: "second" }));
    expect(second.isError).toBeFalsy();
    expect(second.text).toContain("still unrated");
    expect(second.text).toContain("id1");
    expect(second.text).toContain("recall:second"); // the actual recall is still delivered
    expect(ledger.pendingCount()).toBe(2);
  });

  it("ee_query hard gate: refuses a new recall once unrated debt hits the threshold", async () => {
    process.env.EXPERIENCE_RECALL_FEEDBACK_GATE = "hard";
    process.env.EXPERIENCE_RECALL_FEEDBACK_THRESHOLD = "2";
    const ledger = createRecallLedger();
    ledger.record(
      [
        { id: "a", collection: "experience-behavioral" },
        { id: "b", collection: "experience-selfqa" },
      ],
      "earlier",
    );
    let recallCalled = false;
    const handlers = collectTools((s) =>
      registerEETools(s, {
        ledger,
        recall: async () => {
          recallCalled = true;
          return { text: "should not run", entries: [], count: 0 };
        },
      }),
    );
    const out = textOf(await handlers["ee_query"]!({ query: "blocked" })) as {
      json: { error?: string; message?: string };
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("feedback_required");
    expect(out.json.message).toContain("FEEDBACK GATE");
    expect(recallCalled).toBe(false); // brain call NOT spent while debt unpaid
  });

  it("ee_query gate=off disables the ledger entirely", async () => {
    process.env.EXPERIENCE_RECALL_FEEDBACK_GATE = "off";
    const ledger = createRecallLedger();
    const handlers = collectTools((s) =>
      registerEETools(s, {
        ledger,
        recall: async (q) => ({
          text: `r:${q}`,
          entries: [{ id: "z", collection: "experience-behavioral" }],
          count: 1,
        }),
        health: async () => ({ ok: true, status: 200 }),
      }),
    );
    await handlers["ee_query"]!({ query: "one" });
    await handlers["ee_query"]!({ query: "two" });
    expect(ledger.pendingCount()).toBe(0); // nothing stamped when gate is off
  });

  // ─── ee_write (Layer 1 — agent records a new lesson) ───────────────────────

  it("ee_write forwards the lesson to the write helper and returns the new id", async () => {
    let seen: { lesson: string; opts: { collection?: string; title?: string; projectSlug?: string } } | null = null;
    const handlers = collectTools((s) =>
      registerEETools(s, {
        write: async (lesson, opts) => {
          seen = { lesson, opts };
          return { ok: true, id: "new-point-1" };
        },
      }),
    );
    const out = textOf(
      await handlers["ee_write"]!({
        lesson: "always call flushFrob() before reindex or reads go stale",
        title: "reindex pitfall",
        project: "experience-engine",
      }),
    ) as { json: { ok: boolean; id?: string; collection?: string }; isError?: boolean };
    expect(out.isError).toBeFalsy();
    expect(out.json.ok).toBe(true);
    expect(out.json.id).toBe("new-point-1");
    expect(out.json.collection).toBe("experience-behavioral");
    expect(seen!.lesson).toContain("flushFrob");
    expect(seen!.opts.collection).toBe("experience-behavioral");
    expect(seen!.opts.projectSlug).toBe("experience-engine");
  });

  it("ee_write surfaces write_failed when the write helper fails", async () => {
    const handlers = collectTools((s) =>
      registerEETools(s, { write: async () => ({ ok: false, error: "import-memory HTTP 500" }) }),
    );
    const out = textOf(await handlers["ee_write"]!({ lesson: "a sufficiently long lesson body here" })) as {
      json: { error?: string };
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.json.error).toBe("write_failed");
  });
});
