import { loadProjectSettings, loadUserSettings, type ProjectSettings, type RoutingMode } from "../utils/settings.js";

export function isRoutingMode(value: unknown): value is RoutingMode {
  return value === "fixed" || value === "auto" || value === "suggest";
}

/** Main-only policy: auxiliary/council routing retains its own authority. */
export function resolveRoutingPolicy(
  project: Pick<ProjectSettings, "model" | "routingMode">,
  userMode?: RoutingMode,
): {
  mode: RoutingMode;
  source: "project" | "project-model-pin" | "user" | "default";
} {
  if (isRoutingMode(project.routingMode)) return { mode: project.routingMode, source: "project" };
  if (typeof project.model === "string" && project.model.trim()) return { mode: "fixed", source: "project-model-pin" };
  if (isRoutingMode(userMode)) return { mode: userMode, source: "user" };
  return { mode: "auto", source: "default" };
}

export function getRoutingPolicy(cwd: string) {
  return resolveRoutingPolicy(loadProjectSettings(cwd), loadUserSettings().routingMode);
}
