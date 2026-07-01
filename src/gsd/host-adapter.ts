import { allLoopHostPoints, loadLoopHostContract } from "./gsd-runtime.js";
import { getGsdLoopHost, type LoopHostContext, type LoopPointResult } from "./loop-host.js";

export type { LoopHostContext, LoopPointResult };

/** @deprecated Use GsdLoopHost.firePoint — thin facade for backwards compatibility. */
export class GsdHostAdapter {
  private host = getGsdLoopHost();

  async dispatch(point: string, ctx: LoopHostContext): Promise<boolean> {
    if (point === "plan-review:post") {
      await this.host.firePoint(point, ctx);
      return true;
    }
    const contract = this.host.canonicalPoints();
    if (!contract.includes(point) && point !== "plan-review:post") {
      return false;
    }
    await this.host.firePoint(point, ctx);
    return true;
  }

  registeredPoints(): string[] {
    return [...this.host.canonicalPoints(), "plan-review:post"];
  }

  contractPoints(): string[] {
    return loadLoopHostContract().flatMap((e) => e.points);
  }
}

export function createDefaultHostAdapter(): GsdHostAdapter {
  return new GsdHostAdapter();
}

export { GsdLoopHost, getGsdLoopHost } from "./loop-host.js";
