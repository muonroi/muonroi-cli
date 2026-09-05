/**
 * The other half of the modal-collision fix: ownership must be OBSERVABLE.
 *
 * Measured 2026-09-05: with an escalation askcard and the init-new form both
 * open, `tui.query "focus"` returned null. That was structural, not a glitch —
 * `blockPrompt` (use-app-logic.tsx) goes true whenever `activeHaltCard`,
 * `initNewForm` or `pointToExistingForm` is set, `composerFocused`
 * (prompt-box.tsx) is `!blockPrompt && ...`, so the composer dropped its focus
 * flag, and NO modal card ever set one. Nothing in the tree was focused.
 *
 * These tests assert the cards now mirror `focused` onto the Semantic node, and
 * that the real SemanticRegistry therefore reports exactly one focus owner when
 * two modals are on screen.
 *
 * Strategy mirrors src/ui/primitives/__tests__/semantic-primitives.test.tsx:
 * these are pure function components, so we invoke them directly and read the
 * returned <Semantic> element's props — no render engine needed.
 */

import { createSemanticRegistry } from "@muonroi/agent-harness-core/registry";
import { describe, expect, it } from "vitest";
import type { HaltChunk } from "../../product-loop/types.js";
import type { CouncilQuestionData } from "../../types/index.js";
import { CouncilQuestionCard, initialCardState } from "../components/council-question-card.js";
import { HaltRecoveryCard } from "../components/halt-recovery-card.js";
import { initialInitNewFormState, InitNewFormCard } from "../components/init-new-form-card.js";
import { initialPointToExistingFormState, PointToExistingFormCard } from "../components/point-to-existing-form-card.js";
import { PromptBox } from "../components/prompt-box.js";
import type { Theme } from "../theme.js";

// Colors are only read to build style props we never render, so an empty theme
// is enough to exercise the semantic wrapper.
const THEME = {} as Theme;

// biome-ignore lint/suspicious/noExplicitAny: reaching into React element internals for a pure-function assertion
function rootSemanticProps(element: any): Record<string, unknown> {
  return element.props as Record<string, unknown>;
}

const QUESTION = {
  questionId: "escalate-1",
  question: "The debate reached its progress limit with 1 criterion still unmet",
  phase: "post-debate",
  defaultIndex: 0,
  options: [
    { label: "Extend 2 more rounds", value: "escalate_extend", kind: "choice" },
    { label: "Accept as-is", value: "escalate_accept", kind: "choice" },
  ],
} as unknown as CouncilQuestionData;

const HALT: HaltChunk = {
  type: "halt",
  reason: "no_recipe",
  detail: "greenfield repo, no verification recipe",
  recovery_options: [{ id: "init_new", label: "Init new project" }] as HaltChunk["recovery_options"],
};

describe("modal cards publish keyboard ownership as focus", () => {
  it("the askcard mirrors focused onto its Semantic node", () => {
    const on = rootSemanticProps(
      CouncilQuestionCard({ question: QUESTION, theme: THEME, state: initialCardState(QUESTION), focused: true }),
    );
    expect(on.id).toBe("askcard");
    expect(on.role).toBe("dialog");
    expect(on.focus).toBe(true);
    expect(on.isModal).toBe(true);

    const off = rootSemanticProps(
      CouncilQuestionCard({ question: QUESTION, theme: THEME, state: initialCardState(QUESTION) }),
    );
    expect(off.focus).toBeUndefined();
  });

  it("the pre-flight instance takes its own node id so two cards cannot collide on one registry key", () => {
    const props = rootSemanticProps(
      CouncilQuestionCard({
        question: QUESTION,
        theme: THEME,
        state: initialCardState(QUESTION),
        focused: true,
        semanticId: "askcard-preflight",
      }),
    );
    expect(props.id).toBe("askcard-preflight");
    expect(props.focus).toBe(true);
  });

  it("the init-new form mirrors focused and declares itself modal", () => {
    const on = rootSemanticProps(
      InitNewFormCard({ state: initialInitNewFormState(""), terminalCols: 100, theme: THEME, focused: true }),
    );
    expect(on.id).toBe("init-new-form");
    expect(on.focus).toBe(true);
    // It sets blockPrompt, so it IS modal — it just never said so before.
    expect(on.isModal).toBe(true);

    const off = rootSemanticProps(
      InitNewFormCard({ state: initialInitNewFormState(""), terminalCols: 100, theme: THEME }),
    );
    expect(off.focus).toBeUndefined();
  });

  it("the point-to-existing form mirrors focused and declares itself modal", () => {
    const on = rootSemanticProps(
      PointToExistingFormCard({
        state: initialPointToExistingFormState(),
        terminalCols: 100,
        theme: THEME,
        focused: true,
      }),
    );
    expect(on.id).toBe("point-to-existing-form");
    expect(on.focus).toBe(true);
    expect(on.isModal).toBe(true);
  });

  it("the halt recovery card mirrors focused", () => {
    const on = rootSemanticProps(
      HaltRecoveryCard({ halt: HALT, selectedIndex: 0, terminalCols: 100, theme: THEME, focused: true }),
    );
    expect(on.id).toBe("ideal-halt-card");
    expect(on.focus).toBe(true);

    const off = rootSemanticProps(HaltRecoveryCard({ halt: HALT, selectedIndex: 0, terminalCols: 100, theme: THEME }));
    expect(off.focus).toBeUndefined();
  });
});

