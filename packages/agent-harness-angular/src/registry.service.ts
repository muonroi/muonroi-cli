import { Injectable } from "@angular/core";
import type { SemanticRegistry } from "@muonroi/agent-harness-core";
import { createSemanticRegistry } from "@muonroi/agent-harness-core";

/**
 * Application-scoped singleton that wraps the framework-agnostic
 * createSemanticRegistry() factory from core.
 *
 * Provided at root so every [muonroiSemantic] directive across the
 * entire component tree shares the same node store.
 */
@Injectable({ providedIn: "root" })
export class SemanticRegistryService {
  private readonly _registry: SemanticRegistry = createSemanticRegistry();

  /** Register a node. Returns an unregister function. */
  readonly register = this._registry.register.bind(this._registry);

  /** Patch a registered node in-place. */
  readonly update = this._registry.update.bind(this._registry);

  /** Build a point-in-time snapshot of the tree. */
  readonly snapshot = this._registry.snapshot.bind(this._registry);

  /** Remove all registered nodes. */
  readonly clear = this._registry.clear.bind(this._registry);
}
