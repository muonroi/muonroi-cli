import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { CouncilMessageBubble } from "../../ui/components/council-message-bubble.js";
import type { CouncilMessage } from "../../types/index.js";

function makeDebateMsg(overrides: Partial<CouncilMessage> = {}): CouncilMessage {
  return {
    kind: "debate",
    speaker: { role: "Frontend Engineer", model: "gpt-4o" },
    partner: { role: "Backend Engineer" },
    round: 1,
    text: "I think we should use React Server Components here.",
    ...overrides,
  };
}

describe("<CouncilMessageBubble> debate variant", () => {
  it("renders speaker role in top border", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("Frontend Engineer");
  });

  it("renders model name in top border", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("gpt-4o");
  });

  it("right side renders with indent", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="right"
        resolveStyle={() => ({ color: "magenta", sigil: "◆" })}
      />,
    );
    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";
    expect(firstLine.startsWith(" ")).toBe(true);
  });

  it("shows 'recovered on retry' badge when attempts > 1", () => {
    const msg = makeDebateMsg({ attempts: 2 });
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    expect(lastFrame()).toContain("recovered on retry");
  });

  it("renders reply-quote header when partnerLastText is provided", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={100}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
        partnerLastText="we should probably check the boundary before committing"
        partnerRole="Backend Engineer"
      />,
    );
    expect(lastFrame()).toContain("↪");
    expect(lastFrame()).toContain("Backend Engineer");
  });

  it("fallback to flat format when terminal < 70 cols", () => {
    const msg = makeDebateMsg();
    const { lastFrame } = render(
      <CouncilMessageBubble
        msg={msg}
        terminalCols={60}
        side="left"
        resolveStyle={() => ({ color: "cyan", sigil: "●" })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("┌");
    expect(frame).toContain("Frontend Engineer");
  });
});
