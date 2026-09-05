/**
 * The picker/connect half of the modal-focus sweep.
 *
 * `SELF-IMPROVEMENT-PLAN.md` §6.0 open item 4 left this layer unswept after
 * P0-9: "Any surface that publishes a `focus` flag without suppressing the
 * composer's mirror will produce **two** focus nodes, and `driver.query("focus")`
 * **throws** `ambiguous` on >1 match — a worse dead end than `null`."
 *
 * Measured 2026-09-05 over the real harness before the fix — `/model`,
 * `/resume`, `/mcp`, `/agents`, `/remote-control` and `/ee setup` each returned
 * `[]` from `driver.queryAll("focus")` (zero owners, the `null` dead end), and
 * `/sandbox` + `/wallet` published no Semantic node at all. The E2E half of the
 * proof lives in `tests/harness/modal-focus-sweep.spec.ts`; this file covers the
 * surfaces that spec cannot reach by a slash command, plus the resolver
 * invariant across every surface in the union.
 *
 * Strategy mirrors `modal-focus-publication.test.tsx`: the cards are pure
 * function components, so they are invoked directly and the returned
 * `<Semantic>` element's props are read — no render engine needed. `react` is
 * mocked only to neutralise `useEffect`/`useRef` in the two editor modals, which
 * would otherwise need a live dispatcher.
 */

import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Scroll-into-view effects and textarea refs are irrelevant to the focus
    // flag and are the only reason these components need a dispatcher.
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
  };
});

const { SubagentEditorModal } = await import("../agents-modal.js");
const { McpEditorModal } = await import("../mcp-modal.js");
const { ApiKeyModal } = await import("../modals/api-key-modal.js");
const { TelegramPairModal, TelegramTokenModal } = await import("../modals/connect-modal.js");
const { EeConnectCard } = await import("../modals/ee-connect-card.js");
const { LspSetupCard } = await import("../modals/lsp-setup-card.js");
const { McpNeedsKeyCard } = await import("../modals/mcp-needs-key-card.js");
const { ModelPickerModal } = await import("../modals/model-picker-modal.js");
const { SandboxPickerModal } = await import("../modals/sandbox-picker-modal.js");
const { SessionPickerModal } = await import("../modals/session-picker-modal.js");
const { UpdateModal } = await import("../modals/update-modal.js");
const { PaymentApprovalPanel, WalletPickerModal } = await import("../modals/wallet-picker-modal.js");
const { PlanQuestionsPanel } = await import("../plan.js");
const { loadCatalog } = await import("../../models/registry.js");
const {
  collectOpenModalSurfaces,
  createModalOpenOrder,
  MODAL_SURFACE_PRIORITY,
  modalOwnsKeyboard,
  reconcileModalOpenOrder,
  resolveModalKeyboardOwner,
} = await import("../modal-focus.js");

// Colors are only read to build style props we never render.
// biome-ignore lint/suspicious/noExplicitAny: an empty theme is enough to exercise the semantic wrapper
const THEME = {} as any;

/**
 * Invoke a function element one level so the role-fixed primitives
 * (`<Dialog focused>` → `<Block>` → `<Semantic focus>`) reach the node that
 * actually carries the flag. Stops at `Semantic`, whose props ARE the answer.
 * Host elements (`box`, `text`) have a string `type` and are left alone.
 */
// biome-ignore lint/suspicious/noExplicitAny: walking React element internals for a pure-function assertion
function resolve(node: any, depth = 0): any {
  if (!node || typeof node !== "object" || depth > 20) return node;
  if (typeof node.type !== "function" || node.type.name === "Semantic") return node;
  return resolve(node.type(node.props), depth + 1);
}

/** Depth-first search for the element carrying `props.id === id`. */
// biome-ignore lint/suspicious/noExplicitAny: same
function findById(node: any, id: string): any {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  }
  const el = resolve(node);
  if (el?.props?.id === id) return el;
  return findById(el?.props?.children, id);
}

