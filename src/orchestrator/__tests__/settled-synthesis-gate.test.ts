import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase } from "../../storage/db.js";
import { SessionStore } from "../../storage/sessions.js";
import { appendSystemMessage } from "../../storage/transcript.js";
import { applySettledSynthesisGate } from "../settled-synthesis-gate.js";

// ─────────────────────────────────────────────────────────────────────────
// REAL strings from the reference incident (session 115a59c9bb9e -> child
// 49f6b8c1d8d6), not hand-written similar topics. A `[Council Memory]`
// record's `topic` is the RAW user message that triggered the debate, not a
// description of the subject — so the parent's recorded topic and the
// child's later topic are two DIFFERENT sentences that structurally do not
// overlap lexically (measured Jaccard similarity: 0.032), even though the
// second one really is "go build what we just agreed on". A test built from
// hand-written similar topics would have hidden exactly this — the same
// trap an earlier (topic-similarity-gated) version of this fix fell into.
//
// The evidence source is the DB session-chain lookup ONLY — an earlier
// in-memory-scan path was removed (see settled-synthesis-gate.ts's module
// doc): it was unreachable on the real fork case (appendSystemMessage is
// DB-only, nothing pushes into `this.messages`) and unbounded where it WAS
// reachable (no recency check), which is backwards, since the in-memory
// path is reachable only after a resume — the long-lived-session case where
// a stale decision is most likely.
// ─────────────────────────────────────────────────────────────────────────
const PARENT_TOPIC =
  "ok bây giờ bạn đi vào mode council để bàn luận về đề xuất của bạn để có cái nhìn đa chiều hơn nhé " +
  "sau đó tổng hợp lại cho tôi đề xuất đã chỉnh sửa sau…";
const CURRENT_TOPIC = "ok tiến hành implement theo plan kết hợp sub agent";
const SYNTHESIS =
  "Agreed Integration Architecture: AutomationFrameworkConfig maps to TestRunMapping via a subprocess-wrapper approach.";

function councilMemoryRecord(topic: string, synthesis: string) {
  return { role: "system", content: `[Council Memory] ${JSON.stringify({ topic, synthesis })}` };
}

describe("applySettledSynthesisGate — short-circuit conditions (no DB touch)", () => {
  it("never applies to an explicit plan|analyze request (heavyTierOnly=false)", () => {
    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: false,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: "some-session",
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });

  it("is a no-op when the gate would not have convened a debate anyway", () => {
    const result = applySettledSynthesisGate({
      wouldConvene: false,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: "some-session",
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });

  it("never suppresses a turn that is not implementation-shaped", () => {
    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: false,
      topic: CURRENT_TOPIC,
      sessionId: "some-session",
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });

  it("fails open (no throw, not suppressed) when sessionId is null — nothing to look up", () => {
    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: null,
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DB session-chain evidence — the actual SPAWN_SUB_SESSION fork shape.
//
// Session 115a59c9bb9e -> child 49f6b8c1d8d6: `[Council Memory]` is written
// straight to SQLite via appendSystemMessage (src/storage/transcript.ts).
// These tests exercise the real shape: a seeded PARENT-session DB row,
// reached by walking `parent_session_id`, using the REAL topic strings from
// the incident.
// ─────────────────────────────────────────────────────────────────────────
describe("applySettledSynthesisGate — DB session-chain evidence (the real fork shape)", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "muonroi-settled-gate-"));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    closeDatabase();
    getDatabase(); // trigger migrations against the temp DB
  });

  afterEach(() => {
    closeDatabase();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("suppresses when the PARENT session's DB row settles this turn (real topic strings, 0.032 similarity)", () => {
    const store = new SessionStore(tmpHome);
    const parent = store.createSession("m", "agent", tmpHome);
    appendSystemMessage(parent.id, councilMemoryRecord(PARENT_TOPIC, SYNTHESIS).content);

    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, parent.id, "subagent");

    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: child.id,
    });

    expect(result.suppressed).toBe(true);
    expect(result.evidence.found).toBe(true);
    expect(result.evidence.recordTopic).toBe(PARENT_TOPIC);
    expect(result.evidence.similarity).toBeLessThan(0.1);
  });

  it("does NOT suppress via the DB chain when the turn is not implementation-shaped, even with a settled parent record", () => {
    const store = new SessionStore(tmpHome);
    const parent = store.createSession("m", "agent", tmpHome);
    appendSystemMessage(parent.id, councilMemoryRecord(PARENT_TOPIC, SYNTHESIS).content);

    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, parent.id, "subagent");

    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: false,
      topic: CURRENT_TOPIC,
      sessionId: child.id,
    });

    expect(result.suppressed).toBe(false);
    // The gate short-circuits on turnWantsImplementation before ever
    // touching the DB, so no evidence lookup even runs.
    expect(result.evidence.found).toBe(false);
  });

  it("does not suppress when no session in the chain has a [Council Memory] row (regression check)", () => {
    const store = new SessionStore(tmpHome);
    const parent = store.createSession("m", "agent", tmpHome);
    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, parent.id, "subagent");

    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: child.id,
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });

  it("does NOT reach into a sibling sub-session's settled debate", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("m", "agent", tmpHome);

    const sibling = store.createSession("m", "agent", tmpHome);
    store.linkChild(sibling.id, root.id, "subagent");
    appendSystemMessage(sibling.id, councilMemoryRecord(PARENT_TOPIC, SYNTHESIS).content);

    // A second child forked from the SAME root, but not descended from the
    // sibling — its parent chain is [self, root], not [self, sibling, root].
    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, root.id, "subagent");

    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: child.id,
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });

  it("walks a grandchild up through TWO parent hops to find the root's settled synthesis", () => {
    const store = new SessionStore(tmpHome);
    const root = store.createSession("m", "agent", tmpHome);
    appendSystemMessage(root.id, councilMemoryRecord(PARENT_TOPIC, SYNTHESIS).content);

    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, root.id, "subagent");
    const grandchild = store.createSession("m", "agent", tmpHome);
    store.linkChild(grandchild.id, child.id, "subagent");

    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: grandchild.id,
    });

    expect(result.suppressed).toBe(true);
    expect(result.evidence.found).toBe(true);
  });

  it("does not suppress on a stale record older than the recency bound", () => {
    const store = new SessionStore(tmpHome);
    const parent = store.createSession("m", "agent", tmpHome);
    appendSystemMessage(parent.id, councilMemoryRecord(PARENT_TOPIC, SYNTHESIS).content);

    // Back-date the [Council Memory] row past the 60-minute recency bound
    // (RECENCY_BOUND_MS in settled-synthesis-gate.ts) — a decision from
    // hours earlier in a long-lived session must not suppress a turn that
    // has moved on.
    const staleTs = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    getDatabase()
      .prepare("UPDATE messages SET created_at = ? WHERE session_id = ? AND role = 'system'")
      .run(staleTs, parent.id);

    const child = store.createSession("m", "agent", tmpHome);
    store.linkChild(child.id, parent.id, "subagent");

    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: child.id,
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });

  it("fails open when sessionId points at a session that does not exist in the DB", () => {
    const result = applySettledSynthesisGate({
      wouldConvene: true,
      heavyTierOnly: true,
      turnWantsImplementation: true,
      topic: CURRENT_TOPIC,
      sessionId: "no-such-session",
    });

    expect(result.suppressed).toBe(false);
    expect(result.evidence.found).toBe(false);
  });
});
