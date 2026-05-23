import { describe, expect, it } from "vitest";
import { snapshotFromTodoWriteArgs } from "./todo-write-snapshot.js";

function args(todos: unknown): string {
  return JSON.stringify({ todos });
}

describe("snapshotFromTodoWriteArgs", () => {
  it("returns null for unparseable JSON", () => {
    expect(snapshotFromTodoWriteArgs("not-json")).toBeNull();
  });

  it("returns null when todos is missing or empty", () => {
    expect(snapshotFromTodoWriteArgs("{}")).toBeNull();
    expect(snapshotFromTodoWriteArgs(args([]))).toBeNull();
  });

  it("parses a well-formed list and computes counts", () => {
    const snap = snapshotFromTodoWriteArgs(
      args([
        { id: "1", subject: "Write tests", status: "completed" },
        { id: "2", subject: "Wire UI", status: "in_progress", activeForm: "Wiring UI" },
        { id: "3", subject: "Ship", status: "pending" },
      ]),
    );
    expect(snap).not.toBeNull();
    expect(snap!.items).toHaveLength(3);
    expect(snap!.items[1]!.activeForm).toBe("Wiring UI");
    expect(snap!.counts).toMatchObject({ completed: 1, inProgress: 1, pending: 1, total: 3 });
  });

  it("coerces unknown status to 'pending'", () => {
    const snap = snapshotFromTodoWriteArgs(args([{ id: "1", subject: "x", status: "weird" }]));
    expect(snap!.items[0]!.status).toBe("pending");
  });

  it("drops items missing a subject (preserves the rest)", () => {
    const snap = snapshotFromTodoWriteArgs(
      args([
        { id: "1", subject: "Keep me", status: "pending" },
        { id: "2", status: "pending" }, // no subject → dropped
        { id: "3", subject: "   ", status: "pending" }, // blank subject → dropped
      ]),
    );
    expect(snap!.items).toHaveLength(1);
    expect(snap!.items[0]!.subject).toBe("Keep me");
  });

  it("assigns synthetic ids when missing", () => {
    const snap = snapshotFromTodoWriteArgs(args([{ subject: "no id here", status: "pending" }]));
    expect(snap!.items[0]!.id).toBe("t-0");
  });
});
