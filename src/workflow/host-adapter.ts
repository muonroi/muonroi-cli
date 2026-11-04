import { allLoopHostPoints, loadLoopHostContract } from "./flow-runtime.js";
import { getFlowLoopHost, type LoopHostContext, type LoopPointResult } from "./loop-host.js";

export type { LoopHostContext, LoopPointResult };

/** @deprecated Use FlowLoopHost.firePoint — thin facade for backwards compatibility. */
class FlowHostAdapter {
  private host = getFlowLoopHost();

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

export function createDefaultHostAdapter(): FlowHostAdapter {
  return new FlowHostAdapter();
}

export { FlowLoopHost, getFlowLoopHost } from "./loop-host.js";
