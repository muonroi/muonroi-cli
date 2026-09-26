/**
 * Controlled run (real SQLite, current code) closing the loop on the sub-session
 * review: WHEN SPAWN_SUB_SESSION fires, does the parent context actually stay
 * lean, i.e. does the child get kind="subagent" and does absorption copy ONLY
 * the final outcome back to the parent while the heavy intermediate tool clutter
 * stays isolated in the child?
 *
 * Unlike sub-session-delegation.test.ts (which mocks all of storage), this test
 * runs the REAL SessionStore + real better-sqlite3 DB against a temp HOME so the
 * kind/parent_session_id and persisted messages are observed on disk, on current
 * orchestrator code. Only the model, the router classifier, and MessageProcessor
 * (the turn body) are mocked — the session forking + absorption paths are real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMockModel, textOnlyStream } from "../../agent-harness/mock-model.js";
import { loadCatalog } from "../../models/registry.js";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { appendMessages, buildChatEntries } from "../../storage/transcript.js";
import { Agent } from "../orchestrator.js";
import type { ModelTaskKind } from "../sub-agent-model-tier.js";

// A single 50 KB intermediate tool result — the "clutter" a read-heavy turn (13
// read_file calls) accumulates. The whole point of delegation is that THIS never
// reaches the parent.
const CLUTTER = "CLUTTER_" + "X".repeat(50_000);
const FINAL_OUTCOME = "FINAL structured outcome for the parent";

// Force the router to choose SPAWN_SUB_SESSION (the path under test).
const mockClassify = vi.fn();
// Round 4 (G9): relatedness classifier for the resume-vs-fork decision.
// Defaults to "related" so every PRE-EXISTING test in this file (none of
// which exercise a resume — each SPAWN test makes exactly one
// processMessage() call, so `activeSubSession` is never found) is
// unaffected; G9's own tests override this per-case.
const mockRelatedness = vi.fn().mockResolvedValue({ related: true, confidence: 0.9, reason: "same task" });
vi.mock("../../pil/llm-classify.js", () => ({
  classifySubSessionAction: (...a: unknown[]) => (mockClassify as (...x: unknown[]) => unknown)(...a),
  classifySubSessionRelatedness: (...a: unknown[]) => (mockRelatedness as (...x: unknown[]) => unknown)(...a),
}));

// Round 3 (MEDIUM correction to G3 HIGH): spies on every `resolveModelForTask`
// call, recording exactly which `opts.pinned` value orchestrator.ts's
// `_resolveModelForTask` passed for each task kind — deterministic and
// independent of what the loaded model catalog actually offers per
// provider/tier (a real-catalog behavioural-difference assertion would be
// vacuous whenever no cheaper same-provider tier happens to exist). Delegates
// to the REAL implementation so every other behaviour (parentTier ceiling,
// tier-walk, fallback) stays exactly as-is; only the call is observed.
const capturedResolveModelForTaskCalls: Array<{ task: string; pinned: boolean | undefined }> = [];
vi.mock("../sub-agent-model-tier.js", async () => {
  const actual = await vi.importActual<typeof import("../sub-agent-model-tier.js")>("../sub-agent-model-tier.js");
  return {
    ...actual,
    resolveModelForTask: (
      task: string,
      providerId: string,
      fallbackModelId: string,
      lookup?: unknown,
      opts?: { parentTier?: string; pinned?: boolean },
    ) => {
      capturedResolveModelForTaskCalls.push({ task, pinned: opts?.pinned });
      return (
        actual.resolveModelForTask as (
          task: string,
          providerId: string,
          fallbackModelId: string,
          lookup?: unknown,
          opts?: unknown,
        ) => string
      )(task, providerId, fallbackModelId, lookup, opts);
    },
  };
});

// Per-test knob: the cumulative tool-output chars the (mocked) turn reports to
// the Agent, driving reactive next-turn escalation. 0 = light turn.
let reportedLoad = 0;

// Round 2 (G3 HIGH): captures the `modelId` MessageProcessor was actually
// constructed with, per invocation (one per turn — parent OR child), so a
// test can assert a project model pin propagates into the CHILD session's
// own turn, not just its `sessions` table row. Reset per test in beforeEach.
const capturedTurnModelIds: Array<{ sessionId: string | undefined; modelId: string | undefined }> = [];

// Simulate a read-heavy turn: write intermediate clutter to the CHILD session
// (real DB), and leave [.., final assistant, final tool] in the in-memory working
// set so the orchestrator's salvage step can absorb the outcome to the parent.
vi.mock("../message-processor.js", () => ({
  MessageProcessor: class {
    private deps: {
      messages: unknown[];
      session?: { id: string };
      reportTurnToolLoad?: (n: number) => void;
      modelId?: string;
    };
    constructor(deps: {
      messages: unknown[];
      session?: { id: string };
      reportTurnToolLoad?: (n: number) => void;
      modelId?: string;
    }) {
      this.deps = deps;
      capturedTurnModelIds.push({ sessionId: deps.session?.id, modelId: deps.modelId });
    }
    async *run() {
      this.deps.reportTurnToolLoad?.(reportedLoad);
      const childId = this.deps.session?.id;
      if (childId) {
        // The real MessageProcessor persists to whatever session is running —
        // during a fork that is the CHILD. So the heavy tool clutter AND the
        // final answer both land here; only the answer is absorbed to the parent.
        appendMessages(childId, [
          { role: "assistant", content: "intermediate analysis step" },
          { role: "tool", content: CLUTTER },
          { role: "assistant", content: FINAL_OUTCOME },
        ] as never);
      }
      // In-memory working set the salvage step reads: clutter + final outcome.
      this.deps.messages.push(
        { role: "assistant", content: "intermediate analysis step" },
        { role: "tool", content: CLUTTER },
        { role: "assistant", content: FINAL_OUTCOME },
        { role: "tool", content: "final tool result (small)" },
      );
      yield { type: "content", content: "done" };
    }
  },
}));

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let uninstallModel: (() => void) | null = null;

beforeAll(async () => {
  await loadCatalog();
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-subsess-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.MUONROI_FORCE_ROUTING_CLASSIFY = "1";
  reportedLoad = 0;
  capturedTurnModelIds.length = 0;
  capturedResolveModelForTaskCalls.length = 0;
  closeDatabase();
  getDatabase(); // run migrations against the temp DB
  vi.clearAllMocks();
  uninstallModel = installMockModel({ fixture: { stream: textOnlyStream("ignored") } }).uninstall;
});

afterEach(() => {
  uninstallModel?.();
  delete process.env.MUONROI_FORCE_ROUTING_CLASSIFY;
  closeDatabase();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("sub-session SPAWN on real SQLite — labeling + absorption + parent leanness", () => {
  it("creates a kind='subagent' child, isolates 50KB clutter in it, and absorbs ONLY the outcome to a lean parent", async () => {
    mockClassify.mockResolvedValue({ action: "SPAWN_SUB_SESSION", confidence: 0.98, reason: "multi-step" });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
    });
    const parentId = agent.getSessionId()!;
    expect(parentId).toBeTruthy();

    for await (const _ of agent.processMessage("review toàn bộ src/council và liệt kê silent catch")) {
      // drain
    }

    const db = getDatabase();

    // 1) LABELING: exactly one child, kind="subagent", parent + root wired.
    const children = db
      .prepare("SELECT id, kind, parent_session_id, root_session_id FROM sessions WHERE parent_session_id = ?")
      .all(parentId) as Array<{ id: string; kind: string; parent_session_id: string; root_session_id: string }>;
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child.kind).toBe("subagent");
    expect(child.root_session_id).toBe(parentId);

    // 2) ISOLATION: the 50KB clutter lives in the CHILD.
    const childText = (
      db.prepare("SELECT message_json FROM messages WHERE session_id = ?").all(child.id) as Array<{
        message_json: string;
      }>
    )
      .map((r) => r.message_json)
      .join("\n");
    expect(childText).toContain("CLUTTER_");

    // 3) LEANNESS: the parent absorbed ONLY the outcome — NO clutter — and the
    //    session was restored to the parent.
    expect(agent.getSessionId()).toBe(parentId);
    const parentRows = db
      .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY seq")
      .all(parentId) as Array<{ message_json: string }>;
    const parentText = parentRows.map((r) => r.message_json).join("\n");
    const parentBytes = parentText.length;

    expect(parentText).toContain(FINAL_OUTCOME); // outcome absorbed
    expect(parentText).not.toContain("CLUTTER_"); // clutter NOT absorbed
    // Parent stays tiny despite a 50KB turn — the isolation goal.
    expect(parentBytes).toBeLessThan(5_000);

    // Report the measured numbers so the run is self-documenting.
    console.log(
      `[measured] parentBytes=${parentBytes} childHasClutter=${childText.includes("CLUTTER_")} childKind=${child.kind}`,
    );
  });

  it("renders the absorbed answer ONCE — the child's copy of it is not a second entry", async () => {
    // Absorption persists the child's final answer into the parent too, so the
    // text exists in both sessions. The chain-aware transcript render must not
    // show it twice.
    mockClassify.mockResolvedValue({ action: "SPAWN_SUB_SESSION", confidence: 0.98, reason: "multi-step" });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
    const parentId = agent.getSessionId()!;
    for await (const _ of agent.processMessage("review toàn bộ src/council")) {
      // drain
    }

    const db = getDatabase();
    const childId = (db.prepare("SELECT id FROM sessions WHERE parent_session_id = ?").get(parentId) as { id: string })
      .id;

    // Precondition: the text really is persisted in BOTH sessions.
    const persistedIn = (sid: string) =>
      (db.prepare("SELECT message_json FROM messages WHERE session_id = ?").all(sid) as Array<{ message_json: string }>)
        .map((r) => r.message_json)
        .filter((j) => j.includes(FINAL_OUTCOME)).length;
    expect(persistedIn(parentId)).toBe(1);
    expect(persistedIn(childId)).toBe(1);

    const entries = buildChatEntries(parentId);
    const answers = entries.filter((e) => e.type === "assistant" && e.content.includes(FINAL_OUTCOME));
    expect(answers).toHaveLength(1);

    // The child's OTHER assistant work is untouched — only the absorbed message
    // is dropped, not the whole child transcript.
    expect(entries.some((e) => e.type === "assistant" && e.content === "intermediate analysis step")).toBe(true);
  });

  it("DIRECT_ANSWER runs in the parent — no child session created (baseline)", async () => {
    mockClassify.mockResolvedValue({ action: "DIRECT_ANSWER", confidence: 0.95, reason: "informational" });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
    });
    const parentId = agent.getSessionId()!;

    for await (const _ of agent.processMessage("bạn đánh giá phân tích council feature")) {
      // drain
    }

    const db = getDatabase();
    const children = db.prepare("SELECT id FROM sessions WHERE parent_session_id = ?").all(parentId);
    expect(children).toHaveLength(0);
    expect(agent.getSessionId()).toBe(parentId);
  });

  it("REACTIVE: a tool-heavy prior turn escalates the NEXT turn to a sub-session even though the router keeps returning DIRECT_ANSWER (the 50aa blind-spot fix)", async () => {
    // The router NEVER returns SPAWN here — it mis-routes analysis to
    // DIRECT_ANSWER (measured live on deepseek-v4-flash for the exact 50aa
    // prompt). Isolation must instead be driven by the OBSERVED tool load.
    mockClassify.mockResolvedValue({ action: "DIRECT_ANSWER", confidence: 0.95, reason: "reads like analysis" });
    process.env.MUONROI_REACTIVE_DELEGATE_CHARS = "120000";

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
    });
    const parentId = agent.getSessionId()!;
    const db = getDatabase();

    // Turn 1: heavy tool load reported (13-read-style turn), but router says
    // DIRECT — so it runs in the parent, NO child yet.
    reportedLoad = 150_000;
    for await (const _ of agent.processMessage("đánh giá phân tích council feature (turn 1, heavy)")) {
      /* drain */
    }
    expect(db.prepare("SELECT id FROM sessions WHERE parent_session_id = ?").all(parentId)).toHaveLength(0);

    // Turn 2: router STILL says DIRECT, but the prior turn's 150k tool load
    // trips reactive escalation → an isolated sub-session IS created.
    reportedLoad = 0; // this turn itself is light
    for await (const _ of agent.processMessage("tiếp tục phân tích (turn 2)")) {
      /* drain */
    }
    const childrenAfter = db
      .prepare("SELECT id, kind FROM sessions WHERE parent_session_id = ?")
      .all(parentId) as Array<{ id: string; kind: string }>;
    expect(childrenAfter).toHaveLength(1);
    expect(childrenAfter[0]!.kind).toBe("subagent");
    expect(agent.getSessionId()).toBe(parentId); // restored after absorption

    // INSTRUMENT: the cold-first-turn telemetry must record turn 1's heavy load
    // tagged coldFirstTurn=true (ordinal 1) — that's the row a later query counts
    // to decide whether an in-turn checkpoint is worth building.
    const loadRows = db
      .prepare("SELECT session_id, metadata_json FROM interaction_logs WHERE event_type = 'turn_tool_load'")
      .all() as Array<{ session_id: string; metadata_json: string }>;
    expect(loadRows.length).toBeGreaterThanOrEqual(1);
    const cold = loadRows.map((r) => JSON.parse(r.metadata_json)).find((d) => d.ordinal === 1);
    expect(cold).toBeDefined();
    expect(cold.coldFirstTurn).toBe(true);
    expect(cold.chars).toBe(150_000);
    // Turn 1 ran in the PARENT (router DIRECT, reactive can't fire yet), so it is
    // the genuine un-isolated cold-first-turn hole: coldFirstTurn && !isolated.
    expect(cold.isolated).toBe(false);
    expect(cold.kind).toBe("conversation");

    delete process.env.MUONROI_REACTIVE_DELEGATE_CHARS;
  });

  it("REACTIVE: a light prior turn does NOT escalate (no false isolation)", async () => {
    mockClassify.mockResolvedValue({ action: "DIRECT_ANSWER", confidence: 0.95, reason: "informational" });
    process.env.MUONROI_REACTIVE_DELEGATE_CHARS = "120000";

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, {
      persistSession: true,
    });
    const parentId = agent.getSessionId()!;
    const db = getDatabase();

    reportedLoad = 20_000; // light turn — below threshold
    for await (const _ of agent.processMessage("quick question (turn 1)")) {
      /* drain */
    }
    reportedLoad = 20_000;
    for await (const _ of agent.processMessage("another quick question (turn 2)")) {
      /* drain */
    }
    expect(db.prepare("SELECT id FROM sessions WHERE parent_session_id = ?").all(parentId)).toHaveLength(0);

    delete process.env.MUONROI_REACTIVE_DELEGATE_CHARS;
  });

  // Round 2 (G3 HIGH): a project model pin (`.muonroi-cli/settings.json`
  // `{"model": ...}`) must hold for a SPAWN_SUB_SESSION child too — both the
  // child's OWN `sessions` row and the modelId its own turn actually runs
  // with (its "tool loop") — not just the parent turn that spawned it.
  it("a project model pin propagates to a SPAWN_SUB_SESSION child: the sessions row AND the modelId its own turn runs with", async () => {
    mockClassify.mockResolvedValue({ action: "SPAWN_SUB_SESSION", confidence: 0.98, reason: "multi-step" });
    const PIN_MODEL = "deepseek-v4-flash";

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-subsess-pin-"));
    fs.mkdirSync(path.join(projectDir, ".muonroi-cli"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".muonroi-cli", "settings.json"), JSON.stringify({ model: PIN_MODEL }));
    const prevCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const agent = new Agent("sk-dummy", undefined, PIN_MODEL, undefined, { persistSession: true });
      const parentId = agent.getSessionId()!;

      for await (const _ of agent.processMessage("review toàn bộ src/council và liệt kê silent catch")) {
        // drain
      }

      const db = getDatabase();
      const child = db.prepare("SELECT id, model FROM sessions WHERE parent_session_id = ?").get(parentId) as
        | { id: string; model: string }
        | undefined;
      expect(child).toBeDefined();
      // The child session's OWN sessions row carries the pinned model.
      expect(child?.model).toBe(PIN_MODEL);

      // The turn that actually ran (MessageProcessor is constructed once
      // per processMessage() call, AFTER the SPAWN_SUB_SESSION handler has
      // already swapped session context to the child — this architecture
      // never gives the "parent turn" its own separate MessageProcessor
      // run) was constructed against the CHILD session, with the pinned
      // modelId — not just the session row, the actual deps its tool loop
      // runs with.
      expect(capturedTurnModelIds).toHaveLength(1);
      expect(capturedTurnModelIds[0]?.sessionId).toBe(child?.id);
      expect(capturedTurnModelIds[0]?.modelId).toBe(PIN_MODEL);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

// Round 3 (MEDIUM correction to round 2's G3 HIGH fix): round 2 applied the
// project model pin unconditionally inside `_resolveModelForTask` — the
// SINGLE shared resolver behind both stream-runner.ts's delegated
// sub-agent dispatch (explore/general/verify) AND compaction's own model
// choice (`_resolveCompactModel` -> `_resolveModelForTask("compact")`).
// That pinned compaction too, an unintended cost change: compaction is
// deliberately on its own cheap tier table
// (`TASK_TIER_PREFS.compact = ["fast","balanced"]`) so a session
// summarization pass never rides the expensive pinned model. Decision:
// compaction stays on its cheap tier table; the pin applies only to
// delegated sub-agent/sub-session dispatch (every OTHER task kind).
//
// `_resolveModelForTask` is a private method — accessed here via a type
// cast, the same way any other JS runtime call would reach it; there is no
// other way to observe this ONE orchestrator-level wiring decision without
// either triggering a full real LLM compaction pass or the full
// stream-runner sub-agent dispatch pipeline, both far heavier than the
// thing actually under test (which task kinds get `pinned: true`).
describe("_resolveModelForTask — round 3: the pin applies to delegated dispatch, NOT to compaction", () => {
  it("passes pinned:false for task='compact' and pinned:true for every other task, when the project pins a model", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-subsess-pin-compact-"));
    fs.mkdirSync(path.join(projectDir, ".muonroi-cli"), { recursive: true });
    const PIN_MODEL = "deepseek-v4-pro";
    fs.writeFileSync(path.join(projectDir, ".muonroi-cli", "settings.json"), JSON.stringify({ model: PIN_MODEL }));
    const prevCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const agent = new Agent("sk-dummy", undefined, PIN_MODEL, undefined, { persistSession: true });
      const resolveModelForTask = (
        agent as unknown as { _resolveModelForTask(task: ModelTaskKind): string }
      )._resolveModelForTask.bind(agent);

      resolveModelForTask("compact");
      resolveModelForTask("general");
      resolveModelForTask("explore");
      resolveModelForTask("verify");

      const byTask = Object.fromEntries(capturedResolveModelForTaskCalls.map((c) => [c.task, c.pinned]));
      expect(byTask.compact).toBe(false); // NOT pinned — compaction keeps its own cheap tier table
      expect(byTask.general).toBe(true);
      expect(byTask.explore).toBe(true);
      expect(byTask.verify).toBe(true);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("passes pinned:false for EVERY task when the project has no pin at all (no regression)", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-subsess-nopin-"));
    const prevCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
      const resolveModelForTask = (
        agent as unknown as { _resolveModelForTask(task: ModelTaskKind): string }
      )._resolveModelForTask.bind(agent);

      resolveModelForTask("compact");
      resolveModelForTask("general");

      const byTask = Object.fromEntries(capturedResolveModelForTaskCalls.map((c) => [c.task, c.pinned]));
      expect(byTask.compact).toBe(false);
      expect(byTask.general).toBe(false);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

// Round 4 (G9): an unrelated request must fork a FRESH sub-session instead of
// resuming an active one purely because it is recent. Measured live: session
// 69e68c766fcf's "hunt/stage0" request resumed the unrelated SEAL-challenge
// sub-session's 29-message context.
describe("sub-session resume vs. fork — round 4 (G9)", () => {
  it("an UNRELATED second request does NOT resume the active sub-session: it is marked abandoned and a fresh one is forked", async () => {
    mockClassify.mockResolvedValue({ action: "SPAWN_SUB_SESSION", confidence: 0.98, reason: "multi-step" });
    mockRelatedness.mockResolvedValueOnce({ related: false, confidence: 0.9, reason: "different repo/task entirely" });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
    const parentId = agent.getSessionId()!;

    for await (const _ of agent.processMessage("seal challenge precommit-working-set-drift")) {
      // drain
    }
    const db = getDatabase();
    const firstChild = db
      .prepare("SELECT id, title, status FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(parentId) as { id: string; title: string | null; status: string };
    expect(firstChild.title).toBe("seal challenge precommit-working-set-drift");

    for await (const _ of agent.processMessage("tìm repo Python mới và dựng bài tới hết stage0")) {
      // drain
    }

    const children = db
      .prepare("SELECT id, title, status FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC")
      .all(parentId) as Array<{ id: string; title: string | null; status: string }>;
    expect(children).toHaveLength(2); // the old one was NOT reused — a second, distinct child was created
    const oldChild = children.find((c) => c.id === firstChild.id)!;
    const newChild = children.find((c) => c.id !== firstChild.id)!;
    expect(oldChild.status).toBe("abandoned"); // marked abandoned, not silently left "active" with stale content
    expect(newChild.title).toBe("tìm repo Python mới và dựng bài tới hết stage0");
    // The relatedness classifier was actually consulted with the OLD sub-session's
    // recorded goal and the NEW request — proving the decision is real, not a stub.
    expect(mockRelatedness).toHaveBeenCalledWith(
      expect.anything(),
      "tìm repo Python mới và dựng bài tới hết stage0",
      "seal challenge precommit-working-set-drift",
    );
  });

  it("a RELATED second request DOES resume the active sub-session (no regression)", async () => {
    mockClassify.mockResolvedValue({ action: "SPAWN_SUB_SESSION", confidence: 0.98, reason: "multi-step" });
    mockRelatedness.mockResolvedValueOnce({ related: true, confidence: 0.95, reason: "same challenge, follow-up" });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
    const parentId = agent.getSessionId()!;

    for await (const _ of agent.processMessage("seal challenge precommit-working-set-drift")) {
      // drain
    }
    const db = getDatabase();
    const firstChild = db
      .prepare("SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(parentId) as { id: string };

    for await (const _ of agent.processMessage("done_check báo lỗi gì vậy, xem lại giúp tôi")) {
      // drain
    }

    const children = db.prepare("SELECT id, status FROM sessions WHERE parent_session_id = ?").all(parentId) as Array<{
      id: string;
      status: string;
    }>;
    expect(children).toHaveLength(1); // the SAME sub-session was reused, not forked again
    expect(children[0]!.id).toBe(firstChild.id);
    expect(children[0]!.status).toBe("active");
  });

  it("no active sub-session at all still forks fresh without ever consulting the relatedness classifier (nothing to compare against)", async () => {
    mockClassify.mockResolvedValue({ action: "SPAWN_SUB_SESSION", confidence: 0.98, reason: "multi-step" });

    const agent = new Agent("sk-dummy", undefined, "deepseek-v4-flash", undefined, { persistSession: true });
    const parentId = agent.getSessionId()!;

    for await (const _ of agent.processMessage("first task ever for this session")) {
      // drain
    }

    expect(mockRelatedness).not.toHaveBeenCalled();
    const db = getDatabase();
    const children = db.prepare("SELECT id FROM sessions WHERE parent_session_id = ?").all(parentId);
    expect(children).toHaveLength(1);
  });
});
