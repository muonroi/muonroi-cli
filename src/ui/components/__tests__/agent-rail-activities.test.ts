import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentRailActivities } from "../agent-rail-activities.js";
import { dark } from "../../theme.js";
import type { AgentActivity } from "../../utils/agent-activities.js";

const activity = (id: string, kind: AgentActivity["kind"], status: AgentActivity["status"]): AgentActivity => ({
  id,
  kind,
  status,
  agent: kind === "background" ? "" : "general",
  label: id,
  detail: "output",
});

function regions(activities: AgentActivity[]) {
  const groups: { name: string; props: Record<string, unknown> }[] = [];
  const visit = (node: unknown) => {
    if (!isValidElement(node)) return;
    const element = node as ReactElement<{ name: string; props: Record<string, unknown>; children?: React.ReactNode }>;
    if (typeof element.type === "function") {
      if (element.type.name === "Region") {
        groups.push({ name: element.props.name, props: element.props.props });
        return;
      }
      visit((element.type as (props: unknown) => unknown)(element.props));
    } else {
      Children.forEach(element.props.children, visit);
    }
  };
  visit(
    AgentRailActivities({ activities, selected: null, onSelect: vi.fn(), onOpenJobs: vi.fn(), width: 36, t: dark }),
  );
  return groups;
}

describe("rail activity groups", () => {
  it("counts a detached council as a running agent, independently of completed shells", () => {
    const council = { ...activity("council", "council", "running"), agent: "council" };
    expect(regions([council, activity("shell", "background", "done")])).toEqual([
      { name: "Agents", props: expect.objectContaining({ running: 1, count: 1, done: 0 }) },
      { name: "Shells", props: expect.objectContaining({ running: 0, count: 1, done: 1 }) },
    ]);
  });
  it("shows shell-only work in Shells without an Agents group", () => {
    expect(regions([activity("shell", "background", "running")])).toEqual([
      { name: "Shells", props: expect.objectContaining({ running: 1, count: 1, done: 0, failed: 0 }) },
    ]);
  });

  it("keeps native and research agents together with counts independent of shell jobs", () => {
    expect(
      regions([
        activity("worker", "subagent", "running"),
        activity("research", "delegate", "running"),
        activity("agent-done", "subagent", "done"),
        activity("shell", "background", "running"),
        activity("shell-failed", "background", "failed"),
      ]),
    ).toEqual([
      { name: "Agents", props: expect.objectContaining({ running: 2, count: 3, done: 1, failed: 0 }) },
      { name: "Shells", props: expect.objectContaining({ running: 1, count: 2, done: 0, failed: 1 }) },
    ]);
  });

  it("omits both groups for an empty session", () => {
    expect(regions([])).toEqual([]);
  });
});
