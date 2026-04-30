export { createEEClient, type CreateEEClientOpts } from "./client.js";
export { intercept, interceptWithDefaults, setDefaultEEClient, getDefaultEEClient, bootstrapEEClient } from "./intercept.js";
export { posttool } from "./posttool.js";
export { health } from "./health.js";
export { renderInterceptWarning, setRenderSink, getRenderSink, emitMatches } from "./render.js";
export { buildScope, scopeLabel, resetScopeCache } from "./scope.js";
export { loadEEAuthToken, refreshAuthToken, getCachedAuthToken, getEmbeddingModelVersion } from "./auth.js";
export type {
  EEClient,
  InterceptRequest,
  InterceptResponse,
  InterceptMatch,
  PostToolPayload,
  Scope,
  Classification,
  FeedbackPayload,
} from "./types.js";
