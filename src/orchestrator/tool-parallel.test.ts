import { describe, expect, it } from "vitest";
import { SimpleMutex } from "./tool-engine.js";

describe("SimpleMutex", () => {
  it("serializes execution of async functions in FIFO order", async () => {
    const mutex = new SimpleMutex();
    const order: number[] = [];

    const task1 = () =>
      mutex.run(async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
        return "task1";
      });

    const task2 = () =>
      mutex.run(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
        return "task2";
      });

    const task3 = () =>
      mutex.run(async () => {
        order.push(3);
        return "task3";
      });

    // Start all concurrently
    const results = await Promise.all([task1(), task2(), task3()]);

    expect(results).toEqual(["task1", "task2", "task3"]);
    // Even though task2 and task3 were shorter, they must wait for task1 due to mutex serialization.
    expect(order).toEqual([1, 2, 3]);
  });

  it("handles errors without blocking the queue indefinitely", async () => {
    const mutex = new SimpleMutex();
    const order: string[] = [];

    const task1 = () =>
      mutex.run(async () => {
        throw new Error("task1 error");
      });

    const task2 = () =>
      mutex.run(async () => {
        order.push("task2");
        return "task2";
      });

    await expect(task1()).rejects.toThrow("task1 error");
    const res = await task2();
    expect(res).toBe("task2");
    expect(order).toEqual(["task2"]);
  });
});
