export { getCachedAuthToken, getEmbeddingModelVersion, loadEEAuthToken, refreshAuthToken } from "./auth.js";
export type { EEPoint, EERouteResult } from "./bridge.js";
export {
  classifyViaBrain,
  getEmbeddingRaw,
  resetBridge,
  routeFeedback,
  routeModel,
  searchByText,
  searchCollection,
} from "./bridge.js";
export { type CreateEEClientOpts, createEEClient } from "./client.js";
export { type EEHealthResult, health, healthDetailed } from "./health.js";
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
