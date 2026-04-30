export { createEEClient, type CreateEEClientOpts } from "./client.js";
export { intercept, interceptWithDefaults, setDefaultEEClient, getDefaultEEClient } from "./intercept.js";
export { posttool } from "./posttool.js";
export { health } from "./health.js";
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
