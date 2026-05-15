import { Injectable } from "@angular/core";
import { createSemanticRegistry, type Registry } from "./registry";

/**
 * Application-scoped singleton that wraps the plain createSemanticRegistry()
 * factory. Provided at root so every [muonroiSemantic] directive across the
 * component tree shares the same node store.
 */
@Injectable({ providedIn: "root" })
export class SemanticRegistry {
  private readonly _registry: Registry = createSemanticRegistry();

  register = this._registry.register.bind(this._registry);
  snapshot = this._registry.snapshot.bind(this._registry);
  size = this._registry.size.bind(this._registry);
  get = this._registry.get.bind(this._registry);
}
