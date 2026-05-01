export { getCachedAuthToken, getEmbeddingModelVersion, loadEEAuthToken, refreshAuthToken } from "./auth.js";
export { type CreateEEClientOpts, createEEClient } from "./client.js";
export { health } from "./health.js";
export {
  bootstrapEEClient,
  getDefaultEEClient,
  intercept,
  interceptWithDefaults,
  setDefaultEEClient,
} from "./intercept.js";
export { posttool } from "./posttool.js";
export { emitMatches, getRenderSink, renderInterceptWarning, setRenderSink } from "./render.js";
export { buildScope, resetScopeCache, scopeLabel } from "./scope.js";
export type {
  Classification,
  EEClient,
  FeedbackPayload,
  InterceptMatch,
  InterceptRequest,
  InterceptResponse,
  PostToolPayload,
  Scope,
} from "./types.js";
