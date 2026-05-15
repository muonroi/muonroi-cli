/**
 * @muonroi/agent-harness-angular public API.
 *
 * Angular adapter for the muonroi agent harness.
 * Provides structural annotation via the [muonroiSemantic] directive,
 * tree snapshot emission via SemanticSnapshotService, and re-exports the
 * core WebSocket transport for convenience.
 */

export { createWebSocketTransport } from "@muonroi/agent-harness-core";
export { SEMANTIC_PARENT_ID } from "./parent-id.token.js";
export { SemanticRegistryService } from "./registry.service.js";
export { SemanticDirective } from "./semantic.directive.js";
export { SemanticSnapshotService } from "./snapshot.service.js";
