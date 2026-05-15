import { InjectionToken } from "@angular/core";

/**
 * Token injected into child directives to resolve the nearest enclosing
 * [muonroiSemantic] parent id via element-injector chain.
 * Re-provided by each directive on its own element injector so the chain
 * resolves to the immediately enclosing sibling directive, NOT the
 * component-level injector.
 */
export const SEMANTIC_PARENT_ID = new InjectionToken<string | null>("SEMANTIC_PARENT_ID");