describe("two modals on screen: the real registry reports exactly one focus owner", () => {
  it("frame.focus names the owning card, and only one node carries the flag", () => {
    const registry = createSemanticRegistry();

    // Same shape the Semantic wrapper registers: the askcard opened first, the
    // init-new form was raised on top and owns the keyboard.
    const askcard = rootSemanticProps(
      CouncilQuestionCard({ question: QUESTION, theme: THEME, state: initialCardState(QUESTION), focused: false }),
    );
    const initNew = rootSemanticProps(
      InitNewFormCard({ state: initialInitNewFormState(""), terminalCols: 100, theme: THEME, focused: true }),
    );

    for (const p of [askcard, initNew]) {
      registry.register({
        id: p.id as string,
        role: p.role as "dialog",
        name: p.name as string | undefined,
        ...(p.focus === true ? { focus: true as const } : {}),
        ...(p.isModal === true ? { isModal: true as const } : {}),
      });
    }

    const snap = registry.snapshot();
    expect(snap.focus).toBe("init-new-form");
    expect(snap.nodes.filter((n) => n.focus === true).map((n) => n.id)).toEqual(["init-new-form"]);
    // Both are modal, so a driver can still see the whole stack.
    expect(snap.modals).toEqual(["askcard", "init-new-form"]);
  });
});

describe("the composer yields the published focus flag to the modal that owns the keyboard", () => {
  /** Depth-first search for the React element carrying `props.id === id`. */
  // biome-ignore lint/suspicious/noExplicitAny: walking React element internals for a pure-function assertion
  function findById(node: any, id: string): any {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findById(child, id);
        if (hit) return hit;
      }
      return null;
    }
    if (node.props?.id === id) return node;
    return findById(node.props?.children, id);
  }

  function composerNode(modalOwnsKeyboard: boolean) {
    // biome-ignore lint/suspicious/noExplicitAny: minimal prop bag; only the focus path is exercised
    const props: any = {
      t: THEME,
      inputRef: { current: null },
      isProcessing: false,
      showModelPicker: false,
      showSandboxPicker: false,
      showWalletPicker: false,
      showSlashMenu: false,
      showPlanQuestions: false,
      showApiKeyModal: false,
      blockPrompt: false,
      modalOwnsKeyboard,
      onSubmit: () => {},
      onPaste: () => {},
      pasteBlocks: [],
      modeInfo: { label: "chat" },
      model: "mock",
      modelInfo: {},
    };
    return findById(PromptBox(props), "composer");
  }

  it("publishes composer focus when no modal owns the keyboard", () => {
    expect(composerNode(false)?.props.focused).toBe(true);
  });

  it("withholds composer focus while a modal owns the keyboard", () => {
    // An askcard does NOT set blockPrompt, so the textarea keeps OpenTUI focus
    // while handleKey routes the key to the card. Publishing focus on both would
    // make driver.query("focus") match two nodes and throw "query: ambiguous" —
    // a worse dead end than the null this whole fix exists to remove.
    expect(composerNode(true)?.props.focused).toBe(false);
  });
});
