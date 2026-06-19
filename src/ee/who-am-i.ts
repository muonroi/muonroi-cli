// src/ee/who-am-i.ts
//
// "Who Am I" v4.0 profile provider for the PIL. The personality/work-style profile
// is DEVICE-LOCAL (~/.experience/profile.yaml) and never leaves the machine, so it
// cannot come from the EE HTTP API — we read it on-device, reusing the EE install's
// parser (profile-model.js loadProfile) + privacy gate (config.js getPrivacyLevel)
// via createRequire (the same in-process pattern as src/ee/bridge.ts).
//
// Privacy is enforced HERE at read time via a positive per-dimension-NAME allowlist
// (defense in depth): the EE writer keeps committed values regardless of privacyLevel,
// so a standard→minimal downgrade leaves stale Tang-2 values physically in the file —
// trusting the file would leak opted-out data. Mirrors experience-engine
// src/profile-render.js. Fail-open: any error / missing EE install returns null and the
// PIL keeps its own per-turn defaults.

import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { OutputStyle } from "../pil/types.js";
import { classifyEeError, logEeFailure } from "../utils/ee-logger.js";

export type PrivacyLevel = "minimal" | "standard" | "full";

export type WhoAmIDimName =
  | "communication.question_style"
  | "communication.feedback_style"
  | "communication.brevity"
  | "personality.conflict_style"
  | "personality.risk_tolerance"
  | "personality.decision_speed"
  | "work_patterns.energy"
  | "work_patterns.multitasking"
  | "work_patterns.session_length";

export interface WhoAmIDim {
  value: string;
  confidence: number;
  samples: number;
}

export interface WhoAmIProfile {
  level: PrivacyLevel;
  dims: Partial<Record<WhoAmIDimName, WhoAmIDim>>;
}

// Tang 1 (work patterns + activity-derived decision_speed — namespaced personality.*
// but its SOURCE is activity, so it belongs to the minimal tier; allowlist by NAME).
const TIER_MINIMAL: WhoAmIDimName[] = [
  "work_patterns.energy",
  "work_patterns.multitasking",
  "work_patterns.session_length",
  "personality.decision_speed",
];
// Tang 2 (decision + communication style) added at standard. `full` == standard today
// (no Tang-3 emotional dims exist); the allowlist guarantees emotional.* can never leak.
const TIER_STANDARD: WhoAmIDimName[] = [
  ...TIER_MINIMAL,
  "communication.question_style",
  "communication.feedback_style",
  "communication.brevity",
  "personality.conflict_style",
  "personality.risk_tolerance",
];
const ALLOWLIST: Record<PrivacyLevel, WhoAmIDimName[]> = {
  minimal: TIER_MINIMAL,
  standard: TIER_STANDARD,
  full: TIER_STANDARD,
};
const WORK_DIMS = new Set<WhoAmIDimName>(TIER_MINIMAL);
// Coarse work dims commit over 2-3-way splits (confidence ~0.45-0.6); the lower floor
// keeps the minimal tier usable. Mirrors experience-engine src/profile-render.js.
const WORK_MIN_CONFIDENCE = 0.45;
const MIN_CONFIDENCE = 0.6;

interface RawDim {
  value: string | null;
  confidence?: number;
  sampleCount?: number;
  samples?: number;
}
interface RawProfile {
  dimensions?: Record<string, RawDim>;
}

/**
 * PURE: project a raw EE profile to the privacy-gated dims for `level`, applying the
 * positive name allowlist + value!=null commit gate + per-tier confidence floor.
 */
export function selectWhoAmIDims(raw: RawProfile | null | undefined, level: PrivacyLevel): WhoAmIProfile["dims"] {
  const out: WhoAmIProfile["dims"] = {};
  const allow = ALLOWLIST[level];
  if (!allow || !raw?.dimensions) return out;
  for (const name of allow) {
    const d = raw.dimensions[name];
    if (!d || d.value == null) continue;
    const confidence = Number(d.confidence) || 0;
    const floor = WORK_DIMS.has(name) ? WORK_MIN_CONFIDENCE : MIN_CONFIDENCE;
    if (confidence < floor) continue;
    out[name] = {
      value: String(d.value),
      confidence,
      samples: Math.round(Number(d.sampleCount ?? d.samples) || 0),
    };
  }
  return out;
}

/**
 * PURE: derive an output-style baseline from the profile. brevity is the primary
 * signal; decision_speed is a weaker fallback. Returns null when no usable signal
 * exists so the caller keeps its own per-turn default.
 */
export function outputStyleFromProfile(profile: WhoAmIProfile | null): OutputStyle | null {
  if (!profile) return null;
  const brevity = profile.dims["communication.brevity"]?.value;
  if (brevity === "concise") return "concise";
  if (brevity === "verbose") return "detailed";
  if (brevity === "moderate") return "balanced";
  const speed = profile.dims["personality.decision_speed"]?.value;
  if (speed === "fast-intuitive") return "concise";
  if (speed === "deliberate") return "detailed";
  return null;
}

// ── IO boundary + per-process cache ──────────────────────────────────────────────

interface EEConfigModule {
  getPrivacyLevel?: () => string;
  getProfilePath?: () => string;
}
interface EEProfileModelModule {
  loadProfile?: (p: string) => RawProfile;
}

let _cache: WhoAmIProfile | null | undefined;

/**
 * Load + cache the privacy-gated profile for this process. The profile changes
 * slowly (rebuilt by the EE Stop hook), so one read per process is enough.
 * Returns null when EE is not installed, privacy is off, or nothing is committed.
 */
export function getWhoAmIProfile(): WhoAmIProfile | null {
  if (_cache !== undefined) return _cache;
  _cache = loadWhoAmIProfile();
  return _cache;
}

/** Clear the cache — test-only / after a known profile change. */
export function resetWhoAmICache(): void {
  _cache = undefined;
}

function loadWhoAmIProfile(): WhoAmIProfile | null {
  try {
    const req = createRequire(import.meta.url);
    const srcDir = path.join(os.homedir(), ".experience", "src");
    const config = req(path.join(srcDir, "config.js")) as EEConfigModule;
    const model = req(path.join(srcDir, "profile-model.js")) as EEProfileModelModule;
    if (typeof config.getPrivacyLevel !== "function" || typeof config.getProfilePath !== "function") return null;
    if (typeof model.loadProfile !== "function") return null;

    const level = String(config.getPrivacyLevel() ?? "off");
    if (level !== "minimal" && level !== "standard" && level !== "full") return null;

    const raw = model.loadProfile(config.getProfilePath());
    const dims = selectWhoAmIDims(raw, level);
    if (Object.keys(dims).length === 0) return null;
    return { level, dims };
  } catch (err) {
    // EE not installed (module absent) is an expected feature-off condition, not a
    // failure — stay quiet. Any other error (corrupt profile, throwing module) is a
    // real fault: log it (No-Silent-Catch) and degrade.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      logEeFailure("who-am-i.load", classifyEeError(err), err);
    }
    return null;
  }
}
