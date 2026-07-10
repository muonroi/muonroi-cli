import { Semantic } from "@muonroi/agent-harness-opentui";
import type { SessionChainNode } from "../../storage/transcript.js";
import { dark } from "../theme.js";

/** Short kind badge for the rail — keeps rows narrow in a ~34-col panel. */
function kindBadge(kind: SessionChainNode["kind"]): string {
  switch (kind) {
    case "subagent":
      return "sub";
    case "rotation":
      return "rot";
    case "conversation":
      return "conv";
    default:
      return "·";
  }
}

/** Trim a model id to its last path segment so "deepseek/deepseek-v4-flash"
 *  reads as "deepseek-v4-flash" in the narrow rail. */
function shortModel(model: string | null): string {
  if (!model) return "—";
  const seg = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return seg.length > 16 ? `${seg.slice(0, 15)}…` : seg;
}

/**
 * Rail "Sessions" block: the session tree this TUI hosts — the root
 * conversation plus every rotation / sub-agent descendant. The children's
 * message content is already merged into the transcript on resume; this makes
 * the multi-session structure VISIBLE (which session produced what, how many
 * messages, whether it is the current one) instead of a flat anonymous timeline.
 *
 * Renders nothing extra when the tree is a single conversation (no sub-sessions)
 * — keeps a lean rail for the common single-session case.
 */
export function SessionTreeCard({ nodes }: { nodes: SessionChainNode[] }) {
  if (nodes.length <= 1) return null;

  return (
    <Semantic
      id="session-tree"
      role="listbox"
      name="Sessions"
      props={{ count: nodes.length, ids: nodes.map((n) => n.id.slice(0, 8)).join(",") }}
    >
      <box flexDirection="column" flexShrink={0} paddingTop={1}>
        <text fg={dark.textMuted} attributes={1}>
          {`Sessions (${nodes.length})`}
        </text>
        {nodes.map((n) => {
          const indent = "  ".repeat(Math.min(n.depth, 3));
          const marker = n.isCurrent ? "●" : n.depth > 0 ? "↳" : "○";
          const badge = kindBadge(n.kind);
          const done = n.status && n.status !== "active";
          return (
            <Semantic
              key={n.id}
              id={`session-node-${n.id}`}
              role="listitem"
              name={`${badge} ${n.id.slice(0, 8)}`}
              value={`${n.messageCount} msg`}
              selected={n.isCurrent ? true : undefined}
              props={{ kind: n.kind ?? "", status: n.status ?? "", messageCount: n.messageCount, depth: n.depth }}
            >
              <box flexDirection="column">
                <text>
                  <span style={{ fg: n.isCurrent ? dark.selected : dark.textMuted }}>{`${indent}${marker} `}</span>
                  <span style={{ fg: n.isCurrent ? dark.selected : dark.text }}>{`${badge} `}</span>
                  <span style={{ fg: dark.textMuted }}>{`${n.id.slice(0, 8)}  ${shortModel(n.model)}  `}</span>
                  <span style={{ fg: dark.text }}>{`${n.messageCount} msg`}</span>
                  {done ? <span style={{ fg: dark.textDim }}>{`  ${n.status}`}</span> : null}
                </text>
              </box>
            </Semantic>
          );
        })}
      </box>
    </Semantic>
  );
}
