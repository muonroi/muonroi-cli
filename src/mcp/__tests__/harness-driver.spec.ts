import {
  buildCapabilitiesPayload,
  createMcpHarnessServer,
  getRegisteredToolNames,
} from "@muonroi/agent-harness-core/mcp-server";
import {
  evaluatePredicate,
  PREDICATE_COMBINATORS,
  PREDICATE_FIELDS,
  PREDICATE_FLAGS,
  PREDICATE_OPS,
  predicateSchema,
} from "@muonroi/agent-harness-core/predicate";
import { KNOWN_ROLES, LIVE_EVENT_KINDS, type LiveFrame, PROTOCOL_VERSION } from "@muonroi/agent-harness-core/protocol";
import { matchSelector } from "@muonroi/agent-harness-core/selector";
import { beforeAll, describe, expect, it } from "vitest";

// Constructing the server is what populates the tool registry the payload is
// derived from. A spawn that is never called is enough: no tool is invoked here.
const neverSpawn = () => Promise.reject(new Error("spawn not used in this spec"));

beforeAll(() => {
  createMcpHarnessServer({ spawn: neverSpawn as never });
});

describe("harness-driver capabilities", () => {
  it("reports current protocol version", () => {
    expect(buildCapabilitiesPayload().protocol).toBe(PROTOCOL_VERSION);
  });

  it("advertises core feature set", () => {
    const { features } = buildCapabilitiesPayload();
    expect(features).toContain("capabilities");
    expect(features).toContain("snapshot");
    expect(features).toContain("press");
    expect(features).toContain("type");
    expect(features).toContain("wait_for");
    expect(features).toContain("query");
    expect(features).toContain("expect");
    expect(features).toContain("render_text");
  });

  it("advertises EVERY registered tool, not a hand-maintained subset", () => {
    const { tools, features, toolsSource } = buildCapabilitiesPayload();
    const registered = getRegisteredToolNames();

    expect(toolsSource).toBe("registrar");
    expect(registered.length).toBeGreaterThanOrEqual(21);
    expect(tools).toEqual(registered);

    // The eight the old static FEATURES array had silently dropped — including
    // tui.last_event, the tool that answers "waiting on a human, or hung?".
    for (const name of [
      "tui.changes_since",
      "tui.count",
      "tui.focus",
      "tui.last_event",
      "tui.press_sequence",
      "tui.query_all",
      "tui.start",
      "tui.stop",
    ]) {
      expect(tools).toContain(name);
    }
    // Short-name view stays in step with the qualified one.
    for (const t of registered) {
      expect(features).toContain(t.replace(/^tui\./, ""));
    }
  });

  it("advertises the full protocol event-kind list including resume-request", () => {
    const { eventKinds } = buildCapabilitiesPayload();
    expect(eventKinds).toEqual(LIVE_EVENT_KINDS);
    expect(eventKinds).toContain("resume-request");
    expect(eventKinds).toContain("askcard-open");
    // The terminal event of a /ideal run. Pinned by name, not just by count:
    // a driver that cannot name it is back to "approved and hung look alike".
    expect(eventKinds).toContain("run-finished");
    // 22 → 23 when run-finished was added. This count is a drift alarm for the
    // hand-maintained enumerations around LIVE_EVENT_KINDS — bump it when a kind
    // is ADDED; never lower it to make a removal pass (plan §2.5).
    // 23 → 24 when model-fallback was added (council provider switch observability).
    expect(eventKinds).toContain("model-fallback");
    expect(eventKinds.length).toBe(24);
  });

  it("advertises the role vocabulary and the custom-role prefix", () => {
    const { roles, customRolePrefix } = buildCapabilitiesPayload();
    expect(roles).toEqual(KNOWN_ROLES);
    expect(roles).toContain("textbox");
    expect(roles).toContain("dialog");
    expect(customRolePrefix).toBe("x-");
  });

  it("carries a selector grammar sufficient to build a working selector", () => {
    const { selector } = buildCapabilitiesPayload();
    expect(selector.ops).toContain("=");
    expect(selector.ops).toContain("~=");
    expect(selector.ops).toContain("*=");
    // ^= exists in the parser but was absent from the hand-written docs.
    expect(selector.ops).toContain("^=");
    expect(selector.flags).toContain("focus");
    expect(selector.fields).toContain("id");
    expect(selector.fields).toContain("role");
    expect(selector.childCombinator).toBe(">>");
    expect(selector.propsPrefix).toBe("props.");

    // The advertised grammar must actually parse: every documented example
    // matches something in a frame built only from advertised vocabulary.
    const root = {
      id: "root",
      role: "region" as const,
      children: [
        { id: "composer", role: "textbox" as const, name: "Prompt", focus: true as const },
        {
          id: "log",
          role: "log" as const,
          props: { overflows: true },
          children: [
            { id: "msg-0", role: "listitem" as const, name: "council opening" },
            { id: "msg-1", role: "listitem" as const, name: "Council synthesis" },
          ],
        },
        { id: "dlg", role: "dialog" as const, children: [{ id: "ok", role: "button" as const, name: "OK" }] },
      ],
    };
    expect(matchSelector(root, "role=textbox").map((n) => n.id)).toEqual(["composer"]);
    expect(matchSelector(root, "id=composer").map((n) => n.id)).toEqual(["composer"]);
    expect(matchSelector(root, 'name~="council"').map((n) => n.id)).toEqual(["msg-0", "msg-1"]);
    expect(matchSelector(root, 'name*="Co.*s$"').map((n) => n.id)).toEqual(["msg-1"]);
    expect(matchSelector(root, "role=listitem focus")).toEqual([]);
    expect(matchSelector(root, "role=listitem [index=0]").map((n) => n.id)).toEqual(["msg-0"]);
    expect(matchSelector(root, "role=dialog >> role=button").map((n) => n.id)).toEqual(["ok"]);
    expect(matchSelector(root, "id=log props.overflows=true").map((n) => n.id)).toEqual(["log"]);
  });

  it("carries a predicate grammar that tui.expect actually accepts", () => {
    const { predicate } = buildCapabilitiesPayload();
    expect(predicate.fields).toEqual(PREDICATE_FIELDS);
    expect(predicate.ops).toEqual(PREDICATE_OPS);
    expect(predicate.flags).toEqual(PREDICATE_FLAGS);
    expect(predicate.combinators).toEqual(PREDICATE_COMBINATORS);
    // `role` is NOT a predicate field — a capabilities-only drive that assumed
    // it was got a silent `false` back from tui.expect. The payload must be able
    // to prevent that, so the advertised list must exclude it.
    expect(predicate.fields as readonly string[]).not.toContain("role");
    expect(predicate.fields as readonly string[]).not.toContain("id");

    // Every advertised field/op combination must evaluate rather than throw.
    const node = { id: "n", role: "textbox" as const, name: "Prompt", value: "hi", state: "ready" };
    for (const field of predicate.fields) {
      for (const op of predicate.ops) {
        const p = predicateSchema.parse({ field, op, rhs: "hi" });
        expect(typeof evaluatePredicate(p, node)).toBe("boolean");
      }
    }
    expect(evaluatePredicate(predicateSchema.parse({ field: "name", op: "eq", rhs: "Prompt" }), node)).toBe(true);
    // And a field the payload does NOT advertise is rejected by the schema.
    expect(() => predicateSchema.parse({ field: "role", op: "eq", rhs: "textbox" })).toThrow();
  });

  it("reports semantic ids from the live frame, never a static inventory", () => {
    const noDriver = buildCapabilitiesPayload();
    expect(noDriver.semantics.source).toBe("no-driver");
    expect(noDriver.semantics.nodes).toEqual([]);
    expect(noDriver.semantics.frameSeq).toBeNull();

    const frame: LiveFrame = {
      mode: "live",
      version: PROTOCOL_VERSION,
      seq: 7,
      ts: 1,
      focus: "composer",
      modals: ["slash-menu"],
      nodes: [
        {
          id: "root",
          role: "region",
          children: [
            { id: "composer", role: "textbox", name: "Prompt", focus: true },
            { id: "slash-menu", role: "menu", isModal: true },
          ],
        },
      ],
    };
    const live = buildCapabilitiesPayload({ frame });
    expect(live.semantics.source).toBe("live-frame");
    expect(live.semantics.frameSeq).toBe(7);
    expect(live.semantics.focus).toBe("composer");
    expect(live.semantics.modals).toEqual(["slash-menu"]);
    expect(live.semantics.nodeCount).toBe(3);
    expect(live.semantics.truncated).toBe(false);
    expect(live.semantics.nodes).toContainEqual({ id: "composer", role: "textbox", name: "Prompt", focus: true });
    expect(live.semantics.nodes).toContainEqual({ id: "slash-menu", role: "menu", isModal: true });
  });
});