/** Every descendant (inclusive) carrying `props.focus === true`. */
// biome-ignore lint/suspicious/noExplicitAny: same
function focusedIds(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) focusedIds(child, out);
    return out;
  }
  const el = resolve(node);
  if (!el || typeof el !== "object") return out;
  if (el.props?.focus === true && typeof el.props?.id === "string") out.push(el.props.id);
  focusedIds(el.props?.children, out);
  return out;
}

/**
 * Minimal prop bag per surface. `render(focused)` returns the element tree; the
 * root id is what must carry the flag when the surface owns the keyboard.
 */
const SURFACES: { rootId: string; render: (focused: boolean) => unknown }[] = [
  {
    rootId: "api-key-modal",
    render: (focused) =>
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag; only the focus path is exercised
      ApiKeyModal({
        t: THEME,
        width: 100,
        height: 40,
        inputRef: { current: null },
        error: null,
        onSubmit() {},
        focused,
      } as any),
  },
  {
    rootId: "update-modal",
    render: (focused) =>
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      UpdateModal({
        t: THEME,
        width: 100,
        height: 40,
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        focused,
      } as any),
  },
  {
    rootId: "session-picker",
    render: (focused) =>
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      SessionPickerModal({ t: THEME, sessions: [], focusIndex: 0, width: 100, height: 40, focused } as any),
  },
  {
    rootId: "model-picker",
    render: (focused) =>
      ModelPickerModal({
        t: THEME,
        width: 100,
        height: 40,
        configuredProviders: [],
        disabledProviders: [],
        providerChipIndex: 0,
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "sandbox-picker",
    render: (focused) =>
      SandboxPickerModal({
        t: THEME,
        currentMode: "off",
        settings: {},
        focusIndex: 0,
        editing: null,
        editBuffer: "",
        width: 100,
        height: 40,
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "wallet-picker",
    render: (focused) =>
      WalletPickerModal({
        t: THEME,
        settings: { approval: { autoApprove: false } },
        walletInfo: { address: null, ethBalance: null, usdcBalance: null },
        focusIndex: 0,
        width: 100,
        height: 40,
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "payment-approval",
    render: (focused) =>
      PaymentApprovalPanel({
        t: THEME,
        payment: {
          url: "https://example.test/pay",
          description: "d",
          security: "s",
          securityLabel: "l",
          securityUrl: "u",
          amount: "1",
          network: "n",
          asset: "a",
          selected: 0,
        },
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "plan-questions",
    render: (focused) =>
      PlanQuestionsPanel({
        t: THEME,
        questions: [{ id: "q1", type: "text", question: "why?" }],
        state: { tab: 0, cursor: 0, answers: {}, customInputs: {}, editing: false },
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "telegram-token-modal",
    render: (focused) =>
      TelegramTokenModal({
        t: THEME,
        width: 100,
        height: 40,
        inputRef: { current: null },
        error: null,
        onSubmit() {},
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "telegram-pair-modal",
    render: (focused) =>
      TelegramPairModal({
        t: THEME,
        width: 100,
        height: 40,
        inputRef: { current: null },
        error: null,
        onSubmit() {},
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "mcp-editor",
    render: (focused) =>
      McpEditorModal({
        t: THEME,
        width: 100,
        height: 40,
        draft: {
          transport: "stdio",
          label: "",
          url: "",
          headersText: "",
          command: "",
          argsText: "",
          cwd: "",
          envText: "",
        },
        focusedField: "transport",
        syncKey: 0,
        error: null,
        title: "Add MCP Server",
        labelRef: { current: null },
        urlRef: { current: null },
        headersRef: { current: null },
        commandRef: { current: null },
        argsRef: { current: null },
        cwdRef: { current: null },
        envRef: { current: null },
        onSubmit() {},
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "subagent-editor",
    render: (focused) =>
      SubagentEditorModal({
        t: THEME,
        width: 100,
        height: 40,
        draft: { name: "", instruction: "" },
        focusedField: "name",
        modelIndex: 0,
        error: null,
        title: "Add sub-agent",
        nameRef: { current: null },
        instructionRef: { current: null },
        onSubmit() {},
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
  {
    rootId: "lsp-setup-card",
    render: (focused) =>
      LspSetupCard({
        t: THEME,
        width: 100,
        height: 40,
        languages: [],
        selectedIds: new Set<string>(),
        detectedIds: new Set<string>(),
        cursorIndex: 0,
        mode: "pick",
        statuses: [],
        focused,
        // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      } as any),
  },
];

describe("picker/connect modal roots mirror keyboard ownership onto the semantic tree", () => {
  // SubagentEditorModal reads MODELS from the catalog and throws when it is empty.
  beforeAll(async () => {
    await loadCatalog();
  });

  for (const { rootId, render } of SURFACES) {
    it(`${rootId} publishes focus only when it owns the keyboard`, () => {
      // biome-ignore lint/suspicious/noExplicitAny: reaching into React element internals
      const on = findById(render(true) as any, rootId);
      expect(on, `no node with id=${rootId}`).not.toBeNull();
      expect(on.props.focus).toBe(true);
      // Exactly one node in the subtree carries the flag — never two.
      expect(focusedIds(render(true))).toEqual([rootId]);

      // biome-ignore lint/suspicious/noExplicitAny: same
      const off = findById(render(false) as any, rootId);
      expect(off.props.focus).toBeUndefined();
      expect(focusedIds(render(false))).toEqual([]);
    });
  }
});

describe("the two cards whose focus flag moves between nodes still total exactly one", () => {
  // biome-ignore lint/suspicious/noExplicitAny: minimal prop bags
  const ee = (mode: string, focused: boolean) =>
    EeConnectCard({
      t: THEME,
      width: 100,
      height: 40,
      actions: [{ id: "hosted", label: "Hosted", hint: "" }],
      selectedIndex: 0,
      mode,
      inputRef: { current: null },
      error: null,
      onSubmitToken() {},
      focused,
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
    } as any);

  const needsKey = (mode: string, focused: boolean) =>
    McpNeedsKeyCard({
      t: THEME,
      width: 100,
      height: 40,
      server: { id: "tavily", label: "Tavily", envVar: "TAVILY_API_KEY", setupHint: "" },
      actions: [{ id: "paste", label: "Paste key", hint: "" }],
      selectedIndex: 0,
      mode,
      inputRef: { current: null },
      error: null,
      onSubmitKey() {},
      focused,
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
    } as any);

  it("ee-connect-card: the card owns it in actions mode, the token field in input mode", () => {
    expect(focusedIds(ee("actions", true))).toEqual(["ee-connect-card"]);
    expect(focusedIds(ee("input", true))).toEqual(["ee-connect-input"]);
    // "how" is still a non-input mode → the card keeps it.
    expect(focusedIds(ee("how", true))).toEqual(["ee-connect-card"]);
    // Not the owner → nothing at all, so the composer's flag stands alone.
    expect(focusedIds(ee("actions", false))).toEqual([]);
    expect(focusedIds(ee("input", false))).toEqual([]);
  });

  it("mcp-needs-key-card: the card owns it in actions mode, the key field in input mode", () => {
    expect(focusedIds(needsKey("actions", true))).toEqual(["mcp-needs-key-card"]);
    expect(focusedIds(needsKey("input", true))).toEqual(["mcp-needs-key-input"]);
    expect(focusedIds(needsKey("actions", false))).toEqual([]);
    expect(focusedIds(needsKey("input", false))).toEqual([]);
  });
});

describe("the model picker routes the flag to whichever sub-modal takes the keys", () => {
  // use-app-logic.tsx checks `oauthLogin` first, then `apiKeyPrompt`, then the
  // picker body — the published flag has to follow the same precedence.
  const picker = (extra: Record<string, unknown>) =>
    ModelPickerModal({
      t: THEME,
      width: 100,
      height: 40,
      configuredProviders: [],
      disabledProviders: [],
      providerChipIndex: 0,
      focused: true,
      ...extra,
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
    } as any);

  it("picker body alone", () => {
    expect(focusedIds(picker({}))).toEqual(["model-picker"]);
  });

  it("api-key sub-modal takes it from the body", () => {
    const tree = picker({ apiKeyPrompt: { provider: "openai", value: "", error: null } });
    expect(focusedIds(tree)).toEqual(["provider-key-input"]);
  });

  it("oauth sub-modal outranks both", () => {
    const tree = picker({
      apiKeyPrompt: { provider: "openai", value: "", error: null },
      oauthLogin: { provider: "openai", error: null },
    });
    expect(focusedIds(tree)).toEqual(["provider-oauth-login"]);
  });
});

describe("the resolver names exactly one owner for every surface in the union", () => {
  it("each surface alone owns the keyboard", () => {
    for (const surface of MODAL_SURFACE_PRIORITY) {
      const order = createModalOpenOrder();
      reconcileModalOpenOrder(order, [surface]);
      expect(resolveModalKeyboardOwner(order, [surface])).toBe(surface);
    }
  });

  it("with EVERY surface open at once, exactly one answers the guard", () => {
    const order = createModalOpenOrder();
    const open = [...MODAL_SURFACE_PRIORITY];
    reconcileModalOpenOrder(order, open);
    const owner = resolveModalKeyboardOwner(order, open);
    expect(open.filter((s) => modalOwnsKeyboard(owner, s))).toHaveLength(1);
  });

  it("for every ordered pair, the one opened LAST owns it — never both, never neither", () => {
    for (const first of MODAL_SURFACE_PRIORITY) {
      for (const second of MODAL_SURFACE_PRIORITY) {
        if (first === second) continue;
        const order = createModalOpenOrder();
        reconcileModalOpenOrder(order, [first]);
        const both = [first, second];
        reconcileModalOpenOrder(order, both);
        const owner = resolveModalKeyboardOwner(order, both);
        expect(owner, `${first} then ${second}`).toBe(second);
        expect(both.filter((s) => modalOwnsKeyboard(owner, s))).toHaveLength(1);
      }
    }
  });

  it("collectOpenModalSurfaces covers every id in the priority list", () => {
    // A surface present in the union + priority list but missing from the
    // collector would be un-openable: the resolver could never name it, so the
    // card would render `focused={false}` forever and publish zero owners.
    const allFlags = {
      planQuestions: true,
      paymentApproval: true,
      haltCard: true,
      initNewForm: true,
      pointToExistingForm: true,
      askcard: true,
      preflight: true,
      apiKeyModal: true,
      updateModal: true,
      mcpNeedsKeyCard: true,
      eeConnectCard: true,
      lspSetupCard: true,
      mcpModal: true,
      mcpEditor: true,
      scheduleModal: true,
      subagentsModal: true,
      subagentEditor: true,
      modelPicker: true,
      sessionPicker: true,
      walletPicker: true,
      sandboxPicker: true,
      connectModal: true,
      telegramTokenModal: true,
      telegramPairModal: true,
    };
    expect([...collectOpenModalSurfaces(allFlags)].sort()).toEqual([...MODAL_SURFACE_PRIORITY].sort());
  });
});

describe("the real registry reports exactly one focus owner for a picker on screen", () => {
  it("composer yields, the picker claims — one node, and query('focus') cannot be ambiguous", () => {
    const registry = createSemanticRegistry();
    // The composer suppresses its semantic mirror while a modal owns the
    // keyboard (prompt-box.tsx:231), so it registers WITHOUT the flag.
    registry.register({ id: "composer", role: "textbox" });
    const picker = findById(
      // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag
      ModelPickerModal({
        t: THEME,
        width: 100,
        height: 40,
        configuredProviders: [],
        disabledProviders: [],
        providerChipIndex: 0,
        focused: true,
      } as any),
      "model-picker",
    );
    registry.register({ id: "model-picker", role: "dialog", focus: true, isModal: true });
    expect(picker.props.focus).toBe(true);

    const snap = registry.snapshot();
    expect(snap.focus).toBe("model-picker");
    expect(snap.nodes.filter((n) => n.focus === true).map((n) => n.id)).toEqual(["model-picker"]);
  });
});
