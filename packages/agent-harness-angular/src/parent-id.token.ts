import { InjectionToken } from "@angular/core";

/**
 * Token injected into child directives to resolve the nearest enclosing
 * [muonroiSemantic] parent id via the element-injector chain.
 *
 * Each directive re-provides this token on its own element injector via
 * useFactory so that the chain resolves to the immediately-enclosing
 * ancestor directive, NOT the component-level injector.
 *
 * Spike finding (HIGH-4 validated GREEN):
 *   inject(SEMANTIC_PARENT_ID, { optional: true, skipSelf: true })
 *   skips this element's own injector and walks UP the element-injector
 *   hierarchy, finding the nearest ancestor [muonroiSemantic] directive.
 */
export const SEMANTIC_PARENT_ID = new InjectionToken<string | null>("SEMANTIC_PARENT_ID");
