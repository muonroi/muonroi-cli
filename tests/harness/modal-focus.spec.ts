/**
 * modal-focus.spec.ts
 *
 * Goal: open a modal (e.g. /council triggers a picker), press Esc, confirm
 * focus returns to the composer textbox.
 *
 * Investigation result:
 * - The TUI /council command does NOT open a picker modal. It directly runs
 *   a council round via agent.runCouncilRound(topic) (see src/ui/slash/council.ts
 *   and app.tsx ~line 3072).
 * - app.tsx handles Esc for several modals (MCP, agents, sandbox, model-picker,
 *   slash-menu, etc.) but none of these modals register <Semantic> nodes, so
 *   no role=dialog or role=textbox nodes appear in LiveFrame.nodes.
 * - The app uses <SemanticProvider> at the root but has zero <Semantic> components
 *   in src/ui/app.tsx or any ui/*.tsx — the registry never receives node
 *   registrations, so driver.query() always returns null.
 * - Without <Semantic role="dialog"> wrapping an actual modal and
 *   <Semantic role="textbox" focus> wired to the composer, this test cannot
 *   make meaningful assertions.
 *
 * What would be needed to enable this test:
 *   1. Add <Semantic id="composer" role="textbox" focus={composerFocused}> to
 *      the composer box in app.tsx.
 *   2. Add <Semantic id="some-modal" role="dialog" name="..." isModal> to an
 *      existing dismissible modal (e.g. model picker or MCP browser).
 *   3. After Esc, assert the frame shows focus=composer.
 */

import { describe, it } from "vitest";

describe("modal focus E2E", () => {
  it.todo(
    "TUI has no <Semantic> nodes wired: app.tsx uses SemanticProvider but no component registers role=dialog or role=textbox nodes, so LiveFrame.nodes is always empty and driver.query() cannot observe focus state",
  );

  it.todo(
    "/council does not open a modal picker: it calls agent.runCouncilRound() directly; there is no dismissible dialog to press Esc on in the harness",
  );
});
