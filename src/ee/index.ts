export { createEEClient, type CreateEEClientOpts } from "./client.js";
export { intercept, setDefaultEEClient, getDefaultEEClient } from "./intercept.js";
export { posttool } from "./posttool.js";
export { health } from "./health.js";
export type {
  EEClient,
  InterceptRequest,
  InterceptResponse,
  PostToolPayload,
} from "./types.js";
